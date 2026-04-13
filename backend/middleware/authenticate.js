'use strict';

/**
 * middleware/authenticate.js — Dual-key API authentication (v6)
 *
 * API_KEY        — full write access (admin operations, job mutations)
 * ADMIN_READ_KEY — read-only access (monitoring, stats, list endpoints)
 *
 * req.authLevel is set to 'write' or 'read' so route handlers can check.
 */

const WRITE_KEY = process.env.API_KEY        || '';
const READ_KEY  = process.env.ADMIN_READ_KEY || '';

function authenticate(req, res, next) {
  const provided = req.headers['x-api-key'];

  if (!provided) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  if (WRITE_KEY && provided === WRITE_KEY) {
    req.authLevel = 'write';
    return next();
  }

  if (READ_KEY && provided === READ_KEY) {
    req.authLevel = 'read';
    return next();
  }

  return res.status(401).json({ success: false, message: 'Unauthorized' });
}

/**
 * Middleware that requires write-level auth.
 * Use on any route that mutates state.
 */
function requireWrite(req, res, next) {
  if (req.authLevel !== 'write') {
    return res.status(403).json({ success: false, message: 'Write access required' });
  }
  next();
}

module.exports = { authenticate, requireWrite };
