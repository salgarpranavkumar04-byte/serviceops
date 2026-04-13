'use strict';

/**
 * whatsappClient.js — WhatsApp Cloud API helpers (v4)
 *
 * CHANGES FROM v3:
 *   • sendText / sendButtons / sendLocation now ENQUEUE to whatsapp_send_queue
 *     (BullMQ). whatsappWorker.js handles actual delivery with retry.
 *   • Falls back to direct HTTP call if Redis is not configured (dev mode).
 *   • _directSend() is the raw HTTP caller — used exclusively by whatsappWorker.
 *   • Idempotency key  = callerLabel + ':' + phone + ':' + sha256(payload)
 *   • All public functions are still async and never throw.
 *
 * Required env vars:
 *   WHATSAPP_TOKEN           — Meta permanent/system-user access token
 *   WHATSAPP_PHONE_NUMBER_ID — numeric phone-number ID from Meta Developer Console
 *
 * Optional:
 *   WHATSAPP_API_VERSION     — Graph API version (default: v19.0)
 */

const https  = require('https');
const crypto = require('crypto');

/* ─── Lazy imports to avoid circular dependency issues ───────────────────── */

let _queueModule = null;
let _queue       = null;

function getQueue() {
  if (_queue) return _queue;
  try {
    if (!_queueModule) {
      _queueModule = require('../queues/queue');
    }
    // createWhatsAppSendQueue lazily to avoid Redis connect at module load
    _queue = _queueModule.createWhatsAppSendQueue();
    return _queue;
  } catch {
    return null;
  }
}

/* ─── Config ──────────────────────────────────────────────────────────────── */

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN    = process.env.WHATSAPP_TOKEN           || '';
const API_VERSION     = process.env.WHATSAPP_API_VERSION     || 'v19.0';
const SEND_TIMEOUT_MS = 10_000;

/* ─── Structured logger ───────────────────────────────────────────────────── */

function log(ctx, msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx, msg, ...meta }));
}
function logError(ctx, msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx, msg, ...meta }));
}

/* ─── Idempotency key generator ───────────────────────────────────────────── */

function makeIdempotencyKey(label, phone, payload) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 16);
  return `wa:${label}:${phone}:${hash}`;
}

/* ─── Internal: raw HTTP call to Graph API ────────────────────────────────── */

/**
 * POSTs a message payload to WhatsApp Cloud API.
 * Used by whatsappWorker — not by application code.
 * Returns { ok: true } or { ok: false, error, status, retryable }.
 *
 * @param {string} to      — international format, no '+' (e.g. "919876543210")
 * @param {object} payload — WhatsApp message object (without messaging_product/to)
 */
async function _directSend(to, payload) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    log('[whatsappClient]', 'Skipping send — credentials not configured', { to });
    return { ok: false, error: 'credentials_missing', retryable: false };
  }

  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    ...payload,
  });

  const options = {
    hostname: 'graph.facebook.com',
    path:     `/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Authorization':  `Bearer ${ACCESS_TOKEN}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
          return;
        }

        const retryable = res.statusCode === 429 || res.statusCode >= 500;
        logError('[whatsappClient]', '_directSend: API returned non-2xx', {
          to, status: res.statusCode, body: data.slice(0, 300), retryable,
        });

        const error = new Error(`http_${res.statusCode}`);
        error.status    = res.statusCode;
        error.retryable = retryable;
        resolve({ ok: false, error: error.message, status: res.statusCode, retryable });
      });
    });

    req.on('error', (err) => {
      logError('[whatsappClient]', '_directSend: Request error', { to, err: err.message });
      resolve({ ok: false, error: err.message, retryable: true });
    });

    req.setTimeout(SEND_TIMEOUT_MS, () => {
      req.destroy();
      logError('[whatsappClient]', '_directSend: Request timed out', { to });
      resolve({ ok: false, error: 'timeout', retryable: true });
    });

    req.write(body);
    req.end();
  });
}

/* ─── Internal: enqueue or direct-send ───────────────────────────────────── */

async function _enqueueOrSend(label, to, payload) {
  const idempotencyKey = makeIdempotencyKey(label, to, payload);

  // Try to enqueue via BullMQ (Redis)
  const q = getQueue();
  if (q) {
    try {
      const { safeEnqueue } = require('../queues/queue');
      const enqueued = await safeEnqueue(
        q,
        'send_whatsapp',
        { to, payload, label },
        idempotencyKey
      );
      if (enqueued) {
        log('[whatsappClient]', `Enqueued: ${label}`, { to: to.slice(-4), idempotencyKey });
        return;
      }
    } catch (err) {
      logError('[whatsappClient]', 'Enqueue failed — falling back to direct send', {
        label, to, err: err.message,
      });
    }
  }

  // Fallback: direct send (dev mode or Redis down)
  log('[whatsappClient]', `Direct send (no queue): ${label}`, { to: to.slice(-4) });
  const result = await _directSend(to, payload);
  if (!result.ok) {
    logError('[whatsappClient]', `Direct send failed: ${label}`, {
      to, error: result.error, status: result.status,
    });
  }
}

/* ─── Phone normalizer ────────────────────────────────────────────────────── */

/**
 * Normalise a 10-digit Indian phone → international format (no '+').
 * "9876543210" → "919876543210"
 */
function toWaPhone(phone) {
  const s = String(phone).trim().replace(/^\+/, '');
  if (s.length === 10 && /^[6-9]/.test(s)) return `91${s}`;
  return s;
}

/* ─── Public API ──────────────────────────────────────────────────────────── */

/**
 * Send a plain text message.
 * @param {string} phone — 10-digit or international format
 * @param {string} text
 */
async function sendText(phone, text) {
  try {
    const to = toWaPhone(phone);
    log('[whatsappClient]', 'sendText', { to: to.slice(-4), preview: text.slice(0, 80) });
    await _enqueueOrSend('text', to, {
      type: 'text',
      text: { body: String(text).slice(0, 4096), preview_url: false },
    });
  } catch (err) {
    logError('[whatsappClient]', 'sendText threw', { phone, err: err.message });
  }
}

/**
 * Send an interactive reply-button message (max 3 buttons).
 * @param {string} phone
 * @param {string} bodyText
 * @param {Array<{id:string, title:string}>} buttons
 * @param {string} [header]
 * @param {string} [footer]
 */
async function sendButtons(phone, bodyText, buttons, header = '', footer = '') {
  try {
    const to = toWaPhone(phone);

    if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > 3) {
      logError('[whatsappClient]', 'sendButtons: buttons must be 1–3 items', {
        phone, count: buttons?.length,
      });
      await sendText(phone, bodyText); // graceful fallback to text
      return;
    }

    const interactive = {
      type: 'button',
      body: { text: String(bodyText).slice(0, 1024) },
      action: {
        buttons: buttons.map(b => ({
          type:  'reply',
          reply: {
            id:    String(b.id).slice(0, 256),
            title: String(b.title).slice(0, 20),
          },
        })),
      },
    };

    if (header) interactive.header = { type: 'text', text: String(header).slice(0, 60) };
    if (footer) interactive.footer = { text: String(footer).slice(0, 60) };

    log('[whatsappClient]', 'sendButtons', { to: to.slice(-4), buttonIds: buttons.map(b => b.id) });
    await _enqueueOrSend('buttons', to, { type: 'interactive', interactive });
  } catch (err) {
    logError('[whatsappClient]', 'sendButtons threw', { phone, err: err.message });
  }
}

/**
 * Send a location pin message.
 * @param {string} phone
 * @param {number} lat
 * @param {number} lng
 * @param {string} [name]
 * @param {string} [address]
 */
async function sendLocation(phone, lat, lng, name = 'Customer Location', address = 'Tap to navigate') {
  try {
    const to = toWaPhone(phone);
    log('[whatsappClient]', 'sendLocation', { to: to.slice(-4), lat, lng });
    await _enqueueOrSend('location', to, {
      type:     'location',
      location: { latitude: lat, longitude: lng, name, address },
    });
  } catch (err) {
    logError('[whatsappClient]', 'sendLocation threw', { phone, err: err.message });
  }
}

module.exports = { sendText, sendButtons, sendLocation, _directSend, toWaPhone };
