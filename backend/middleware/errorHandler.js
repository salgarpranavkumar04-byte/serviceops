'use strict';

/**
 * middleware/errorHandler.js — Centralized error handler (v5) NEW
 *
 * Catches any error passed to next(err) from route handlers or async wrappers.
 * Must be registered LAST in Express middleware chain:
 *
 *   app.use(errorHandler);
 *
 * Usage in controllers — instead of try/catch in every route:
 *   router.get('/foo', asyncHandler(async (req, res) => {
 *     const data = await someAsyncCall();
 *     res.json({ success: true, data });
 *   }));
 *
 * AppError class lets controllers throw typed, HTTP-aware errors:
 *   throw new AppError('Job not found', 404);
 *   throw new AppError('Invalid status transition', 400, { current: row.status });
 */

/* ─── Typed application error ─────────────────────────────────────────────── */

class AppError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=500]
   * @param {object} [meta={}]      — extra fields merged into error response
   */
  constructor(message, statusCode = 500, meta = {}) {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.meta       = meta;
    Error.captureStackTrace(this, this.constructor);
  }
}

/* ─── Async route wrapper ─────────────────────────────────────────────────── */

/**
 * Wraps an async Express handler so unhandled rejections are forwarded
 * to the centralized error handler via next(err).
 *
 * @param {function} fn   async (req, res, next) => void
 * @returns Express middleware
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/* ─── Centralized error handler ───────────────────────────────────────────── */

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const isAppError = err.name === 'AppError';

  // Always log server errors (5xx); log 4xx only in development
  const shouldLog = statusCode >= 500 || process.env.NODE_ENV !== 'production';

  if (shouldLog) {
    console.error(JSON.stringify({
      ts:         new Date().toISOString(),
      ctx:        '[errorHandler]',
      msg:        err.message,
      statusCode,
      method:     req.method,
      path:       req.path,
      stack:      process.env.NODE_ENV !== 'production' ? err.stack : undefined,
      ...(isAppError ? err.meta : {}),
    }));
  }

  // Don't leak internal details to clients in production
  const clientMessage = isAppError
    ? err.message
    : (process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message);

  res.status(statusCode).json({
    success: false,
    message: clientMessage,
    ...(isAppError && err.meta ? err.meta : {}),
  });
}

module.exports = { errorHandler, AppError, asyncHandler };
