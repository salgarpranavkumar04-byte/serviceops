'use strict';

/**
 * controllers/payment.controller.js — Razorpay webhook handler (v5) NEW
 *
 * Handles:
 *   POST /payment/webhook
 *
 * Logic extracted from server.js handlePaymentConfirmed().
 */

const db                         = require('../db/db');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { verifyWebhookSignature, parsePaymentEvent } = require('../services/paymentService');
const { completeJobInTransaction } = require('./jobs.controller');
const { sendCustomerMessage, sendTechnicianMessage } = require('../services/notification.service');

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[payment]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[payment][error]', msg, ...meta }));
}

/* ─── POST /payment/webhook ───────────────────────────────────────────────── */

// Note: NOT wrapped with asyncHandler intentionally — we always return 200
// to Razorpay even on errors (they retry on non-2xx).
const handleWebhook = (req, res) => {
  const signature = req.headers['x-razorpay-signature'] || '';
  const rawBody   = req.rawBody;

  // Verify signature — return 200 even on failure (Razorpay retries on non-2xx)
  try {
    verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    logError('Signature verification failed', {
      err:      err.message,
      severity: 'CRITICAL',
      alert:    true,
    });

    // Count failures in Redis — alert if threshold exceeded (B-6)
    try {
      const { getRedisClient } = require('../queues/redisClient');
      const redis = getRedisClient();
      if (redis) {
        const key   = 'razorpay:sig_fail:count';
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, 60); // 1-minute window
        if (count >= 3) {
          console.error(JSON.stringify({
            ts:       new Date().toISOString(),
            ctx:      '[payment][ALERT]',
            msg:      'Razorpay signature failure threshold breached — possible webhook misconfiguration or attack',
            count,
            severity: 'CRITICAL',
            alert:    true,
          }));
        }
      }
    } catch { /* redis unavailable — log already captured above */ }

    return res.status(200).json({ status: 'ignored' });
  }

  const event = parsePaymentEvent(req.body);
  if (!event) return res.status(200).json({ status: 'ignored' });

  log('Event received', {
    event:         event.event,
    jobId:         event.jobId,
    paymentLinkId: event.paymentLinkId,
  });

  if (!['payment_link.paid', 'payment.captured'].includes(event.event)) {
    return res.status(200).json({ status: 'ok' });
  }

  res.status(200).json({ status: 'ok' });

  setImmediate(async () => {
    try {
      await handlePaymentConfirmed(event);
    } catch (err) {
      logError('handlePaymentConfirmed error', { err: err.message });
    }
  });
};

/* ─── Core payment completion ─────────────────────────────────────────────── */

async function handlePaymentConfirmed(event) {
  const { jobId, paymentLinkId, paymentId } = event;

  if (!jobId) {
    logError('No jobId in event — cannot process');
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const job = await client.query(
      `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`, [jobId]
    );

    if (job.rows.length === 0) {
      await client.query('ROLLBACK');
      logError(`job=${jobId} not found`);
      return;
    }

    const row = job.rows[0];

    if (row.status === 'COMPLETED') {
      await client.query('ROLLBACK');
      log(`job=${jobId} already COMPLETED — skipping`);
      return;
    }

    if (row.status !== 'PAYMENT_PENDING') {
      await client.query('ROLLBACK');
      logError(`job=${jobId} unexpected status ${row.status}`);
      return;
    }

    if (!row.price || isNaN(parseFloat(row.price))) {
      await client.query('ROLLBACK');
      logError(`job=${jobId} has no price set — cannot complete`);
      return;
    }

    // Record payment reference
    await client.query(`
      UPDATE jobs
      SET payment_status     = 'PAID',
          payment_reference  = $1,
          updated_at         = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [paymentId || null, jobId]);

    if (paymentLinkId) {
      await client.query(`
        UPDATE payment_links SET status = 'paid', updated_at = CURRENT_TIMESTAMP
        WHERE razorpay_link_id = $1
      `, [paymentLinkId]);
    }

    await completeJobInTransaction(client, jobId, row);

    await client.query('COMMIT');

    log(`job=${jobId} payment confirmed — COMPLETED`);

    // Notify both parties
    const notifications = [];

    if (row.customer_phone) {
      notifications.push(
        sendCustomerMessage(
          row.customer_phone,
          `✅ Payment confirmed! Job #${jobId.slice(0, 8)} is complete. Thank you!`
        )
      );
    }

    if (row.technician_id) {
      const tech = await db.query('SELECT phone FROM technicians WHERE id=$1', [row.technician_id]);
      if (tech.rows[0]?.phone) {
        notifications.push(
          sendTechnicianMessage(
            tech.rows[0].phone,
            `✅ Payment received for Job #${jobId.slice(0, 8)}. Job marked COMPLETE. Great work!`
          )
        );
      }
    }

    await Promise.allSettled(notifications);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logError('handlePaymentConfirmed error', { err: err.message });
  } finally {
    client.release();
  }
}

module.exports = { handleWebhook };
