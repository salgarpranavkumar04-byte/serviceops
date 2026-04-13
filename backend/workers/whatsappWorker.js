'use strict';

/**
 * workers/whatsappWorker.js — WhatsApp send queue consumer (v4)
 *
 * Processes jobs from whatsapp_send_queue:
 *   • Calls WhatsApp Cloud API via _directSend()
 *   • On 429 / 5xx: throws error → BullMQ retries with exponential backoff
 *   • On credential missing or 4xx (non-429): marks as permanently failed (no retry)
 *   • Exhausted jobs → routed to whatsapp_send_dlq for inspection
 *   • Concurrency: configurable via WHATSAPP_WORKER_CONCURRENCY (default 5)
 *
 * Run as a separate process:
 *   node workers/whatsappWorker.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Worker }      = require('bullmq');
const { createBullMQConnection, closeRedis } = require('../queues/redisClient');
const { QUEUE_NAMES, createDLQ, safeEnqueue } = require('../queues/queue');
const { _directSend } = require('../services/whatsappClient');
const { closePool }   = require('../db/db');

/* ─── Structured logger ───────────────────────────────────────────────────── */

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[whatsappWorker]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[whatsappWorker][error]', msg, ...meta }));
}

/* ─── Non-retryable HTTP status codes ────────────────────────────────────── */

const NON_RETRYABLE_HTTP = new Set([400, 401, 403, 404, 410]);

/* ─── Worker ──────────────────────────────────────────────────────────────── */

const CONCURRENCY = parseInt(process.env.WHATSAPP_WORKER_CONCURRENCY || '5', 10);

let _dlq    = null;
let _worker = null;

function getDLQ() {
  if (!_dlq) _dlq = createDLQ(QUEUE_NAMES.WHATSAPP_SEND);
  return _dlq;
}

async function processJob(job) {
  const { to, payload, label } = job.data;

  if (!to || !payload) {
    logError('Invalid job data — skipping', { jobId: job.id });
    return; // Don't retry bad data
  }

  log(`Processing send: ${label || 'unknown'}`, {
    jobId:    job.id,
    to:       to.slice(-4),
    attempt:  job.attemptsMade + 1,
  });

  const result = await _directSend(to, payload);

  if (result.ok) {
    log('Sent ✓', { jobId: job.id, to: to.slice(-4), label });
    return;
  }

  // Non-retryable error — don't throw, just log and route to DLQ
  if (!result.retryable) {
    logError('Non-retryable send failure — routing to DLQ', {
      jobId:  job.id,
      to:     to.slice(-4),
      error:  result.error,
      status: result.status,
    });
    await safeEnqueue(getDLQ(), 'failed_send', {
      originalJobId:    job.id,
      to,
      payload,
      label,
      error:            result.error,
      status:           result.status,
      failedAt:         new Date().toISOString(),
    }, `dlq:wa:${job.id}`);
    return; // return without throwing = mark as complete (not retried)
  }

  // Retryable error — throw so BullMQ will retry with backoff
  const err       = new Error(result.error || 'send_failed');
  err.status      = result.status;
  err.retryable   = true;
  throw err;
}

function startWorker() {
  const connection = createBullMQConnection();

  _worker = new Worker(
    QUEUE_NAMES.WHATSAPP_SEND,
    processJob,
    {
      connection,
      concurrency: CONCURRENCY,
      limiter: {
        max:      parseInt(process.env.WHATSAPP_RATE_LIMIT_MAX || '80', 10),
        duration: 60_000, // per minute — stay under Meta's rate limits
      },
    }
  );

  _worker.on('completed', (job) => {
    log('Job completed', { jobId: job.id });
  });

  _worker.on('failed', (job, err) => {
    if (job.attemptsMade >= job.opts.attempts) {
      // Final failure — route to DLQ
      logError('Job exhausted all retries — routing to DLQ', {
        jobId:   job.id,
        to:      job.data?.to?.slice(-4),
        label:   job.data?.label,
        err:     err.message,
        attempts: job.attemptsMade,
      });
      // Fire-and-forget DLQ insertion (best-effort)
      safeEnqueue(getDLQ(), 'exhausted_send', {
        originalJobId: job.id,
        ...job.data,
        error:         err.message,
        exhaustedAt:   new Date().toISOString(),
      }, `dlq:wa:exhaust:${job.id}`).catch(() => {});
    } else {
      log(`Job failed (attempt ${job.attemptsMade}) — will retry`, {
        jobId: job.id,
        err:   err.message,
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

/* ─── Entry point (when run as standalone process) ───────────────────────── */

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
