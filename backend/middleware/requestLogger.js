'use strict';

/**
 * middleware/requestLogger.js — Structured HTTP access log (v5) NEW
 *
 * Logs every incoming request with:
 *   method, route, status, duration (ms), timestamp, request ID
 *
 * Design goals:
 *   • Zero dependencies (no morgan)
 *   • Structured JSON — machine-parseable, compatible with log aggregators
 *   • Low verbosity — logs AFTER response, not before (so status is known)
 *   • Skips health-check spam in production to reduce noise
 *   • Adds X-Request-Id header so errors can be correlated across logs
 *
 * Usage in server.js (add immediately after rawBodyMiddleware):
 *   const requestLogger = require('./middleware/requestLogger');
 *   app.use(requestLogger);
 */

const crypto = require('crypto');

/* ─── Paths to suppress in production ────────────────────────────────────── */
// These are polled frequently by monitoring systems and would flood logs.
const SILENT_PATHS = new Set(['/health', '/favicon.ico']);

/* ─── Middleware ──────────────────────────────────────────────────────────── */

function requestLogger(req, res, next) {
  const isProd   = process.env.NODE_ENV === 'production';
  const path     = req.path || req.url;

  // Skip noisy health-check polling in production
  if (isProd && SILENT_PATHS.has(path)) {
    return next();
  }

  // Attach a short request ID so errors and access logs can be correlated
  const requestId = crypto.randomBytes(6).toString('hex');
  req.requestId   = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = Date.now();

  // Log after the response is finished so we capture status code & duration
  res.on('finish', () => {
    const duration = Date.now() - startedAt;
    const logFn    = res.statusCode >= 500 ? console.error : console.log;

    logFn(JSON.stringify({
      ts:         new Date().toISOString(),
      ctx:        '[http]',
      method:     req.method,
      path,
      status:     res.statusCode,
      ms:         duration,
      requestId,
      traceId:    req.headers['x-trace-id'] || null,
      // Include IP only in non-production for privacy; always include in 5xx for debugging
      ip:         (!isProd || res.statusCode >= 500)
                    ? (req.ip || req.socket?.remoteAddress)
                    : undefined,
    }));
  });

  next();
}

module.exports = requestLogger;
