'use strict';

/**
 * middleware/rawBody.js — Raw body capture middleware (v5)
 *
 * Must be mounted BEFORE express.json() so that req.rawBody is a Buffer
 * containing the original request bytes. Required for:
 *   • Razorpay webhook HMAC-SHA256 verification  (X-Razorpay-Signature)
 *   • WhatsApp Cloud API webhook signature check  (X-Hub-Signature-256)
 *
 * FIX: The original implementation manually consumed the stream via data/end
 * events. This drained the stream before body-parser could read it, causing
 * body-parser (raw-body) to throw "stream is not readable". The correct
 * approach is to let body-parser read the stream once and capture the raw
 * bytes via its `verify` callback — the stream is only consumed once.
 *
 * Usage in server.js:
 *   app.use(rawBodyMiddleware);   ← replaces both this and express.json()
 */

const bodyParser = require('body-parser');

const rawBodyMiddleware = bodyParser.json({
  limit: '10kb',
  verify: (req, _res, buf) => {
    // buf is the raw Buffer that body-parser already read
    // Store it for HMAC verification in webhook handlers
    if (Buffer.isBuffer(buf) && buf.length > 0) {
      req.rawBody = buf;
    }
  },
});

module.exports = rawBodyMiddleware;
