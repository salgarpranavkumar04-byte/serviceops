'use strict';

/**
 * services/paymentService.js — Razorpay integration (v4)
 *
 * Provides:
 *   • createPaymentLink(jobId, customerPhone, amount, description)
 *       → Creates a Razorpay Payment Link, returns { url, paymentLinkId }
 *
 *   • verifyWebhookSignature(rawBody, signature)
 *       → Validates X-Razorpay-Signature HMAC-SHA256
 *       → Throws on mismatch
 *
 *   • parsePaymentEvent(webhookBody)
 *       → Returns { event, paymentLinkId, paymentId, jobId, status } or null
 *
 * Required env vars:
 *   RAZORPAY_KEY_ID      — API key (rzp_live_...)
 *   RAZORPAY_KEY_SECRET  — API secret
 *   RAZORPAY_WEBHOOK_SECRET — webhook secret (separate from API key)
 */

const https  = require('https');
const crypto = require('crypto');
const { retryOnHttp } = require('./retryService');

/* ─── Config ──────────────────────────────────────────────────────────────── */

const KEY_ID          = process.env.RAZORPAY_KEY_ID          || '';
const KEY_SECRET      = process.env.RAZORPAY_KEY_SECRET       || '';
const WEBHOOK_SECRET  = process.env.RAZORPAY_WEBHOOK_SECRET   || KEY_SECRET;
const BASE_URL_CALLBACK = process.env.RAZORPAY_CALLBACK_URL   || process.env.BASE_URL || '';
const TIMEOUT_MS      = 10_000;

/* ─── Structured logger ───────────────────────────────────────────────────── */

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[paymentService]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[paymentService][error]', msg, ...meta }));
}

/* ─── Internal HTTP helper for Razorpay API ──────────────────────────────── */

async function razorpayRequest(method, path, body = null) {
  const credentials = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  const bodyStr     = body ? JSON.stringify(body) : null;

  const options = {
    hostname: 'api.razorpay.com',
    path,
    method,
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/json',
      ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }

        const err      = new Error(`Razorpay ${method} ${path} → HTTP ${res.statusCode}`);
        err.status     = res.statusCode;
        err.body       = parsed;
        err.retryable  = res.statusCode === 429 || res.statusCode >= 500;
        reject(err);
      });
    });

    req.on('error', (err) => {
      err.retryable = true;
      reject(err);
    });
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      const err   = new Error('Razorpay request timed out');
      err.retryable = true;
      reject(err);
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/* ─── Create Payment Link ─────────────────────────────────────────────────── */

/**
 * Creates a Razorpay Payment Link for a job.
 *
 * @param {string} jobId
 * @param {string} customerPhone — 10-digit Indian mobile (will be normalised)
 * @param {number} amount        — in rupees (converted to paise internally)
 * @param {string} serviceType   — for the description
 * @param {number} [expireMinutes=60]
 *
 * @returns {Promise<{ paymentLinkId: string, shortUrl: string }>}
 */
async function createPaymentLink(jobId, customerPhone, amount, serviceType, expireMinutes = 60) {
  if (!KEY_ID || !KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured');
  }

  if (!amount || isNaN(amount) || amount <= 0) {
    throw new Error('createPaymentLink: invalid amount');
  }

  const amountPaise    = Math.round(amount * 100); // Razorpay uses paise
  const expireAt       = Math.floor(Date.now() / 1000) + expireMinutes * 60;

  // Normalise phone: strip +91 prefix if present
  const cleanPhone = String(customerPhone || '').replace(/^\+?91/, '').slice(-10);

  const payload = {
    amount:      amountPaise,
    currency:    'INR',
    description: `${serviceType} service — Job #${jobId.slice(0, 8)}`,
    reference_id: jobId.slice(0, 36),  // Razorpay reference_id max 40 chars
    expire_by:   expireAt,
    customer: {
      contact: cleanPhone ? `+91${cleanPhone}` : undefined,
    },
    notify: {
      sms:   false, // we send via WhatsApp instead
      email: false,
    },
    reminder_enable: false,
    notes: {
      job_id:  jobId,
      service: serviceType,
    },
    callback_url:    BASE_URL_CALLBACK ? `${BASE_URL_CALLBACK}/payment/callback` : undefined,
    callback_method: 'get',
  };

  log('Creating payment link', { jobId, amount, amountPaise });

  const result = await retryOnHttp(
    () => razorpayRequest('POST', '/v1/payment_links', payload),
    [429, 500, 502, 503, 504],
    { attempts: 3, baseDelay: 1000 }
  );

  log('Payment link created ✓', {
    jobId,
    paymentLinkId: result.id,
    shortUrl: result.short_url,
  });

  return {
    paymentLinkId: result.id,
    shortUrl:      result.short_url,
  };
}

/* ─── Webhook Signature Verification ─────────────────────────────────────── */

/**
 * Verifies that a Razorpay webhook came from Razorpay (not a forged request).
 *
 * Throws an Error with message 'invalid_signature' if the signature does not match.
 *
 * @param {Buffer|string} rawBody  — raw request body (must be buffer/string, not parsed JSON)
 * @param {string}        signature — X-Razorpay-Signature header value
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) {
    logError('RAZORPAY_WEBHOOK_SECRET not set — skipping signature verification (INSECURE)');
    if (process.env.NODE_ENV === 'production') {
      throw new Error('invalid_signature: RAZORPAY_WEBHOOK_SECRET not configured');
    }
    return; // Allow in dev for testing
  }

  const body     = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  const sigBuf  = Buffer.from(signature || '', 'utf8');
  const expBuf  = Buffer.from(expected,   'utf8');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('invalid_signature');
  }
}

/* ─── Parse Razorpay Webhook Event ───────────────────────────────────────── */

/**
 * Extracts the job-relevant fields from a Razorpay webhook body.
 *
 * @param {object} body — parsed JSON webhook body
 * @returns {{ event:string, paymentLinkId:string|null, paymentId:string|null, jobId:string|null, status:string|null } | null}
 */
function parsePaymentEvent(body) {
  try {
    const event = body?.event;
    if (!event) return null;

    const entity        = body?.payload?.payment_link?.entity || body?.payload?.payment?.entity;
    const paymentLinkId = entity?.id || body?.payload?.payment_link?.entity?.id || null;
    const jobId         = entity?.notes?.job_id || null;

    // For payment.captured
    const paymentEntity  = body?.payload?.payment?.entity;
    const paymentId      = paymentEntity?.id || null;
    const paymentStatus  = paymentEntity?.status || entity?.status || null;

    return {
      event,
      paymentLinkId,
      paymentId,
      jobId,
      status: paymentStatus,
    };
  } catch {
    return null;
  }
}

module.exports = { createPaymentLink, verifyWebhookSignature, parsePaymentEvent };
