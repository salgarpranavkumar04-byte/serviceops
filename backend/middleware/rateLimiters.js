'use strict';

/**
 * middleware/rateLimiters.js — All Express rate limiters (v5 fix)
 *
 * FIX: Each limiter now gets its OWN RedisStore instance with a unique prefix.
 * express-rate-limit throws ERR_ERL_STORE_REUSE if a single store is shared.
 */

const rateLimit = require('express-rate-limit');

/* ─── Redis store factory (one instance per limiter) ─────────────────────── */

function makeRedisStore(prefix) {
  if (!process.env.REDIS_URL) return undefined;

  try {
    const { RedisStore } = require('rate-limit-redis');
    const { getRedisClient } = require('../queues/redisClient');
    const client = getRedisClient();
    if (!client) return undefined;

    // A NEW RedisStore instance per call — required by express-rate-limit
    return new RedisStore({
      sendCommand: (...args) => client.call(...args),
      prefix:      `rl:${prefix}:`,
    });
  } catch {
    // rate-limit-redis not installed or Redis unavailable — fall back silently
    return undefined;
  }
}

/* ─── Factory ─────────────────────────────────────────────────────────────── */

function makeLimit(opts, storePrefix) {
  return rateLimit({
    windowMs:        opts.windowMs,
    max:             opts.max,
    message:         opts.message || { success: false, message: 'Too many requests — please slow down' },
    standardHeaders: true,
    legacyHeaders:   false,
    skip:            opts.skip,
    store:           makeRedisStore(storePrefix), // fresh instance every time
  });
}

/* ─── Named limiters ──────────────────────────────────────────────────────── */

const globalLimiter = makeLimit({
  windowMs: 15 * 60 * 1000,
  max:      300,
}, 'global');

const createJobLimiter = makeLimit({
  windowMs: 15 * 60 * 1000,
  max:      500,
  message:  { success: false, message: 'Too many job creation requests' },
}, 'create_job');

const adminLimiter = makeLimit({
  windowMs: 15 * 60 * 1000,
  max:      500,
  message:  { success: false, message: 'Too many admin requests' },
}, 'admin');

const pricingLimiter = makeLimit({
  windowMs: 5 * 60 * 1000,
  max:      200,
  message:  { success: false, message: 'Too many pricing requests' },
}, 'pricing');

const whatsappLimiter = makeLimit({
  windowMs: 60_000,
  max:      120,
  skip:     (req) => req.method === 'GET',
}, 'whatsapp');

const simulateLimiter = makeLimit({
  windowMs: 60_000,
  max:      200,
}, 'simulate');

module.exports = {
  globalLimiter,
  createJobLimiter,
  adminLimiter,
  pricingLimiter,
  whatsappLimiter,
  simulateLimiter,
};