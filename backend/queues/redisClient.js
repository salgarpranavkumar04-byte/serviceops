'use strict';

/**
 * queues/redisClient.js — IORedis singleton (v4)
 *
 * Provides a shared Redis connection for BullMQ queues and the
 * in-process dedup/idempotency layer.
 *
 * Features:
 *   • Lazy connect — only connects when first accessed
 *   • Exponential backoff reconnect (built into ioredis)
 *   • Structured JSON logging for connect / error events
 *   • isReady() helper — callers degrade gracefully if Redis is absent
 *
 * Required env: REDIS_URL  (e.g. redis://localhost:6379  OR
 *                           rediss://user:pass@host:6380  for TLS)
 */

const IORedis = require('ioredis');

let _client = null;
let _ready  = false;

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[redis]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[redis][error]', msg, ...meta }));
}

/**
 * Returns the shared IORedis client.
 * Creates the client on first call.
 * Returns null if REDIS_URL is not configured (allows graceful degradation).
 *
 * @returns {import('ioredis').Redis | null}
 */
function getRedisClient() {
  if (!process.env.REDIS_URL) {
    return null;
  }
  if (_client) return _client;

  _client = new IORedis(process.env.REDIS_URL, {
    // Connection
    connectTimeout:      5_000,
    commandTimeout:      5_000,
    keepAlive:           10_000,
    family:              4,

    // Retry strategy — exponential backoff capped at 30s
    retryStrategy(times) {
      if (times > 20) {
        logError('Max reconnect attempts reached — giving up');
        return null; // stop retrying
      }
      const delay = Math.min(100 * Math.pow(2, times), 30_000);
      log(`Reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },

    // Reconnect on error (e.g. READONLY in Redis Sentinel failover)
    reconnectOnError(err) {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      return targetErrors.some(e => err.message.includes(e));
    },

    // Don't block the process if Redis is down
    enableOfflineQueue:  true,
    lazyConnect:         false,
    maxRetriesPerRequest: 3,
  });

  _client.on('connect', () => {
    _ready = true;
    log('Connected ✓');
  });

  _client.on('ready', () => {
    _ready = true;
    log('Ready ✓');
  });

  _client.on('error', (err) => {
    _ready = false;
    logError('Client error', { err: err.message });
  });

  _client.on('close', () => {
    _ready = false;
    log('Connection closed');
  });

  _client.on('reconnecting', () => {
    log('Reconnecting...');
  });

  return _client;
}

/**
 * True if a Redis client has been created AND is currently connected.
 */
function isReady() {
  return _ready && _client !== null;
}

/**
 * Returns a **new** IORedis instance for use as a BullMQ connection.
 * BullMQ requires a dedicated connection per Queue/Worker — not a shared client.
 *
 * Each caller (queue producer, worker) must call this and manage its own lifecycle.
 */
function createBullMQConnection() {
  if (!process.env.REDIS_URL) {
    throw new Error('[redis] REDIS_URL is not set — cannot create BullMQ connection');
  }
  return new IORedis(process.env.REDIS_URL, {
    connectTimeout:       5_000,
    commandTimeout:       5_000,
    keepAlive:            10_000,
    maxRetriesPerRequest: null, // BullMQ requires this to be null
    enableReadyCheck:     false,
    family:               4,
    retryStrategy(times) {
      if (times > 20) return null;
      return Math.min(100 * Math.pow(2, times), 30_000);
    },
  });
}

/**
 * Graceful shutdown — close the shared client.
 */
async function closeRedis() {
  if (_client) {
    log('Closing shared client...');
    await _client.quit().catch(() => {});
    _client = null;
    _ready  = false;
    log('Shared client closed ✓');
  }
}

module.exports = { getRedisClient, createBullMQConnection, isReady, closeRedis };
