'use strict';

/**
 * queues/queue.js — BullMQ queue definitions (v4)
 *
 * Exports factory functions for each queue. Each factory creates a new
 * Queue instance backed by a dedicated Redis connection.
 *
 * Queues:
 *   • incoming_messages_queue  — raw webhook payloads waiting to be processed
 *   • whatsapp_send_queue      — outbound WhatsApp messages waiting to be sent
 *   • job_processing_queue     — async job lifecycle events (dispatch, watchdog)
 *
 * Retry & backoff strategy (applied per queue):
 *   • 5 attempts total
 *   • Exponential backoff starting at 5s, doubling each attempt (5s → 10s → 20s → 40s → 80s)
 *   • After all attempts fail → moved to DLQ (separate queue: *_dlq)
 *
 * Idempotency:
 *   • Callers MUST pass a jobId string to queue.add(). BullMQ will silently
 *     ignore duplicate jobIds within the job's TTL, making all enqueues
 *     idempotent by message ID.
 */

const { Queue } = require('bullmq');
const { createBullMQConnection } = require('./redisClient');

/* ─── Shared retry/backoff defaults ──────────────────────────────────────── */

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BACKOFF   = { type: 'exponential', delay: 5_000 }; // 5s → 10s → 20s → 40s → 80s
const DEFAULT_REMOVE_ON_COMPLETE = { count: 1_000, age: 24 * 60 * 60 };   // keep last 1k or 24 h
const DEFAULT_REMOVE_ON_FAIL    = { count: 5_000, age: 7 * 24 * 60 * 60 }; // keep 7 days for debugging

const DEFAULT_JOB_OPTIONS = {
  attempts:           DEFAULT_ATTEMPTS,
  backoff:            DEFAULT_BACKOFF,
  removeOnComplete:   DEFAULT_REMOVE_ON_COMPLETE,
  removeOnFail:       DEFAULT_REMOVE_ON_FAIL,
};

/* ─── Queue names (single source of truth) ───────────────────────────────── */

const QUEUE_NAMES = {
  INCOMING_MESSAGES: 'incoming_messages_queue',
  WHATSAPP_SEND:     'whatsapp_send_queue',
  JOB_PROCESSING:    'job_processing_queue',
  // Dead-letter queues (jobs that exhausted all retries land here)
  INCOMING_DLQ:      'incoming_messages_dlq',
  WHATSAPP_DLQ:      'whatsapp_send_dlq',
  JOB_DLQ:           'job_processing_dlq',
};

/* ─── Queue factory ───────────────────────────────────────────────────────── */

/**
 * Creates a BullMQ Queue with dedicated Redis connection.
 * Each call returns a NEW Queue instance — do not create queues in tight loops.
 *
 * @param {string} name
 * @param {object} [extraOpts]
 * @returns {import('bullmq').Queue}
 */
function createQueue(name, extraOpts = {}) {
  const connection = createBullMQConnection();

  const queue = new Queue(name, {
    connection,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...extraOpts },
  });

  queue.on('error', (err) => {
    console.error(JSON.stringify({
      ts:    new Date().toISOString(),
      ctx:   '[queue]',
      queue: name,
      msg:   'Queue error',
      err:   err.message,
    }));
  });

  return queue;
}

/* ─── Named queue factories ───────────────────────────────────────────────── */

function createIncomingMessagesQueue() {
  return createQueue(QUEUE_NAMES.INCOMING_MESSAGES, {
    // Incoming messages should be processed quickly — shorter TTL
    removeOnComplete: { count: 500, age: 3600 },
  });
}

function createWhatsAppSendQueue() {
  return createQueue(QUEUE_NAMES.WHATSAPP_SEND, {
    attempts: 6,                                        // one extra attempt for external API
    backoff:  { type: 'exponential', delay: 5_000 },   // 5s → 10s → 20s → 40s → 80s → 160s
  });
}

function createJobProcessingQueue() {
  return createQueue(QUEUE_NAMES.JOB_PROCESSING);
}

function createDLQ(forQueue) {
  const dlqName = forQueue + '_dlq';
  return createQueue(dlqName, {
    attempts:         1,    // DLQ items are for inspection only
    removeOnComplete: { count: 10_000, age: 30 * 24 * 3600 }, // 30 days
    removeOnFail:     { count: 10_000, age: 30 * 24 * 3600 },
  });
}

/* ─── Enqueue helpers ─────────────────────────────────────────────────────── */

/**
 * Safely enqueues a job, catching errors so callers are never thrown.
 * Returns true on success, false on failure.
 *
 * @param {import('bullmq').Queue} queue
 * @param {string}                 jobName   — logical job type label
 * @param {object}                 data
 * @param {string}                 idempotencyKey — unique ID, prevents duplicates
 * @param {object}                 [opts]    — overrides for BullMQ job options
 */
async function safeEnqueue(queue, jobName, data, idempotencyKey, opts = {}) {
  try {
    await queue.add(jobName, data, {
      jobId: idempotencyKey,
      ...opts,
    });
    return true;
  } catch (err) {
    // Duplicate jobId = already queued = desired idempotent behaviour.
    // BullMQ throws 'Job already exists' for duplicate ids — treat as success.
    if (err.message && err.message.includes('already exists')) {
      return true;
    }
    console.error(JSON.stringify({
      ts:     new Date().toISOString(),
      ctx:    '[queue]',
      msg:    'safeEnqueue failed',
      queue:  queue.name,
      jobName,
      idempotencyKey,
      err:    err.message,
    }));
    return false;
  }
}

module.exports = {
  QUEUE_NAMES,
  createQueue,
  createIncomingMessagesQueue,
  createWhatsAppSendQueue,
  createJobProcessingQueue,
  createDLQ,
  safeEnqueue,
};
