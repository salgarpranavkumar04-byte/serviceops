'use strict';

/**
 * services/priceFlow.service.js — Price negotiation + payment verification (v1) NEW
 *
 * Responsibilities:
 *   1. Rejection counter — track how many times a customer has rejected a price
 *      for a given job. Stored in Redis (falls back to in-process Map for dev).
 *      Max 3 rejections before escalation is triggered.
 *
 *   2. Razorpay payment verification — when the customer taps PAYMENT_DONE,
 *      the system must verify the link is actually paid before advancing the job.
 *      Supports RAZORPAY_MOCK=true for local dev (skips real API call).
 *
 * Used by:
 *   • services/messageRouter.js  — commandRejectPrice, commandPaymentDone
 *   • controllers/jobs.controller.js — confirmPayment endpoint
 */

const https  = require('https');
const crypto = require('crypto');

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[priceFlow]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[priceFlow][error]', msg, ...meta }));
}

/* ─── Config ──────────────────────────────────────────────────────────────── */

const MAX_REJECTIONS    = 3;
const REJECTION_KEY_TTL = 24 * 60 * 60; // 24 hours in seconds — auto-expire stale keys

/* ─── Redis helper ────────────────────────────────────────────────────────── */

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  try {
    const { getRedisClient } = require('../queues/redisClient');
    _redis = getRedisClient();
  } catch { _redis = null; }
  return _redis;
}

// In-process fallback (dev / Redis unavailable)
const _localCounts = new Map();

/* ─── Rejection counter ───────────────────────────────────────────────────── */

/**
 * Increment the rejection counter for a job.
 * Returns the new count after incrementing.
 *
 * @param {string} jobId
 * @returns {Promise<number>}
 */
async function incrementRejectionCount(jobId) {
  const key   = `price:reject:${jobId}`;
  const redis = getRedis();

  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, REJECTION_KEY_TTL);
      log('Rejection count incremented', { jobId, count });
      return count;
    } catch (err) {
      logError('Redis incr failed — using local Map', { err: err.message });
    }
  }

  // Fallback
  const cur = (_localCounts.get(key) || 0) + 1;
  _localCounts.set(key, cur);
  return cur;
}

/**
 * Get current rejection count for a job (non-destructive).
 * @param {string} jobId
 * @returns {Promise<number>}
 */
async function getRejectionCount(jobId) {
  const key   = `price:reject:${jobId}`;
  const redis = getRedis();

  if (redis) {
    try {
      const val = await redis.get(key);
      return val ? parseInt(val, 10) : 0;
    } catch {}
  }

  return _localCounts.get(key) || 0;
}

/**
 * Reset rejection counter when job is re-assigned or cancelled.
 * @param {string} jobId
 */
async function resetRejectionCount(jobId) {
  const key   = `price:reject:${jobId}`;
  const redis = getRedis();

  if (redis) {
    try { await redis.del(key); } catch {}
  }
  _localCounts.delete(key);
}

/**
 * Returns true if the rejection count has hit the maximum.
 * @param {number} count
 * @returns {boolean}
 */
function isEscalationThreshold(count) {
  return count >= MAX_REJECTIONS;
}

/* ─── Razorpay payment verification ──────────────────────────────────────── */

const KEY_ID     = process.env.RAZORPAY_KEY_ID     || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET  || '';
const TIMEOUT_MS = 8_000;

/**
 * Verify that a Razorpay payment link has been paid.
 *
 * Returns:
 *   { paid: true }                          — payment confirmed
 *   { paid: false, reason: string }         — not paid yet or error
 *
 * When RAZORPAY_MOCK=true → always returns { paid: true } for dev.
 *
 * @param {string} paymentLinkId  — the rzp payment link ID stored in jobs.payment_id
 * @returns {Promise<{ paid: boolean, reason?: string }>}
 */
async function verifyPaymentLink(paymentLinkId) {
  // Mock mode — useful in dev/staging when real Razorpay isn't configured
  if (process.env.RAZORPAY_MOCK === 'true' || !KEY_ID || !KEY_SECRET) {
    log('RAZORPAY_MOCK — returning paid=true', { paymentLinkId });
    return { paid: true };
  }

  if (!paymentLinkId) {
    return { paid: false, reason: 'no_payment_link_id' };
  }

  try {
    const result = await razorpayGet(`/v1/payment_links/${encodeURIComponent(paymentLinkId)}`);
    const status = result?.status;

    log('Razorpay payment link status', { paymentLinkId, status });

    if (status === 'paid') {
      return { paid: true };
    }

    return {
      paid:   false,
      reason: status || 'unknown',
    };
  } catch (err) {
    logError('verifyPaymentLink failed', { paymentLinkId, err: err.message });
    return { paid: false, reason: 'verification_error' };
  }
}

/**
 * Internal GET helper for Razorpay API.
 */
function razorpayGet(path) {
  const credentials = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.razorpay.com',
        path,
        method:   'GET',
        headers:  { Authorization: `Basic ${credentials}` },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = {}; }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err    = new Error(`Razorpay GET ${path} → HTTP ${res.statusCode}`);
            err.status   = res.statusCode;
            err.body     = parsed;
            reject(err);
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('Razorpay request timed out'));
    });
    req.end();
  });
}

/* ─── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  MAX_REJECTIONS,
  incrementRejectionCount,
  getRejectionCount,
  resetRejectionCount,
  isEscalationThreshold,
  verifyPaymentLink,
};
