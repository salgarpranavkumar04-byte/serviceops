'use strict';

/**
 * utils/gracefulShutdown.js — SIGTERM / SIGINT handler (v4)
 *
 * Coordinates an ordered, graceful shutdown:
 *   1. Stop accepting new HTTP connections (server.close())
 *   2. Wait for in-flight requests to complete (up to DRAIN_TIMEOUT_MS)
 *   3. Stop BullMQ workers (if registered)
 *   4. Close database pool
 *   5. Close Redis client
 *   6. Exit 0
 *
 * Usage in server.js:
 *   const { registerGracefulShutdown } = require('./utils/gracefulShutdown');
 *   registerGracefulShutdown(httpServer, { workers: [messageWorker, waWorker] });
 */

const DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || '15000', 10);

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[shutdown]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[shutdown][error]', msg, ...meta }));
}

let _shutting = false;

/**
 * Register graceful shutdown handlers on the process.
 *
 * @param {import('http').Server} httpServer
 * @param {object}                [opts]
 * @param {import('bullmq').Worker[]} [opts.workers=[]]   — BullMQ workers to stop
 * @param {Function}              [opts.onShutdown]       — extra async cleanup fn
 */
function registerGracefulShutdown(httpServer, opts = {}) {
  const workers    = opts.workers    || [];
  const onShutdown = opts.onShutdown || null;

  async function shutdown(signal) {
    if (_shutting) {
      log(`Already shutting down (signal=${signal}) — ignoring`);
      return;
    }
    _shutting = true;
    log(`Received ${signal} — starting graceful shutdown`, { drainMs: DRAIN_TIMEOUT_MS });

    // 1. Stop accepting new HTTP connections
    await new Promise((resolve) => {
      httpServer.close((err) => {
        if (err) logError('httpServer.close error', { err: err.message });
        else log('HTTP server closed — no new connections ✓');
        resolve();
      });

      // Force-close if drain takes too long
      setTimeout(() => {
        log('Drain timeout reached — forcing HTTP close');
        resolve();
      }, DRAIN_TIMEOUT_MS);
    });

    // 2. Stop BullMQ workers gracefully (finish in-flight jobs)
    if (workers.length > 0) {
      log(`Closing ${workers.length} BullMQ worker(s)...`);
      await Promise.allSettled(
        workers.map(w =>
          w.close().catch(err => logError('Worker close error', { err: err.message }))
        )
      );
      log('BullMQ workers closed ✓');
    }

    // 3. User-provided cleanup
    if (onShutdown) {
      try {
        await onShutdown();
      } catch (err) {
        logError('onShutdown hook error', { err: err.message });
      }
    }

    // 4. Close database pool
    try {
      const db = require('../db/db');
      await db.closePool();
    } catch (err) {
      logError('DB pool close error', { err: err.message });
    }

    // 5. Close Redis
    try {
      const { closeRedis } = require('../queues/redisClient');
      await closeRedis();
    } catch (err) {
      logError('Redis close error', { err: err.message });
    }

    log('Graceful shutdown complete ✓');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logError('Uncaught exception', { err: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logError('Unhandled rejection', { reason: String(reason) });
    // Don't shut down on unhandled rejection — just log it.
    // This avoids crashing on transient async errors in non-critical paths.
  });

  log('Registered ✓');
}

module.exports = { registerGracefulShutdown };
