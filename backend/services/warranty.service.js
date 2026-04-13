'use strict';

/**
 * services/warranty.service.js — Warranty issuance, validation, and claims
 *
 * Called from:
 *   jobs.controller.js   → issueWarranty()       (inside markDone transaction)
 *   messageRouter.js     → checkActiveWarranty(), createWarrantyClaim()
 *   warranty.controller  → all helpers
 *
 * Design:
 *   - issueWarranty() runs INSIDE the caller's DB transaction (client is passed in).
 *     If the warranty INSERT fails, the whole completion rolls back.
 *   - createWarrantyClaim() opens its own transaction — it does multiple writes
 *     (warranty update, new job creation, claim creation, dispatch).
 *   - expireStaleWarranties() is a standalone cron helper — no caller transaction.
 */

const db                        = require('../db/db');
const { getSetting }            = require('./settings.service');
const { findNearestTechnicians, enqueueJobNotification } = require('./dispatch.service');

/* ─── Structured logger ───────────────────────────────────────────────────── */

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[warranty]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[warranty][error]', msg, ...meta }));
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function isValidUUID(id) {
  return typeof id === 'string' && /^[0-9a-fA-F-]{36}$/.test(id);
}

/**
 * Formats a Date to a human-readable "DD Mon YYYY" string.
 * e.g. new Date('2025-03-14') → "14 Mar 2025"
 */
function formatDate(d) {
  return new Date(d).toLocaleDateString('en-IN', {
    day:   '2-digit',
    month: 'short',
    year:  'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/* ─── issueWarranty ───────────────────────────────────────────────────────── */

/**
 * Creates a warranty record for a completed job.
 * MUST be called inside the caller's open DB transaction (client passed in).
 * Does nothing — silently — if the job is itself a warranty job.
 *
 * @param {string} jobId
 * @param {object} client  — pg PoolClient already in BEGIN
 * @returns {object|null}  — { id, expires_at, warranty_days } or null if skipped
 */
async function issueWarranty(jobId, client) {
  if (!isValidUUID(jobId)) throw new Error(`issueWarranty: invalid jobId "${jobId}"`);

  const jobRes = await client.query(
    `SELECT j.id, j.customer_phone, j.customer_name, j.service_type,
            j.technician_id, j.is_warranty_job,
            COALESCE(s.warranty_days, 30) AS warranty_days
     FROM jobs j
     LEFT JOIN services s ON s.name = j.service_type
     WHERE j.id = $1`,
    [jobId]
  );

  if (!jobRes.rows.length) throw new Error(`issueWarranty: job ${jobId} not found`);

  const job = jobRes.rows[0];

  // Warranty jobs themselves don't generate new warranties
  if (job.is_warranty_job) {
    log('Skipping warranty issuance — job is itself a warranty job', { jobId });
    return null;
  }

  // Check warranty system is globally enabled
  const enabled = await getSetting('warranty_enabled', 'true');
  if (enabled !== 'true') {
    log('Warranty system disabled — skipping issuance', { jobId });
    return null;
  }

  const warrantyDays = parseInt(job.warranty_days, 10) || 30;
  const expiresAt    = new Date(Date.now() + warrantyDays * 24 * 60 * 60 * 1000);

  const result = await client.query(
    `INSERT INTO warranties
       (job_id, customer_phone, customer_name, service_type, technician_id, expires_at, warranty_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (job_id) DO NOTHING
     RETURNING id, expires_at, warranty_days`,
    [
      jobId,
      job.customer_phone,
      job.customer_name || null,
      job.service_type,
      job.technician_id || null,
      expiresAt.toISOString(),
      warrantyDays,
    ]
  );

  if (!result.rows.length) {
    log('Warranty already exists for job — skipped', { jobId });
    return null;
  }

  const warranty = result.rows[0];
  log('Warranty issued', { jobId, warrantyId: warranty.id, expiresAt: warranty.expires_at, warrantyDays });

  // Enqueue the WhatsApp notification (runs outside the transaction via BullMQ,
  // so it only fires after the caller commits).
  // Slight delay (3 s) ensures it arrives after the "Job Completed" message.
  setImmediate(async () => {
    try {
      await enqueueJobNotification(
        'notify_warranty_issued',
        {
          jobId,
          customerPhone: job.customer_phone,
          serviceType:   job.service_type,
          expiresAt:     warranty.expires_at,
          warrantyDays,
        },
        `warranty:notify:${warranty.id}`,
        { delay: 3000 }
      );
    } catch (e) {
      logError('Failed to enqueue warranty notification', { jobId, err: e.message });
    }
  });

  return {
    id:            warranty.id,
    expires_at:    warranty.expires_at,
    warranty_days: warrantyDays,
    expires_label: formatDate(warranty.expires_at),
    service_type:  job.service_type,
    customer_phone: job.customer_phone,
  };
}

/* ─── checkActiveWarranty ─────────────────────────────────────────────────── */

/**
 * Returns the ACTIVE warranty for a job, or null if expired/voided/not found.
 *
 * @param {string} jobId
 * @returns {object|null}
 */
async function checkActiveWarranty(jobId) {
  if (!isValidUUID(jobId)) return null;

  const res = await db.query(
    `SELECT w.*, j.customer_name
     FROM warranties w
     JOIN jobs j ON j.id = w.job_id
     WHERE w.job_id = $1`,
    [jobId]
  );

  if (!res.rows.length) return null;

  const w = res.rows[0];

  // Always check expiry live, not just the status column
  if (new Date(w.expires_at) < new Date()) {
    // Lazily expire it so next query is consistent
    await db.query(
      `UPDATE warranties SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'ACTIVE'`,
      [w.id]
    );
    return { ...w, status: 'EXPIRED', is_expired: true };
  }

  if (w.status !== 'ACTIVE') return { ...w, is_expired: false };

  return { ...w, is_expired: false, expires_label: formatDate(w.expires_at) };
}

/* ─── getWarrantyForJob ───────────────────────────────────────────────────── */

/**
 * Returns full warranty info for a job (any status).
 */
async function getWarrantyForJob(jobId) {
  if (!isValidUUID(jobId)) return null;

  const res = await db.query(
    `SELECT w.*,
            t.name  AS technician_name,
            t.phone AS technician_phone,
            (
              SELECT json_agg(
                json_build_object(
                  'id',                c.id,
                  'status',            c.status,
                  'issue_description', c.issue_description,
                  'claim_job_id',      c.claim_job_id,
                  'claimed_at',        c.claimed_at,
                  'resolved_at',       c.resolved_at
                ) ORDER BY c.claimed_at DESC
              )
              FROM warranty_claims c WHERE c.warranty_id = w.id
            ) AS claims
     FROM warranties w
     LEFT JOIN technicians t ON t.id = w.technician_id
     WHERE w.job_id = $1`,
    [jobId]
  );

  return res.rows[0] || null;
}

/* ─── createWarrantyClaim ─────────────────────────────────────────────────── */

/**
 * Creates a warranty claim and dispatches a free warranty job.
 *
 * Steps (all in one transaction):
 *   1. Validate warranty is ACTIVE and not expired
 *   2. Check no existing OPEN claim (per warranty_claim_limit setting)
 *   3. Create the warranty claim record
 *   4. Create a new job (is_warranty_job=true, price=0, original_job_id=originalJob)
 *   5. Assign to original technician if still AVAILABLE, else nearest
 *   6. Update warranty.status = 'CLAIMED'
 *
 * @param {string} warrantyId
 * @param {string} issueDescription
 * @returns {{ claimId, newJobId, technicianFound: boolean }}
 */
async function createWarrantyClaim(warrantyId, issueDescription) {
  if (!isValidUUID(warrantyId)) throw new Error('Invalid warrantyId');
  if (!issueDescription?.trim()) throw new Error('Issue description is required');

  const desc = issueDescription.trim().slice(0, 1000); // clamp

  const pgClient = await db.connect();
  try {
    await pgClient.query('BEGIN');

    // ── 1. Fetch and lock warranty ──────────────────────────────────────────
    const wRes = await pgClient.query(
      `SELECT w.*, j.latitude, j.longitude, j.city, j.customer_address,
              j.customer_name, j.customer_phone
       FROM warranties w
       JOIN jobs j ON j.id = w.job_id
       WHERE w.id = $1
       FOR UPDATE OF w`,
      [warrantyId]
    );

    if (!wRes.rows.length) throw new Error('Warranty not found');
    const warranty = wRes.rows[0];

    if (warranty.status === 'EXPIRED' || new Date(warranty.expires_at) < new Date()) {
      await pgClient.query('ROLLBACK');
      return { error: 'EXPIRED', expires_at: warranty.expires_at };
    }
    if (warranty.status === 'VOIDED') {
      await pgClient.query('ROLLBACK');
      return { error: 'VOIDED' };
    }
    if (warranty.status === 'CLAIMED') {
      await pgClient.query('ROLLBACK');
      return { error: 'ALREADY_CLAIMED' };
    }

    // ── 2. Check open claim limit ───────────────────────────────────────────
    const claimLimit  = parseInt(await getSetting('warranty_claim_limit', '1'), 10);
    const openClaims  = await pgClient.query(
      `SELECT COUNT(*) AS cnt FROM warranty_claims WHERE warranty_id = $1 AND status = 'OPEN'`,
      [warrantyId]
    );
    if (parseInt(openClaims.rows[0].cnt, 10) >= claimLimit) {
      await pgClient.query('ROLLBACK');
      return { error: 'CLAIM_LIMIT_REACHED' };
    }

    // ── 3. Create the new (warranty) job ────────────────────────────────────
    const newJobRes = await pgClient.query(
      `INSERT INTO jobs
         (customer_name, customer_phone, customer_address, service_type,
          latitude, longitude,
          location,
          city,
          status,
          is_warranty_job, original_job_id,
          price,
          payment_status,
          request_id)
       VALUES
         ($1, $2, $3, $4,
          $5, $6,
          ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography,
          $7,
          'JOB_CREATED',
          TRUE, $8,
          0,
          'NOT_REQUIRED',
          $9)
       RETURNING id`,
      [
        warranty.customer_name,
        warranty.customer_phone,
        warranty.customer_address || null,
        warranty.service_type,
        warranty.latitude,
        warranty.longitude,
        warranty.city    || null,
        warranty.job_id, // original_job_id
        `warranty-claim-${warrantyId}-${Date.now()}`,
      ]
    );

    const newJobId = newJobRes.rows[0].id;

    // ── 4. Try to assign the original technician first ──────────────────────
    let assignedTechId   = null;
    let assignedTechName = null;
    let technicianFound  = false;

    if (warranty.technician_id) {
      const origTech = await pgClient.query(
        `SELECT id, name, status FROM technicians WHERE id = $1 FOR UPDATE`,
        [warranty.technician_id]
      );
      if (origTech.rows.length && origTech.rows[0].status === 'AVAILABLE') {
        assignedTechId   = origTech.rows[0].id;
        assignedTechName = origTech.rows[0].name;
        technicianFound  = true;
        log('Assigning warranty job to original technician', { newJobId, techId: assignedTechId });
      }
    }

    // If original tech unavailable, find the nearest available technician
    if (!technicianFound) {
      const nearest = await findNearestTechnicians(pgClient, newJobId, 1);
      if (nearest && nearest.length > 0) {
        assignedTechId   = nearest[0].id;
        assignedTechName = nearest[0].name;
        technicianFound  = true;
        log('Original tech unavailable — assigning nearest', { newJobId, techId: assignedTechId });
      }
    }

    if (technicianFound) {
      await pgClient.query(
        `UPDATE jobs
         SET status='ASSIGNED', technician_id=$1, updated_at=CURRENT_TIMESTAMP
         WHERE id=$2`,
        [assignedTechId, newJobId]
      );
      await pgClient.query(
        `UPDATE technicians SET status='BUSY' WHERE id=$1`,
        [assignedTechId]
      );
    } else {
      log('No technician available for warranty job', { newJobId });
    }

    // ── 5. Create warranty claim record ────────────────────────────────────
    const claimRes = await pgClient.query(
      `INSERT INTO warranty_claims (warranty_id, claim_job_id, issue_description)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [warrantyId, newJobId, desc]
    );
    const claimId = claimRes.rows[0].id;

    // ── 6. Update warranty status → CLAIMED ────────────────────────────────
    await pgClient.query(
      `UPDATE warranties SET status='CLAIMED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [warrantyId]
    );

    await pgClient.query('COMMIT');

    log('Warranty claim created', {
      warrantyId, claimId, newJobId,
      technicianFound, techId: assignedTechId,
    });

    return {
      claimId,
      newJobId,
      technicianFound,
      assignedTechId,
      assignedTechName,
      originalJobId:   warranty.job_id,
      serviceType:     warranty.service_type,
      customerPhone:   warranty.customer_phone,
    };

  } catch (err) {
    await pgClient.query('ROLLBACK').catch(() => {});
    logError('createWarrantyClaim failed', { warrantyId, err: err.message });
    throw err;
  } finally {
    pgClient.release();
  }
}

/* ─── resolveWarrantyClaim ────────────────────────────────────────────────── */

/**
 * Called when a warranty job is marked done (markDone in jobs.controller).
 * Resolves the open claim and returns warranty to EXPIRED state.
 * Runs inside the caller's transaction.
 *
 * @param {string} claimJobId  — the warranty job that was just completed
 * @param {object} client      — pg PoolClient in BEGIN
 */
async function resolveWarrantyClaim(claimJobId, client) {
  if (!isValidUUID(claimJobId)) return;

  const claimRes = await client.query(
    `UPDATE warranty_claims
     SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE claim_job_id = $1 AND status = 'OPEN'
     RETURNING warranty_id`,
    [claimJobId]
  );

  if (!claimRes.rows.length) return; // no open claim for this job

  const { warranty_id } = claimRes.rows[0];

  // Warranty returns to EXPIRED after claim resolution (no more claims allowed)
  await client.query(
    `UPDATE warranties SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [warranty_id]
  );

  log('Warranty claim resolved', { claimJobId, warrantyId: warranty_id });
}

/* ─── voidWarranty ────────────────────────────────────────────────────────── */

/**
 * Admin voids a warranty.
 * @param {string} warrantyId
 * @param {string} reason
 * @param {string} adminId
 */
async function voidWarranty(warrantyId, reason, adminId) {
  if (!isValidUUID(warrantyId)) throw new Error('Invalid warrantyId');

  const res = await db.query(
    `UPDATE warranties
     SET status      = 'VOIDED',
         voided_reason = $1,
         voided_by   = $2,
         voided_at   = CURRENT_TIMESTAMP,
         updated_at  = CURRENT_TIMESTAMP
     WHERE id = $3 AND status IN ('ACTIVE', 'CLAIMED')
     RETURNING id, status`,
    [reason || 'Voided by admin', adminId || 'admin', warrantyId]
  );

  if (!res.rows.length) throw new Error('Warranty not found or already voided/expired');
  log('Warranty voided', { warrantyId, by: adminId });
  return res.rows[0];
}

/* ─── expireStaleWarranties ───────────────────────────────────────────────── */

/**
 * Bulk-expires warranties past their expiry date.
 * Intended to be called from a cron job or the watchdog.
 * @returns {number} count of rows updated
 */
async function expireStaleWarranties() {
  const res = await db.query(
    `UPDATE warranties
     SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
     WHERE status = 'ACTIVE' AND expires_at < CURRENT_TIMESTAMP
     RETURNING id`
  );
  if (res.rows.length > 0) {
    log(`Expired ${res.rows.length} stale warranties`);
  }
  return res.rows.length;
}

/* ─── listWarrantiesForCustomer ───────────────────────────────────────────── */

async function listWarrantiesForCustomer(customerPhone) {
  const res = await db.query(
    `SELECT w.id, w.job_id, w.service_type, w.issued_at, w.expires_at,
            w.status, w.warranty_days,
            t.name AS technician_name,
            (SELECT COUNT(*) FROM warranty_claims c WHERE c.warranty_id = w.id) AS claim_count
     FROM warranties w
     LEFT JOIN technicians t ON t.id = w.technician_id
     WHERE w.customer_phone = $1
     ORDER BY w.issued_at DESC`,
    [customerPhone]
  );
  return res.rows;
}

/* ─── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  issueWarranty,
  checkActiveWarranty,
  getWarrantyForJob,
  createWarrantyClaim,
  resolveWarrantyClaim,
  voidWarranty,
  expireStaleWarranties,
  listWarrantiesForCustomer,
  formatDate,
};
