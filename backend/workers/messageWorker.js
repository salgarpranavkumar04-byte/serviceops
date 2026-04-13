'use strict';

/**
 * workers/messageWorker.js — Incoming WhatsApp message queue consumer (v4)
 *
 * Pulls jobs from incoming_messages_queue and invokes routeMessage().
 * By separating the webhook receiver (which just enqueues + returns 200)
 * from this worker, the webhook is always fast and Meta's timeout is never hit.
 *
 * Features:
 *   • Idempotent: BullMQ jobId = WhatsApp message_id → no double-processing
 *   • Concurrency: configurable via MESSAGE_WORKER_CONCURRENCY (default 3)
 *   • Failed jobs routed to incoming_messages_dlq after all retries
 *
 * Run as a separate process:
 *   node workers/messageWorker.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Worker }    = require('bullmq');
const { createBullMQConnection, closeRedis } = require('../queues/redisClient');
const { QUEUE_NAMES, createDLQ, safeEnqueue } = require('../queues/queue');
const { routeMessage } = require('../services/messageRouter');
const { closePool }    = require('../db/db');

/* ─── Structured logger ───────────────────────────────────────────────────── */

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[messageWorker]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[messageWorker][error]', msg, ...meta }));
}

/* ─── Worker ──────────────────────────────────────────────────────────────── */

const CONCURRENCY = parseInt(process.env.MESSAGE_WORKER_CONCURRENCY || '3', 10);

let _dlq    = null;
let _worker = null;

function getDLQ() {
  if (!_dlq) _dlq = createDLQ(QUEUE_NAMES.INCOMING_MESSAGES);
  return _dlq;
}

async function processJob(job) {
  const { message, from, messageId, type, traceId } = job.data;

  if (!message || !from || !messageId || !type) {
    logError('Invalid job data — dropping', { jobId: job.id, from, messageId, type });
    return; // Don't retry malformed data
  }

  log('Processing', { jobId: job.id, messageId, from: from.slice(-4), type });

  await routeMessage({ message, from, messageId, type, traceId: traceId || messageId });

  log('Processed ✓', { jobId: job.id, messageId });
}

function startWorker() {
  const connection = createBullMQConnection();

  _worker = new Worker(
    QUEUE_NAMES.INCOMING_MESSAGES,
    processJob,
    {
      connection,
      concurrency: CONCURRENCY,
    }
  );

  _worker.on('completed', (job) => {
    log('Job completed', { jobId: job.id, messageId: job.data?.messageId });
  });

  _worker.on('failed', (job, err) => {
    if (job.attemptsMade >= (job.opts?.attempts || 5)) {
      logError('Job exhausted all retries — routing to DLQ', {
        jobId:     job.id,
        messageId: job.data?.messageId,
        from:      job.data?.from?.slice(-4),
        err:       err.message,
      });
      safeEnqueue(getDLQ(), 'failed_message', {
        originalJobId: job.id,
        ...job.data,
        error:         err.message,
        exhaustedAt:   new Date().toISOString(),
      }, `dlq:msg:${job.id}`).catch(() => {});
    } else {
      log(`Retry ${job.attemptsMade} for messageId=${job.data?.messageId}`, {
        err: err.message,
      });
    }
  });

  _worker.on('error', (err) => {
    logError('Worker error', { err: err.message });
  });

  log(`Started ✓  concurrency=${CONCURRENCY}`);
  return _worker;
}

/* ─── Graceful shutdown ───────────────────────────────────────────────────── */

async function shutdown(signal) {
  log(`Received ${signal} — shutting down gracefully`);
  try {
    if (_worker) {
      await _worker.close();
      log('Worker closed ✓');
    }
    await closeRedis();
    await closePool();
  } catch (err) {
    logError('Shutdown error', { err: err.message });
  }
  process.exit(0);
}

if (require.main === module) {
  startWorker();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logError('Uncaught exception', { err: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logError('Unhandled rejection', { reason: String(reason) });
  });
}

module.exports = { startWorker };
