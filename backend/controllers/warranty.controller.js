'use strict';

/**
 * controllers/warranty.controller.js
 *
 * Mounted at /warranty by warranty.routes.js.
 *
 * Endpoints:
 *   GET  /warranty/job/:jobId         — warranty status for a specific job
 *   GET  /warranty/customer/:phone    — all warranties for a customer
 *   POST /warranty/:id/void           — admin voids a warranty
 *   GET  /warranty/claims             — admin list of all claims (paginated)
 *   GET  /warranty/claims/:id         — single claim detail
 *   POST /warranty/expire-stale       — manually trigger stale expiry (admin/cron)
 */

const {
  getWarrantyForJob,
  listWarrantiesForCustomer,
  voidWarranty,
  expireStaleWarranties,
}                                       = require('../services/warranty.service');
const { AppError, asyncHandler }        = require('../middleware/errorHandler');
const db                                = require('../db/db');

/* ─── Validators ──────────────────────────────────────────────────────────── */

function isValidUUID(id) {
  return typeof id === 'string' && /^[0-9a-fA-F-]{36}$/.test(id);
}

function isValidPhone(phone) {
  return typeof phone === 'string' && /^[6-9]\d{9}$/.test(phone.replace(/\D/g, ''));
}

/* ─── GET /warranty/job/:jobId ───────────────────────────────────────────── */

const getWarrantyByJob = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  if (!isValidUUID(jobId)) throw new AppError('Invalid job ID', 400);

  const warranty = await getWarrantyForJob(jobId);
  if (!warranty) throw new AppError('No warranty found for this job', 404);

  res.json({ success: true, warranty });
});

/* ─── GET /warranty/customer/:phone ─────────────────────────────────────── */

const getWarrantiesByCustomer = asyncHandler(async (req, res) => {
  const { phone } = req.params;

  // Accept both 10-digit and +91 prefixed formats
  const normalised = phone.replace(/^\+?91/, '').replace(/\D/g, '');
  if (!isValidPhone(normalised)) throw new AppError('Invalid phone number', 400);

  const warranties = await listWarrantiesForCustomer(normalised);
  res.json({ success: true, count: warranties.length, warranties });
});

/* ─── POST /warranty/:id/void ────────────────────────────────────────────── */

const voidWarrantyHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) throw new AppError('Invalid warranty ID', 400);

  const { reason } = req.body;
  const adminId    = req.headers['x-admin-id'] || 'admin';

  const updated = await voidWarranty(id, reason, adminId);
  res.json({ success: true, warranty: updated });
});

/* ─── GET /warranty/claims ───────────────────────────────────────────────── */

const listClaims = asyncHandler(async (req, res) => {
  const { status, limit = 100, offset = 0, service_type } = req.query;

  const params  = [];
  const where   = [];

  if (status) {
    params.push(status);
    where.push(`wc.status = $${params.length}::warranty_claim_status_enum`);
  }
  if (service_type) {
    params.push(service_type);
    where.push(`w.service_type = $${params.length}`);
  }

  const parsedLimit  = Math.min(parseInt(limit,  10) || 100, 500);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0,   0);

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(parsedLimit, parsedOffset);

  const res2 = await db.query(
    `SELECT
       wc.id            AS claim_id,
       wc.status        AS claim_status,
       wc.issue_description,
       wc.claimed_at,
       wc.resolved_at,
       wc.rejection_reason,
       wc.claim_job_id,
       w.id             AS warranty_id,
       w.service_type,
       w.customer_phone,
       w.customer_name,
       w.expires_at,
       w.status         AS warranty_status,
       t.name           AS technician_name
     FROM warranty_claims wc
     JOIN warranties w ON w.id = wc.warranty_id
     LEFT JOIN technicians t ON t.id = w.technician_id
     ${whereClause}
     ORDER BY wc.claimed_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({ success: true, count: res2.rows.length, claims: res2.rows });
});

/* ─── GET /warranty/claims/:id ───────────────────────────────────────────── */

const getClaimById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) throw new AppError('Invalid claim ID', 400);

  const result = await db.query(
    `SELECT
       wc.*,
       w.service_type, w.customer_phone, w.customer_name,
       w.expires_at, w.issued_at, w.status AS warranty_status,
       w.job_id AS original_job_id,
       t.name  AS technician_name,
       t.phone AS technician_phone,
       cj.status AS claim_job_status,
       cj.technician_id AS claim_technician_id
     FROM warranty_claims wc
     JOIN warranties w    ON w.id  = wc.warranty_id
     LEFT JOIN technicians t ON t.id = w.technician_id
     LEFT JOIN jobs cj    ON cj.id = wc.claim_job_id
     WHERE wc.id = $1`,
    [id]
  );

  if (!result.rows.length) throw new AppError('Claim not found', 404);
  res.json({ success: true, claim: result.rows[0] });
});

/* ─── POST /warranty/expire-stale ────────────────────────────────────────── */

const expireStale = asyncHandler(async (req, res) => {
  const count = await expireStaleWarranties();
  res.json({ success: true, expired: count });
});

/* ─── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  getWarrantyByJob,
  getWarrantiesByCustomer,
  voidWarrantyHandler,
  listClaims,
  getClaimById,
  expireStale,
};
