'use strict';

/**
 * routes/whatsappRouter.js — WhatsApp webhook receiver (v5)
 *
 * CHANGES FROM v4:
 *   • Imports moved to use local paths (services/, queues/) consistently.
 *   • Rate limiters imported from middleware/rateLimiters.js instead of
 *     being defined inline — single source of truth.
 *   • No logic changes — all webhook processing unchanged.
 *
 * Mounted at: app.use('/webhook', whatsappRouter)
 */

const express  = require('express');
const crypto   = require('crypto');
const { extractMessage }     = require('../services/messageRouter');
const { whatsappLimiter, simulateLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

/* ─── Config ──────────────────────────────────────────────────────────────── */

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'changeme_in_env';
const APP_SECRET   = process.env.WHATSAPP_APP_SECRET  || '';
const SIMULATE_ENABLED = process.env.ENABLE_SIMULATE === 'true';

/* ─── Structured logger ───────────────────────────────────────────────────── */

function log(ctx, msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx, msg, ...meta }));
}
function logError(ctx, msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx, msg, ...meta }));
}

/* ─── Redis-backed dedup ──────────────────────────────────────────────────── */

const SEEN_TTL_SECONDS = 10 * 60;
const MAX_SEEN_LOCAL   = 10_000;
const seenIdsLocal     = new Map();

let _redisClient = null;

function getRedis() {
  if (_redisClient) return _redisClient;
  try {
    const { getRedisClient } = require('../queues/redisClient');
    _redisClient = getRedisClient();
  } catch { _redisClient = null; }
  return _redisClient;
}

async function isDuplicate(id) {
  if (!id) return false;

  const redis = getRedis();
  if (redis) {
    try {
      const key    = `wa:dedup:${id}`;
      const result = await redis.set(key, '1', 'EX', SEEN_TTL_SECONDS, 'NX');
      return result === null; // null = key already existed = duplicate
    } catch (err) {
      logError('[webhook]', 'Redis dedup error — falling back to local Map', { err: err.message });
    }
  }

  // In-process fallback
  const now = Date.now();
  let pruned = 0;
  for (const [k, exp] of seenIdsLocal) {
    if (pruned++ > 50) break;
    if (now >= exp) seenIdsLocal.delete(k);
  }

  if (seenIdsLocal.has(id) && now < seenIdsLocal.get(id)) return true;
  if (seenIdsLocal.size >= MAX_SEEN_LOCAL) {
    seenIdsLocal.delete(seenIdsLocal.keys().next().value);
  }
  seenIdsLocal.set(id, now + SEEN_TTL_SECONDS * 1000);
  return false;
}

/* ─── BullMQ queue (lazy) ─────────────────────────────────────────────────── */

let _incomingQueue = null;

function getIncomingQueue() {
  if (_incomingQueue) return _incomingQueue;
  try {
    const { createIncomingMessagesQueue } = require('../queues/queue');
    _incomingQueue = createIncomingMessagesQueue();
  } catch (err) {
    logError('[webhook]', 'Could not create incoming_messages_queue', { err: err.message });
    _incomingQueue = null;
  }
  return _incomingQueue;
}

// ── Semaphore for inline processing when queue is unavailable (FIX A-8) ──────
let _inlineConcurrent = 0;
const _inlineQueue    = [];
const INLINE_MAX      = 5;

async function runWithSemaphore(fn) {
  if (_inlineConcurrent >= INLINE_MAX) {
    await new Promise(resolve => _inlineQueue.push(resolve));
  }
  _inlineConcurrent++;
  try {
    return await fn();
  } finally {
    _inlineConcurrent--;
    if (_inlineQueue.length > 0) _inlineQueue.shift()();
  }
}

async function enqueueOrProcess(extracted) {
  const { message, from, messageId, type } = extracted;
  const q = getIncomingQueue();

  if (q) {
    const { safeEnqueue } = require('../queues/queue');
    const enqueued = await safeEnqueue(
      q, 'incoming_message',
      { message, from, messageId, type, traceId: messageId }, // traceId (C-1)
      `msg:${messageId}`
    );
    if (enqueued) {
      log('[webhook]', 'Enqueued to incoming_messages_queue', {
        messageId, from: from.slice(-4), type,
      });
      return;
    }
    logError('[webhook]', 'Enqueue failed — falling back to inline', { messageId });
  }

  // Inline fallback with concurrency cap (A-8)
  const { routeMessage } = require('../services/messageRouter');
  await runWithSemaphore(() => routeMessage({ message, from, messageId, type, traceId: messageId }));
}

/* ─── Delivery status handler (FIX C-2) ──────────────────────────────────── */

async function handleDeliveryStatus(statusObj) {
  const { id: messageId, status, recipient_id, errors } = statusObj || {};
  if (!messageId || !status) return;

  log('[webhook]', 'WA delivery status', {
    messageId,
    status,
    phone: (recipient_id || '').slice(-4),
  });

  if (status === 'failed') {
    const errorCode  = errors?.[0]?.code;
    const errorTitle = errors?.[0]?.title;

    logError('[webhook]', 'WhatsApp delivery FAILED', {
      messageId,
      phone:      (recipient_id || '').slice(-4),
      errorCode,
      errorTitle,
    });

    try {
      const db = require('../db/db');
      await db.query(
        `INSERT INTO whatsapp_delivery_failures
           (message_id, recipient_phone, error_code, error_title, failed_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, recipient_id || null, errorCode || null, errorTitle || null]
      );
    } catch (dbErr) {
      logError('[webhook]', 'Failed to persist delivery failure', { err: dbErr.message });
    }
  }
}

/* ─── HMAC signature verification ────────────────────────────────────────── */

function verifyMetaSignature(rawBody, signatureHeader) {
  if (!APP_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      logError('[webhook]', 'WHATSAPP_APP_SECRET not set — rejecting webhook in production');
      return false;
    }
    log('[webhook]', 'WARN: WHATSAPP_APP_SECRET not set — skipping signature check (dev mode)');
    return true;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    logError('[webhook]', 'Missing or malformed X-Hub-Signature-256 header');
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(signatureHeader, 'utf8');
  const expBuf = Buffer.from(expected,        'utf8');

  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/* ─── GET /webhook/whatsapp — Meta verification ───────────────────────────── */

router.get('/whatsapp', (req, res) => {
  try {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    log('[webhook]', 'Verification request', { mode });

    if (mode !== 'subscribe') {
      return res.status(403).json({ error: 'Invalid mode' });
    }
    if (!token || token !== VERIFY_TOKEN) {
      log('[webhook]', 'Rejected — token mismatch');
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!challenge) {
      return res.status(400).json({ error: 'Missing challenge' });
    }

    log('[webhook]', 'Verification successful');
    return res.status(200).send(challenge);

  } catch (err) {
    logError('[webhook]', 'Verification handler threw', { err: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ─── POST /webhook/whatsapp — incoming messages ──────────────────────────── */

router.post('/whatsapp', whatsappLimiter, (req, res) => {
  const rawBody   = req.rawBody;
  const signature = req.headers['x-hub-signature-256'] || '';

  if (!verifyMetaSignature(rawBody || Buffer.from(''), signature)) {
    log('[webhook]', 'Signature verification failed — rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.status(200).json({ status: 'received' });
  setImmediate(() => processIncoming(req.body));
});

async function processIncoming(body) {
  try {
    if (!body || typeof body !== 'object') return;
    if (body.object !== 'whatsapp_business_account') return;

    // Handle Meta delivery status callbacks (C-2)
    const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (statuses && Array.isArray(statuses) && statuses.length > 0) {
      for (const s of statuses) {
        setImmediate(() => handleDeliveryStatus(s).catch(() => {}));
      }
      return; // Status updates don't contain messages — stop here
    }

    const extracted = extractMessage(body);
    if (!extracted) return;

    const { message, from, messageId, type } = extracted;

    if (await isDuplicate(messageId)) {
      log('[webhook]', 'Duplicate message — ignored', { messageId });
      return;
    }

    log('[webhook]', 'Processing', { messageId, from: from.slice(-4), type });
    await enqueueOrProcess(extracted);

  } catch (err) {
    logError('[webhook]', 'processIncoming threw', { err: err.message });
  }
}

/* ─── POST /webhook/simulate — dev testing only ───────────────────────────── */

router.post('/simulate', simulateLimiter, (req, res) => {
  if (!SIMULATE_ENABLED) return res.status(404).json({ error: 'Not found' });

  const { phone, type, button_id, text, location, job_id } = req.body || {};

  const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
  if (typeof phone !== 'string' || !PHONE_RE.test(phone.trim())) {
    return res.status(400).json({ error: 'Invalid phone' });
  }
  if (!type) return res.status(400).json({ error: 'type is required' });

  res.status(200).json({ status: 'simulated' });

  setImmediate(async () => {
    try {
      log('[webhook]', 'Simulating message', { phone, type, button_id, job_id });

      const messageId = `sim_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const message   = { from: phone, id: messageId, type };

      if (type === 'interactive' && button_id) {
        message.interactive = {
          button_reply: {
            id:      button_id,
            payload: job_id ? JSON.stringify({ job_id }) : undefined,
          },
        };
      } else if (type === 'text' && text) {
        message.text = { body: text };
      } else if (type === 'location' && location) {
        message.location = location;
      } else {
        log('[webhook]', 'Simulate: unrecognised type/payload — ignored', { type });
        return;
      }

      const { routeMessage } = require('../services/messageRouter');
      await routeMessage({ message, from: phone, messageId, type });

    } catch (err) {
      logError('[webhook]', 'simulate handler threw', { err: err.message });
    }
  });
});

module.exports = router;
