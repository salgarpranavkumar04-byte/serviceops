'use strict';

/**
 * services/dispatch.service.js — Technician dispatch + watchdog (v5) NEW
 *
 * Extracted from server.js.
 *
 * Provides:
 *   findNearestTechnicians(client, jobId, limit) — PostGIS nearest-first query
 *   findNearestTechnician(client, jobId, excludeId) — single nearest
 *   getCurrentBalanceForUpdate(client, techId)   — wallet read with row lock
 *   runTimeoutChecks()                            — watchdog: timeouts + re-dispatch
 *   getJobQueue()                                 — lazy job-processing queue
 *   enqueueJobNotification(name, data, key)       — enqueue job lifecycle event
 */

const db                  = require('../db/db');
const { getSetting }      = require('./settings.service');
const { sendCustomerMessage, sendCustomerRebookMessage, sendTechnicianMessage, sendTechnicianOffer } = require('./notification.service');
const { toWaPhone }       = require('./whatsappClient');

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[dispatch]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[dispatch][error]', msg, ...meta }));
}

/* ─── In-memory delay warned set (single-process watchdog warning dedup) ──── */
// NOTE: This is fine for the watchdog which runs in the main process.
// If the watchdog is ever moved to a worker, replace with a Redis SET.
const delayWarnedJobs = new Set();

/* ─── Lazy job queue ──────────────────────────────────────────────────────── */

let _jobQueue = null;

function getJobQueue() {
  if (_jobQueue) return _jobQueue;
  try {
    const { createJobProcessingQueue } = require('../queues/queue');
    _jobQueue = createJobProcessingQueue();
  } catch { _jobQueue = null; }
  return _jobQueue;
}

async function enqueueJobNotification(jobName, data, idempotencyKey, opts = {}) {
  const q = getJobQueue();
  if (!q) return;
  try {
    const { safeEnqueue } = require('../queues/queue');
    await safeEnqueue(q, jobName, data, idempotencyKey, opts);
  } catch (err) {
    logError('enqueueJobNotification failed', { jobName, idempotencyKey, err: err.message });
  }
}

/* ─── Technician query helpers ────────────────────────────────────────────── */

/**
 * Returns the nearest AVAILABLE technicians for a job, subject to:
 *   - wallet balance below min_wallet_balance
 *   - fewer than max_active_jobs active jobs
 *   - not already sent an offer for this job
 *   - within dispatch_radius_km
 *   - services the job's service_type
 *
 * @param {import('pg').PoolClient} client
 * @param {string} jobId
 * @param {number} [limit=3]
 * @returns {Promise<Array<{ id, name, phone, distance_km }>>}
 */
async function findNearestTechnicians(client, jobId, limit = 3, radiusKmOverride = null) {
  const minWalletBalance = await getSetting('min_wallet_balance');
  const dispatchRadiusKm = radiusKmOverride ?? await getSetting('dispatch_radius_km', 10);
  const maxActiveJobs    = await getSetting('max_active_jobs', 1);

  const result = await client.query(`
    SELECT
      t.id, t.name, t.phone,
      ROUND((ST_Distance(t.location, j.location) / 1000)::numeric, 2) AS distance_km
    FROM technicians t
    JOIN jobs j ON j.id = $1
    JOIN technician_services ts ON ts.technician_id = t.id
    JOIN services s             ON s.id = ts.service_id AND s.name = j.service_type
    WHERE t.status = 'AVAILABLE'
      AND NOT EXISTS (
        SELECT 1 FROM job_offers jo2
        WHERE jo2.job_id = $1 AND jo2.technician_id = t.id
      )
      AND (
        SELECT COUNT(*) FROM jobs j2
        WHERE j2.technician_id = t.id
          AND j2.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','WAITING_FOR_PRICE','CUSTOMER_APPROVAL_PENDING','PAYMENT_PENDING')
      ) < $4
      AND t.wallet_balance <= $2
      AND ST_DWithin(t.location, j.location, $3 * 1000)
    ORDER BY t.location <-> j.location
    LIMIT $5
  `, [jobId, minWalletBalance, dispatchRadiusKm, maxActiveJobs, limit]);

  return result.rows;
}

/**
 * Returns the single nearest eligible technician (excluding optional techId).
 *
 * @param {import('pg').PoolClient} client
 * @param {string} jobId
 * @param {string|null} [excludeId=null]
 * @returns {Promise<{ id, name, phone, distance_km }|null>}
 */
async function findNearestTechnician(client, jobId, excludeId = null) {
  const rows = await findNearestTechnicians(client, jobId, excludeId ? 2 : 1);
  if (excludeId) {
    return rows.find(r => r.id !== excludeId) || null;
  }
  return rows[0] || null;
}

/* ─── Wallet helper ───────────────────────────────────────────────────────── */

/**
 * Returns current wallet balance for a technician, acquiring a row lock
 * suitable for use inside a transaction.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} technician_id
 * @returns {Promise<number>}
 */
async function getCurrentBalanceForUpdate(client, technician_id) {
  const result = await client.query(`
    SELECT balance_after FROM wallet_transactions
    WHERE technician_id = $1
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE
  `, [technician_id]);
  return result.rows.length === 0 ? 0 : parseFloat(result.rows[0].balance_after);
}

/* ─── Audit log helper ────────────────────────────────────────────────────── */

async function insertJobLog(jobId, event, actorType, actorId, metadata = {}) {
  try {
    await db.query(
      `INSERT INTO job_logs (job_id, event, actor_type, actor_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, event, actorType || null, actorId || null, JSON.stringify(metadata)]
    );
  } catch (err) {
    logError(`Failed to insert job log ${event} for job=${jobId}`, { err: err.message });
  }
}

/* ─── Watchdog ────────────────────────────────────────────────────────────── */

/**
 * Periodic timeout checks — runs every 30s via setInterval in server.js.
 *
 * Actions:
 *   1. ASSIGNED jobs that timed out → reset to JOB_CREATED
 *   2. ACCEPTED jobs delayed 20-30 min → log warning
 *   3. ACCEPTED jobs delayed >30 min   → reset to JOB_CREATED
 *   4. CUSTOMER_APPROVAL_PENDING too long → cancel
 *   5. Stale PENDING offers → expire
 *   6. JOB_CREATED with no pending offers → re-dispatch (wave)
 */
async function runTimeoutChecks() {
  const client = await db.connect();
  const pendingNotifications = [];

  try {
    await client.query('BEGIN');

    // ── Tier 1: ASSIGNED not accepted within timeout → reset ──────────────
    const jobAcceptTimeoutMin = await getSetting('job_accept_timeout_min', 2);
    const tier1WindowMax      = jobAcceptTimeoutMin * 5;

    const tier1Jobs = await client.query(`
      SELECT id, technician_id FROM jobs
      WHERE status = 'ASSIGNED'
        AND updated_at < NOW() - ($1 || ' minutes')::INTERVAL
        AND updated_at >= NOW() - ($2 || ' minutes')::INTERVAL
    `, [String(jobAcceptTimeoutMin), String(tier1WindowMax)]);

    for (const row of tier1Jobs.rows) {
      if (row.technician_id) {
        await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [row.technician_id]);
      }
      await client.query(
        `UPDATE jobs SET status='JOB_CREATED', technician_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [row.id]
      );
      log('ASSIGNED timeout — reset to JOB_CREATED', { jobId: row.id });
    }

    // ── Tier 2: ACCEPTED 20-30 min → warning ─────────────────────────────
    const tier2Jobs = await client.query(`
      SELECT id FROM jobs WHERE status='ACCEPTED'
        AND updated_at < NOW() - INTERVAL '20 minutes'
        AND updated_at >= NOW() - INTERVAL '30 minutes'
    `);
    for (const row of tier2Jobs.rows) {
      if (!delayWarnedJobs.has(row.id)) {
        log('⚠️ Job delayed — not started after 20 min', { jobId: row.id });
        delayWarnedJobs.add(row.id);
      }
    }

    // ── Tier 3: ACCEPTED >30 min → reset ─────────────────────────────────
    const tier3Jobs = await client.query(`
      SELECT id, technician_id FROM jobs
      WHERE status='ACCEPTED' AND updated_at < NOW() - INTERVAL '30 minutes'
    `);
    for (const row of tier3Jobs.rows) {
      if (row.technician_id) {
        await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [row.technician_id]);
      }
      await client.query(
        `UPDATE jobs SET status='JOB_CREATED', technician_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [row.id]
      );
      delayWarnedJobs.delete(row.id);
      log('ACCEPTED timeout — reset to JOB_CREATED', { jobId: row.id });
    }

    // ── Tier 3.5: ARRIVED without price submitted ─────────────────────────
    const arrivedPriceTimeoutMin = await getSetting('arrived_price_timeout_min', 30);

    // Reminder: arrived 15 min ago but not yet hit full timeout
    const arrivedReminderJobs = await client.query(`
      SELECT j.id, j.customer_phone, j.technician_id,
             t.phone AS tech_phone, t.name AS tech_name, j.service_type
      FROM jobs j
      JOIN technicians t ON t.id = j.technician_id
      WHERE j.status = 'ACCEPTED'
        AND j.arrived_at IS NOT NULL
        AND j.price IS NULL
        AND j.arrived_at < NOW() - INTERVAL '15 minutes'
        AND j.arrived_at >= NOW() - ($1 || ' minutes')::INTERVAL
    `, [String(arrivedPriceTimeoutMin)]);

    for (const row of arrivedReminderJobs.rows) {
      const shortId = row.id.slice(0, 8);
      pendingNotifications.push({
        type: 'technician',
        phone: row.tech_phone,
        message: `⚠️ Reminder: Please reply with the repair cost for Job #${shortId} to continue. The customer is waiting.`,
      });
    }

    // Timeout: arrived past full timeout, no price → cancel
    const arrivedTimeoutJobs = await client.query(`
      SELECT j.id, j.customer_phone, j.technician_id,
             t.phone AS tech_phone, t.name AS tech_name, j.service_type
      FROM jobs j
      JOIN technicians t ON t.id = j.technician_id
      WHERE j.status = 'ACCEPTED'
        AND j.arrived_at IS NOT NULL
        AND j.price IS NULL
        AND j.arrived_at < NOW() - ($1 || ' minutes')::INTERVAL
      FOR UPDATE SKIP LOCKED
    `, [String(arrivedPriceTimeoutMin)]);

    for (const row of arrivedTimeoutJobs.rows) {
      const shortId = row.id.slice(0, 8);
      const techPhoneNorm = row.tech_phone.replace(/^\+?91/, '');

      await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [row.technician_id]);
      await client.query(
        `UPDATE jobs SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [row.id]
      );

      // Reset tech conversation state
      try {
        const { safePost } = require('./apiClient');
        await safePost('/conversations/upsert', { phone: techPhoneNorm, state: 'idle', context: {} }, 'watchdog');
      } catch (e) {
        logError('Tier3.5: failed to reset tech conversation', { techPhone: techPhoneNorm, err: e.message });
      }

      pendingNotifications.push({
        type: 'customer_rebook',
        phone: row.customer_phone,
        jobId: row.id,
        message: 'Sorry, your technician did not submit a price in time. Your job has been cancelled.',
      });
      pendingNotifications.push({
        type: 'technician',
        phone: row.tech_phone,
        message: `Job #${shortId} was cancelled because no price was submitted in time. You are now available for new jobs.`,
      });

      await insertJobLog(row.id, 'ARRIVED_PRICE_TIMEOUT', 'system', null, { arrivedPriceTimeoutMin });
      log('Tier3.5: arrived-without-price timeout — cancelled', { jobId: row.id, arrivedPriceTimeoutMin });
    }

    // ── Tier 4: CUSTOMER_APPROVAL_PENDING timeout → cancel ────────────────
    const priceApprovalTimeout = await getSetting('price_approval_timeout', 30);
    const priceTimeoutJobs = await client.query(`
      SELECT j.id, j.customer_phone, j.technician_id, t.phone AS tech_phone
      FROM jobs j
      LEFT JOIN technicians t ON t.id = j.technician_id
      WHERE j.status = 'CUSTOMER_APPROVAL_PENDING'
        AND j.price_set_at < NOW() - ($1 || ' minutes')::INTERVAL
    `, [String(priceApprovalTimeout)]);

    for (const row of priceTimeoutJobs.rows) {
      await client.query(
        `UPDATE jobs SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [row.id]
      );
      if (row.technician_id) {
        await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [row.technician_id]);
      }
      log(`Price approval timeout — cancelled`, { jobId: row.id, timeoutMin: priceApprovalTimeout });
      pendingNotifications.push({
        type: 'customer_rebook',
        phone: row.customer_phone,
        jobId: row.id,
        message: 'Your job was cancelled because the price was not approved in time.',
      });
      if (row.tech_phone) {
        pendingNotifications.push({
          type: 'technician',
          phone: row.tech_phone,
          message: `⏰ The customer did not approve the price in time. Job #${row.id.slice(0, 8)} has been cancelled. You are now available for new jobs.`,
        });
      }
    }

    // ── Tier 4.5: Payment link expiry recovery ────────────────────────────
    const paymentLinkExpireMin = await getSetting('payment_link_expire_min', 60);
    const expiredPaymentJobs = await client.query(`
      SELECT j.id, j.customer_phone, j.technician_id, j.payment_id,
             j.price, j.service_type, t.phone AS tech_phone
      FROM jobs j
      LEFT JOIN technicians t ON t.id = j.technician_id
      WHERE j.status = 'PAYMENT_PENDING'
        AND j.updated_at < NOW() - ((${Math.floor(Number(paymentLinkExpireMin)) + 5} || ' minutes')::INTERVAL)
      FOR UPDATE SKIP LOCKED
    `);

    for (const row of expiredPaymentJobs.rows) {
      const { verifyPaymentLink } = require('./priceFlow.service');
      const { paid, reason } = await verifyPaymentLink(row.payment_id).catch(() => ({ paid: false, reason: 'check_failed' }));

      if (paid) {
        const { completeJobInTransaction } = require('../controllers/jobs.controller');
        await completeJobInTransaction(client, row.id, row);
        log('Tier4.5: Late payment detected — completing job', { jobId: row.id });
        pendingNotifications.push({ type: 'customer', phone: row.customer_phone, message: `✅ Payment confirmed! Job #${row.id.slice(0, 8)} is complete. Thank you!` });
        if (row.tech_phone) {
          pendingNotifications.push({ type: 'technician', phone: row.tech_phone, message: `✅ Payment received for Job #${row.id.slice(0, 8)}. Job marked complete.` });
        }
        continue;
      }

      if (['expired', 'cancelled'].includes(reason) || reason === 'check_failed') {
        await client.query(`UPDATE jobs SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [row.id]);
        if (row.technician_id) {
          await client.query(`UPDATE technicians SET status='AVAILABLE' WHERE id=$1`, [row.technician_id]);
        }
        log('Tier4.5: Payment link expired — cancelling job', { jobId: row.id, reason });
        pendingNotifications.push({
          type: 'customer_rebook',
          phone: row.customer_phone,
          jobId: row.id,
          message: 'Your payment link has expired. Please book again to continue.',
        });
        if (row.tech_phone) {
          pendingNotifications.push({
            type: 'technician',
            phone: row.tech_phone,
            message: `Job #${row.id.slice(0, 8)} was cancelled — payment link expired. You are now available for new jobs.`,
          });
        }
        await insertJobLog(row.id, 'PAYMENT_LINK_EXPIRED', 'system', null, { reason });
      }
    }

    // ── Tier 5: Expire stale offers ───────────────────────────────────────
    const offerTimeoutSeconds = await getSetting('offer_timeout_seconds');
    await client.query(`
      UPDATE job_offers SET status='EXPIRED'
      WHERE status='PENDING' AND offered_at < NOW() - ($1 || ' seconds')::INTERVAL
    `, [String(offerTimeoutSeconds)]);

    // ── Tier 6: Re-dispatch wave for JOB_CREATED with no pending offers ───
    const maxDispatchAttempts = await getSetting('max_dispatch_attempts');
    const waveJobs = await client.query(`
      SELECT j.id, j.dispatch_attempts, j.customer_phone, j.latitude, j.longitude, j.service_type
      FROM jobs j
      WHERE j.status = 'JOB_CREATED'
        AND NOT EXISTS (SELECT 1 FROM job_offers jo WHERE jo.job_id = j.id AND jo.status='PENDING')
        AND EXISTS     (SELECT 1 FROM job_offers jo WHERE jo.job_id = j.id)
      FOR UPDATE SKIP LOCKED
    `);

    const baseRadius = await getSetting('dispatch_radius_km', 10);

    for (const row of waveJobs.rows) {
      const { id: jobId, dispatch_attempts: attempts, customer_phone: phone } = row;

      if (attempts >= maxDispatchAttempts) {
        await client.query(
          `UPDATE jobs SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
          [jobId]
        );
        log('Dispatch limit reached — cancelled', { jobId, attempts, maxDispatchAttempts });
        pendingNotifications.push({
          type:    'customer_rebook',
          phone,
          jobId,
          message: 'Sorry, no technician is available right now.',
        });
        continue;
      }

      // A-7: Progressive radius expansion
      let nextTechs = [];
      for (const mult of [1, 1.5, 2]) {
        nextTechs = await findNearestTechnicians(client, jobId, 3, baseRadius * mult);
        if (nextTechs.length > 0) break;
      }

      if (!nextTechs.length) {
        await client.query(
          `UPDATE jobs SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
          [jobId]
        );
        pendingNotifications.push({
          type:    'customer_rebook',
          phone,
          jobId,
          message: 'Sorry, no technician is available right now.',
        });
        continue;
      }

      for (const tech of nextTechs) {
        await client.query(
          `INSERT INTO job_offers (job_id, technician_id, status) VALUES ($1, $2, 'PENDING') ON CONFLICT DO NOTHING`,
          [jobId, tech.id]
        );
        pendingNotifications.push({
          type:        'technician_offer',
          phone:       tech.phone,
          jobId,
          serviceType: row.service_type,
          lat:         parseFloat(row.latitude),
          lng:         parseFloat(row.longitude),
          customerName: 'Customer',
        });
      }

      // A-4: Heartbeat to customer on wave 2+
      if (attempts > 0) {
        pendingNotifications.push({
          type:    'customer',
          phone,
          message: `🔍 Still searching for a technician for Job #${jobId.slice(0,8)} (attempt ${attempts + 1}). We'll notify you as soon as one accepts.`,
        });
      }

      await client.query(
        `UPDATE jobs SET dispatch_attempts = dispatch_attempts + 1, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [jobId]
      );
      log(`Wave ${attempts + 1} dispatched`, { jobId, technicians: nextTechs.length });
    }
    }

    await client.query('COMMIT');

    // ── Send notifications outside transaction ────────────────────────────
    await Promise.allSettled(
      pendingNotifications.map(n => {
        if (n.type === 'customer')         return sendCustomerMessage(n.phone, n.message);
        if (n.type === 'customer_rebook')  return sendCustomerRebookMessage(n.phone, n.jobId, n.message);
        if (n.type === 'technician')       return sendTechnicianMessage(n.phone, n.message);
        if (n.type === 'technician_offer') return sendTechnicianOffer(n.phone, n);
        return Promise.resolve();
      })
    );

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logError('runTimeoutChecks failed', { err: err.message });
  } finally {
    client.release();
  }

  // ── Tier 6.5: IN_PROGRESS duration timeout (runs in own client) ──────────
  try {
    const inProgressTimeoutHours = await getSetting('in_progress_timeout_hours', 6);
    const halfTimeout = inProgressTimeoutHours / 2;

    // Reminder at half-timeout
    const reminderJobs = await db.query(`
      SELECT j.id, j.customer_phone, j.service_type, t.phone AS tech_phone
      FROM jobs j
      LEFT JOIN technicians t ON t.id = j.technician_id
      WHERE j.status = 'IN_PROGRESS'
        AND j.payment_confirmed_at < NOW() - ($1 || ' hours')::INTERVAL
        AND j.payment_confirmed_at >= NOW() - ($2 || ' hours')::INTERVAL
    `, [String(halfTimeout), String(inProgressTimeoutHours)]);

    for (const row of reminderJobs.rows) {
      if (!delayWarnedJobs.has(`inprogress:${row.id}`)) {
        await sendCustomerMessage(toWaPhone(row.customer_phone),
          `⏳ Your ${row.service_type} job #${row.id.slice(0,8)} is taking longer than expected. We are monitoring it.`
        ).catch(() => {});
        if (row.tech_phone) {
          await sendTechnicianMessage(toWaPhone(row.tech_phone),
            `⏰ Reminder: Please tap MARK DONE when Job #${row.id.slice(0,8)} is complete.`
          ).catch(() => {});
        }
        delayWarnedJobs.add(`inprogress:${row.id}`);
      }
    }

    // Auto-complete at full timeout
    const timeoutJobs = await db.query(`
      SELECT j.id, j.customer_phone, j.service_type, j.price, j.technician_id, j.payment_id, j.payment_status,
             t.phone AS tech_phone
      FROM jobs j
      LEFT JOIN technicians t ON t.id = j.technician_id
      WHERE j.status = 'IN_PROGRESS'
        AND j.payment_confirmed_at < NOW() - ($1 || ' hours')::INTERVAL
    `, [String(inProgressTimeoutHours)]);

    for (const row of timeoutJobs.rows) {
      const cl2 = await db.connect();
      try {
        await cl2.query('BEGIN');
        const { completeJobInTransaction } = require('../controllers/jobs.controller');
        await completeJobInTransaction(cl2, row.id, row);
        await cl2.query('COMMIT');
        await insertJobLog(row.id, 'AUTO_COMPLETED', 'system', null, {
          reason: 'in_progress_timeout', timeout_hours: inProgressTimeoutHours,
        });
        delayWarnedJobs.delete(`inprogress:${row.id}`);
        await enqueueJobNotification('job_completed_notify', {
          jobId: row.id, customerPhone: row.customer_phone, technicianPhone: row.tech_phone,
          serviceType: row.service_type, amount: row.price,
        }, `notify:auto_done:${row.id}`);
        log('Tier6.5: Auto-completed IN_PROGRESS job', { jobId: row.id });
      } catch (err) {
        await cl2.query('ROLLBACK').catch(() => {});
        logError('Tier6.5: Auto-complete failed', { jobId: row.id, err: err.message });
      } finally {
        cl2.release();
      }
    }
  } catch (err) {
    logError('Tier6.5 failed', { err: err.message });
  }
}

module.exports = {
  findNearestTechnicians,
  findNearestTechnician,
  getCurrentBalanceForUpdate,
  insertJobLog,
  enqueueJobNotification,
  getJobQueue,
  runTimeoutChecks,
};
