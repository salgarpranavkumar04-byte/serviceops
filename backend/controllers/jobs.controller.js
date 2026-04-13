'use strict';

/**
 * controllers/jobs.controller.js — Job lifecycle handlers (v5) NEW
 *
 * Extracted from server.js. Each function is an Express route handler
 * wrapped with asyncHandler from errorHandler.js.
 *
 * Handlers:
 *   listJobs            GET  /jobs
 *   createJob           POST /jobs/create
 *   acceptJob           POST /jobs/:id/accept
 *   rejectOffer         POST /jobs/:id/reject-offer
 *   startJob            POST /jobs/:id/start
 *   rejectJob           POST /jobs/:id/reject          (legacy assigned-job reject)
 *   setPrice            POST /jobs/:id/set-price
 *   approvePrice        POST /jobs/:id/approve-price
 *   rejectPrice         POST /jobs/:id/reject-price
 *   requestPayment      POST /jobs/:id/request-payment
 *   completeJob         POST /jobs/:id/complete
 *   cancelJob           POST /jobs/:id/cancel          (technician)
 *   customerCancelJob   POST /jobs/:id/customer-cancel
 *   watchdogTick        POST /internal/watchdog-tick
 */

const db                       = require('../db/db');
const { withTransaction }      = require('../db/db');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { getSetting }           = require('../services/settings.service');
const { getCommission }        = require('../services/settings.service');
const { reverseGeocode }       = require('../services/geocode.service');
const {
  findNearestTechnicians,
  findNearestTechnician,
  getCurrentBalanceForUpdate,
  insertJobLog,
  enqueueJobNotification,
  runTimeoutChecks,
}                              = require('../services/dispatch.service');
const {
  sendCustomerMessage,
  sendTechnicianOffer,
  sendTechnicianMessage,
}                              = require('../services/notification.service');
const { createPaymentLink }    = require('../services/paymentService');
const {
  issueWarranty,
  resolveWarrantyClaim,
}                              = require('../services/warranty.service');
const {
  incrementRejectionCount,
  resetRejectionCount,
  verifyPaymentLink,
}                              = require('../services/priceFlow.service');

/* ─── Validators ──────────────────────────────────────────────────────────── */

function isValidUUID(id) {
  return /^[0-9a-fA-F-]{36}$/.test(id);
}

function isValidPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone);
}

function requireUUID(id, label = 'ID') {
  if (!isValidUUID(id)) throw new AppError(`Invalid ${label}`, 400);
}

/** Masks all but last 4 digits of a phone number (B-9) */
function maskPhone(phone) {
  if (!phone) return '—';
  const s = String(phone);
  return s.length >= 4 ? '****' + s.slice(-4) : '****';
}

/**
 * Assert the customer making the request owns the job. (B-4)
 * Throws AppError 403 if normalized phones don't match.
 */
function assertCustomerOwnsJob(jobRow, requestPhone) {
  const normalized = String(requestPhone || '').replace(/^\+?91/, '').slice(-10);
  if (jobRow.customer_phone !== normalized) {
    console.error(JSON.stringify({
      ts:       new Date().toISOString(),
      ctx:      '[security]',
      msg:      'Phone mismatch on customer job action — possible replay',
      job_last4: jobRow.customer_phone.slice(-4),
      req_last4: normalized.slice(-4),
    }));
    throw new AppError('Forbidden', 403);
  }
}

/**
 * Send a WhatsApp reply to a technician who tried an unauthorized action,
 * then let the caller throw. (B-5)
 */
async function rejectTechAction(techPhone, message) {
  const { sendText, toWaPhone } = require('../services/whatsappClient');
  await sendText(toWaPhone(techPhone), message).catch(() => {});
}

/* ─── GET /jobs ───────────────────────────────────────────────────────────── */

const listJobs = asyncHandler(async (req, res) => {
  const { status, limit = 500 } = req.query;
  const params = [];
  const where  = [];

  if (status) {
    params.push(status);
    where.push(`j.status = $${params.length}::job_status_enum`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const parsedLimit = Math.min(parseInt(limit, 10) || 500, 2000);
  params.push(parsedLimit);

  const result = await db.query(`
    SELECT j.id, j.customer_name, j.customer_phone, j.customer_address,
           j.service_type, j.status,
           j.price, j.payment_status, j.dispatch_attempts,
           j.created_at, j.updated_at,
           j.technician_id,
           t.name AS technician_name
    FROM jobs j
    LEFT JOIN technicians t ON t.id = j.technician_id
    ${whereClause}
    ORDER BY j.created_at DESC
    LIMIT $${params.length}
  `, params);
  const rows = result.rows.map(r => ({
    ...r,
    customer_phone_masked: maskPhone(r.customer_phone),
  }));
  res.json({ success: true, data: rows });
});

/* ─── POST /jobs/create ───────────────────────────────────────────────────── */

const createJob = asyncHandler(async (req, res) => {
  const {
    customer_name, customer_phone, service_type,
    latitude, longitude, request_id,
  } = req.body;

  if (!customer_name || !customer_phone || !service_type ||
      latitude === undefined || longitude === undefined) {
    throw new AppError('Missing required fields', 400);
  }
  if (!isValidPhone(customer_phone)) {
    throw new AppError('Invalid phone number', 400);
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new AppError('Invalid latitude or longitude', 400);
  }

  const rid = (typeof request_id === 'string' && request_id.trim().length <= 128)
    ? request_id.trim() : null;

  // Start geocoding early (non-blocking)
  const addressPromise = reverseGeocode(lat, lng);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check by request_id
    if (rid) {
      const existing = await client.query(
        'SELECT id, status FROM jobs WHERE request_id=$1', [rid]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.json({
          success:    true,
          duplicate:  true,
          job_id:     existing.rows[0].id,
          status:     existing.rows[0].status,
        });
      }
    }

    const maxOffersPerWave = await getSetting('max_offers_per_wave', 3);
    const baseRadius       = await getSetting('dispatch_radius_km', 10);
    const customerAddress  = await addressPromise;

    const jobResult = await client.query(`
      INSERT INTO jobs (
        customer_name, customer_phone, service_type,
        status, latitude, longitude, location,
        customer_address, dispatch_attempts, request_id
      )
      VALUES ($1, $2, $3, 'JOB_CREATED', $4, $5,
        ST_SetSRID(ST_MakePoint($5, $4), 4326),
        $6, 0, $7
      )
      RETURNING id
    `, [customer_name, customer_phone, service_type, lat, lng, customerAddress, rid]);

    const jobId = jobResult.rows[0].id;

    // Progressive radius: try 1x, 1.5x, 2x dispatch_radius_km (A-7)
    let technicians = [];
    for (const multiplier of [1, 1.5, 2]) {
      technicians = await findNearestTechnicians(client, jobId, maxOffersPerWave, baseRadius * multiplier);
      if (technicians.length > 0) break;
      log('[createJob] No techs at radius, expanding', { jobId, radiusKm: baseRadius * multiplier });
    }

    if (technicians.length === 0) {
      await client.query(
        `UPDATE jobs SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [jobId]
      );
      await client.query('COMMIT');
      await insertJobLog(jobId, 'CANCELLED', 'system', 'dispatch', { reason: 'no_technicians_at_creation' });
      await sendCustomerMessage(customer_phone, 'Sorry, no technician is available right now. Please try again later.');
      return res.json({ success: false, job_id: jobId, message: 'No technicians available.', offers_sent: 0 });
    }

    for (const tech of technicians) {
      await client.query(
        `INSERT INTO job_offers (job_id, technician_id, status) VALUES ($1, $2, 'PENDING')`,
        [jobId, tech.id]
      );
    }

    await client.query('COMMIT');

    await insertJobLog(jobId, 'JOB_CREATED', 'customer', customer_phone, { service_type, lat, lng, request_id: rid });
    for (const tech of technicians) {
      await insertJobLog(jobId, 'OFFER_SENT', 'system', tech.id, { wave: 1 });
    }

    await Promise.allSettled(
      technicians.map(tech =>
        sendTechnicianOffer(tech.phone, { jobId, serviceType: service_type, lat, lng, customerName: customer_name })
      )
    );

    return res.json({
      success:          true,
      job_id:           jobId,
      offers_sent:      technicians.length,
      customer_address: customerAddress,
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/accept ───────────────────────────────────────────────── */

const acceptJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const { technician_id, technician_phone } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Resolve technician
    let techRow = null;
    if (technician_id && isValidUUID(technician_id)) {
      const r = await client.query('SELECT * FROM technicians WHERE id=$1', [technician_id]);
      techRow = r.rows[0] || null;
    } else if (technician_phone) {
      const cleanPhone = String(technician_phone).replace(/^\+?91/, '');
      const r = await client.query('SELECT * FROM technicians WHERE phone=$1', [cleanPhone]);
      techRow = r.rows[0] || null;
    }

    if (!techRow) {
      await client.query('ROLLBACK');
      throw new AppError('Technician not found', 404);
    }

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    if (job.rows[0].status !== 'JOB_CREATED') {
      await client.query('ROLLBACK');
      throw new AppError('Offer expired — another technician accepted first', 409);
    }

    const offer = await client.query(
      `SELECT * FROM job_offers WHERE job_id=$1 AND technician_id=$2 FOR UPDATE`,
      [id, techRow.id]
    );
    if (!offer.rows.length || offer.rows[0].status !== 'PENDING') {
      await client.query('ROLLBACK');
      throw new AppError('No valid pending offer found', 403);
    }

    if (techRow.status !== 'AVAILABLE') {
      await client.query('ROLLBACK');
      throw new AppError('Technician is no longer available', 400);
    }

    const minWalletBalance = await getSetting('min_wallet_balance');
    if (parseFloat(techRow.wallet_balance || 0) > minWalletBalance) {
      await client.query('ROLLBACK');
      throw new AppError('Wallet balance exceeds limit. Please clear dues before accepting jobs.', 403);
    }

    const maxActiveJobs = await getSetting('max_active_jobs');
    const activeCount   = parseInt(
      (await client.query(`
        SELECT COUNT(*) AS c FROM jobs WHERE technician_id=$1
        AND status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','WAITING_FOR_PRICE','CUSTOMER_APPROVAL_PENDING','PAYMENT_PENDING')
      `, [techRow.id])).rows[0].c, 10
    );
    if (activeCount >= maxActiveJobs) {
      await client.query('ROLLBACK');
      throw new AppError(`You already have ${activeCount} active job(s).`, 400);
    }

    await client.query(
      `UPDATE jobs SET technician_id=$1, status='ACCEPTED', updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
      [techRow.id, id]
    );
    await client.query("UPDATE technicians SET status='BUSY' WHERE id=$1", [techRow.id]);
    await client.query(
      `UPDATE job_offers SET status='ACCEPTED' WHERE job_id=$1 AND technician_id=$2`,
      [id, techRow.id]
    );
    await client.query(
      `UPDATE job_offers SET status='EXPIRED' WHERE job_id=$1 AND technician_id!=$2 AND status='PENDING'`,
      [id, techRow.id]
    );

    await client.query('COMMIT');

    await insertJobLog(id, 'ACCEPTED', 'technician', techRow.id, {});

    const jobRow = job.rows[0];

    await enqueueJobNotification('notify_customer_accepted', {
      jobId: id, customerPhone: jobRow.customer_phone,
      technicianName: techRow.name, serviceType: jobRow.service_type,
    }, `notify:accepted:${id}`);

    await enqueueJobNotification('notify_tech_contact', {
      jobId: id, technicianPhone: techRow.phone,
      customerPhone: jobRow.customer_phone, customerName: jobRow.customer_name,
    }, `notify:tech-contact:${id}`);

    await enqueueJobNotification('notify_customer_contact', {
      jobId: id, customerPhone: jobRow.customer_phone,
      technicianName: techRow.name, technicianPhone: techRow.phone,
      serviceType: jobRow.service_type,
    }, `notify:cust-contact:${id}`);

    res.json({
      success:      true,
      status:       'ACCEPTED',
      service_type: jobRow.service_type,
      customer_name: jobRow.customer_name,
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/reject-offer ────────────────────────────────────────── */

const rejectOffer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const { technician_id, technician_phone } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let techId = technician_id;
    if (!techId && technician_phone) {
      const cleanPhone = String(technician_phone).replace(/^\+?91/, '');
      const r = await client.query('SELECT id FROM technicians WHERE phone=$1', [cleanPhone]);
      techId = r.rows[0]?.id || null;
    }
    if (!techId) {
      await client.query('ROLLBACK');
      throw new AppError('technician_id or technician_phone required', 400);
    }

    await client.query(
      `UPDATE job_offers SET status='REJECTED'
       WHERE job_id=$1 AND technician_id=$2 AND status='PENDING'`,
      [id, techId]
    );

    await client.query('COMMIT');
    res.json({ success: true });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/start ────────────────────────────────────────────────── */

const startJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  let isWarrantyJob = false;

  await withTransaction(async (client) => {
    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) throw new AppError('Job not found', 404);
    if (job.rows[0].status !== 'ACCEPTED') {
      throw new AppError(`Cannot start from status: ${job.rows[0].status}`, 400);
    }
    isWarrantyJob = !!job.rows[0].is_warranty_job;
    await client.query(
      `UPDATE jobs SET status='IN_PROGRESS', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [id]
    );
  });

  res.json({ success: true, status: 'IN_PROGRESS', is_warranty_job: isWarrantyJob });
});

/* ─── POST /jobs/:id/reject (legacy — ASSIGNED job reject) ───────────────── */

const rejectJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const { technician_id } = req.body;
  if (!technician_id) throw new AppError('technician_id required', 400);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    if (job.rows[0].status !== 'ASSIGNED') {
      await client.query('ROLLBACK');
      throw new AppError('Job is not in ASSIGNED state', 400);
    }

    await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [technician_id]);

    const newTech = await findNearestTechnician(client, id, technician_id);
    if (!newTech) {
      await client.query(
        `UPDATE jobs SET status='JOB_CREATED', technician_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [id]
      );
      await client.query('COMMIT');
      return res.json({ success: true, reassigned: false, status: 'JOB_CREATED' });
    }

    await client.query(
      `UPDATE jobs SET technician_id=$1, status='ASSIGNED', updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
      [newTech.id, id]
    );
    await client.query('COMMIT');
    res.json({ success: true, reassigned: true, technician: { id: newTech.id, name: newTech.name } });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/set-price ───────────────────────────────────────────── */

const setPrice = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const { technician_id, technician_phone, price } = req.body;

  const parsedPrice = parseFloat(price);
  if (isNaN(parsedPrice) || parsedPrice < 1 || parsedPrice > 1_000_000) {
    throw new AppError('price must be a positive number (₹1 – ₹10,00,000)', 400);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let techId = technician_id;
    if (!techId && technician_phone) {
      const cleanPhone = String(technician_phone).replace(/^\+?91/, '');
      const r = await client.query('SELECT id FROM technicians WHERE phone=$1', [cleanPhone]);
      techId = r.rows[0]?.id || null;
    }
    if (!techId) {
      await client.query('ROLLBACK');
      throw new AppError('technician_id or technician_phone required', 400);
    }

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    const row = job.rows[0];

    if (row.technician_id !== techId) {
      await client.query('ROLLBACK');
      if (technician_phone) {
        await rejectTechAction(technician_phone, `❌ Job #${id.slice(0,8)} is not assigned to you. If you think this is an error, contact support.`);
      }
      throw new AppError('Not authorized for this job', 403);
    }

    if (!['ACCEPTED', 'IN_PROGRESS', 'WAITING_FOR_PRICE'].includes(row.status)) {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot set price from status: ${row.status}`, 400);
    }

    await client.query(`
      UPDATE jobs
      SET price                 = $1,
          price_set_by          = $2,
          price_set_at          = CURRENT_TIMESTAMP,
          status                = 'CUSTOMER_APPROVAL_PENDING',
          updated_at            = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [parsedPrice, techId, id]);

    await client.query('COMMIT');

    await insertJobLog(id, 'PRICE_SET', 'technician', techId, { price: parsedPrice });

    const tech = await db.query('SELECT name FROM technicians WHERE id=$1', [techId]);
    await enqueueJobNotification('notify_price_request', {
      jobId:          id,
      customerPhone:  row.customer_phone,
      price:          parsedPrice,
      serviceType:    row.service_type,
      technicianName: tech.rows[0]?.name || 'Technician',
    }, `notify:price:${id}`);

    res.json({ success: true, status: 'CUSTOMER_APPROVAL_PENDING', price: parsedPrice });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/approve-price ───────────────────────────────────────── */

const approvePrice = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const client = await db.connect();
  let row;
  try {
    await client.query('BEGIN');

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    row = job.rows[0];
    assertCustomerOwnsJob(row, req.body.customer_phone);

    if (row.status !== 'CUSTOMER_APPROVAL_PENDING') {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot approve price from status: ${row.status}`, 400);
    }
    if (!row.price || isNaN(parseFloat(row.price))) {
      await client.query('ROLLBACK');
      throw new AppError('Price has not been set — cannot approve', 400);
    }

    const price = parseFloat(row.price);

    await client.query(`
      UPDATE jobs
      SET status               = 'PAYMENT_PENDING',
          customer_approved_at = CURRENT_TIMESTAMP,
          payment_status       = 'PENDING',
          updated_at           = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [id]);

    await client.query('COMMIT');

    await insertJobLog(id, 'PRICE_APPROVED', 'customer', row.customer_phone, { price });

    res.json({ success: true, status: 'PAYMENT_PENDING', price });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Generate Razorpay link asynchronously (after response sent)
  setImmediate(async () => {
    if (!row) return;
    try {
      const price          = parseFloat(row.price);
      const expireMinutes  = await getSetting('payment_link_expire_min', 60);
      const { paymentLinkId, shortUrl } = await createPaymentLink(
        id, row.customer_phone, price, row.service_type, expireMinutes
      );

      await db.query(`
        INSERT INTO payment_links (job_id, razorpay_link_id, short_url, amount, expires_at)
        VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::INTERVAL)
        ON CONFLICT (razorpay_link_id) DO NOTHING
      `, [id, paymentLinkId, shortUrl, price, expireMinutes.toString()]);

      await db.query(
        `UPDATE jobs SET payment_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [paymentLinkId, id]
      );

      await enqueueJobNotification('notify_payment_link', {
        jobId:         id,
        customerPhone: row.customer_phone,
        paymentUrl:    shortUrl,
        amount:        price,
      }, `notify:paylink:${id}`);

    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(), ctx: '[payment][error]',
        msg: `Failed to create payment link for job=${id}`, err: err.message,
      }));
      await sendCustomerMessage(
        row.customer_phone,
        `We could not generate your payment link right now. Please contact support with Job #${id.slice(0, 8)}.`
      );
    }
  });
});

/* ─── POST /jobs/:id/reject-price ────────────────────────────────────────── */

const rejectPrice = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    const row = job.rows[0];
    assertCustomerOwnsJob(row, req.body.customer_phone);

    if (row.status !== 'CUSTOMER_APPROVAL_PENDING') {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot reject price from status: ${row.status}`, 400);
    }

    // Increment rejection count (in Redis via priceFlow.service)
    const rejectionCount = await incrementRejectionCount(id);

    await client.query(`
      UPDATE jobs
      SET status                = 'WAITING_FOR_PRICE',
          price                 = NULL,
          price_set_by          = NULL,
          price_set_at          = NULL,
          payment_status        = 'NOT_REQUIRED',
          price_rejected_count  = $2,
          updated_at            = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [id, rejectionCount]);

    await client.query('COMMIT');

    await insertJobLog(id, 'PRICE_REJECTED', 'customer', row.customer_phone, { rejectionCount });

    // Notify technician to re-quote (unless escalated — messageRouter handles escalation message)
    if (row.technician_id) {
      const tech = await db.query('SELECT phone FROM technicians WHERE id=$1', [row.technician_id]);
      const techPhone = tech.rows[0]?.phone;
      if (techPhone) {
        await sendTechnicianMessage(techPhone,
          `⚠️ Customer rejected your price for Job #${id.slice(0, 8)}.\n\n` +
          `Please reply with a revised price in rupees (e.g. *650*).\n` +
          `(Rejection ${rejectionCount} of 3)`
        );
      }
    }

    res.json({ success: true, status: 'WAITING_FOR_PRICE', rejectionCount });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/request-payment ─────────────────────────────────────── */

const requestPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    const row = job.rows[0];

    if (!['IN_PROGRESS', 'WAITING_FOR_PRICE'].includes(row.status)) {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot request payment from status: ${row.status}`, 400);
    }
    if (!row.price || isNaN(parseFloat(row.price))) {
      await client.query('ROLLBACK');
      throw new AppError('Price has not been set. Enter a price first before requesting payment.', 400);
    }

    if (row.status === 'IN_PROGRESS' && row.price) {
      await client.query(
        `UPDATE jobs SET status='CUSTOMER_APPROVAL_PENDING', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [id]
      );
      await client.query('COMMIT');
      return res.json({
        success: true,
        status:  'CUSTOMER_APPROVAL_PENDING',
        message: 'Customer must approve price first.',
      });
    }

    await client.query(
      `UPDATE jobs SET status='PAYMENT_PENDING', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [id]
    );
    await client.query('COMMIT');

    res.json({ success: true, status: 'PAYMENT_PENDING' });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── Job completion (shared logic) ──────────────────────────────────────── */

async function completeJobInTransaction(client, jobId, row) {
  const technician_id = row.technician_id;
  if (!technician_id) throw new AppError('Job has no technician', 500);

  // ── Warranty jobs: no price required, no commission, no wallet entry ──────
  if (row.is_warranty_job) {
    await client.query(
      `UPDATE jobs SET status='COMPLETED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [jobId]
    );
    await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [technician_id]);
    await insertJobLog(jobId, 'COMPLETED', 'system', null, { is_warranty_job: true });
    // Resolve the open warranty claim (if any) — runs within same transaction
    await resolveWarrantyClaim(jobId, client);
    return { earning: 0, fee: 0, visitingFee: 0, servicePrice: 0, is_warranty_job: true };
  }

  // ── Normal paid job ────────────────────────────────────────────────────────
  if (!row.price || isNaN(parseFloat(row.price))) {
    throw new AppError('Price not set — cannot complete job', 400);
  }

  const price              = parseFloat(row.price);
  const commissionPercent  = getCommission(row.service_type);
  const minCommissionAmount = await getSetting('min_commission_amount');
  const visitingFee        = await getSetting('visiting_fee', 99);

  const servicePrice = price - visitingFee;
  const rawFee       = servicePrice > 0 ? servicePrice * (commissionPercent / 100) : 0;
  const fee          = rawFee > 0 ? Math.max(rawFee, minCommissionAmount) : 0;
  const earning      = price - fee;

  const current = await getCurrentBalanceForUpdate(client, technician_id);

  await client.query(`
    INSERT INTO wallet_transactions (technician_id, job_id, type, amount, balance_after)
    VALUES ($1, $2, 'JOB_EARNING', $3, $4)
  `, [technician_id, jobId, earning, current]);

  if (fee > 0) {
    await client.query(`
      INSERT INTO wallet_transactions (technician_id, job_id, type, amount, balance_after)
      VALUES ($1, $2, 'COMMISSION_DUE', $3, $4)
    `, [technician_id, jobId, fee, current + fee]);
    await client.query(
      `UPDATE technicians SET wallet_balance = wallet_balance + $1 WHERE id=$2`,
      [fee, technician_id]
    );
  }

  await client.query(
    `UPDATE jobs SET status='COMPLETED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [jobId]
  );
  await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [technician_id]);

  await insertJobLog(jobId, 'COMPLETED', 'system', null, { price, fee, earning });

  // Issue warranty inside this transaction — rolls back with the job if it fails
  await issueWarranty(jobId, client);

  return { earning, fee, visitingFee, servicePrice };
}

/* ─── POST /jobs/:id/complete ────────────────────────────────────────────── */

const completeJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    const row = job.rows[0];

    if (row.status !== 'PAYMENT_PENDING') {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot complete from status: ${row.status}`, 400);
    }

    const result = await completeJobInTransaction(client, id, row);
    await client.query('COMMIT');

    res.json({ success: true, ...result });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/cancel (technician cancel) ──────────────────────────── */

const cancelJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const { technician_id } = req.body;
  if (!technician_id) throw new AppError('technician_id required', 400);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    const row = job.rows[0];

    if (!row.technician_id || row.technician_id !== technician_id) {
      await client.query('ROLLBACK');
      throw new AppError('Not authorized', 403);
    }
    if (['PAYMENT_PENDING', 'COMPLETED'].includes(row.status)) {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot cancel from status: ${row.status}`, 400);
    }
    if (!['ASSIGNED','ACCEPTED','IN_PROGRESS','WAITING_FOR_PRICE','CUSTOMER_APPROVAL_PENDING'].includes(row.status)) {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot cancel from status: ${row.status}`, 400);
    }

    const fine       = await getSetting('cancellation_fine');
    const current    = await getCurrentBalanceForUpdate(client, technician_id);
    const newBalance = current + fine;

    await client.query(`
      INSERT INTO wallet_transactions (technician_id, job_id, type, amount, balance_after)
      VALUES ($1, $2, 'CANCELLATION_FINE', $3, $4)
    `, [technician_id, id, fine, newBalance]);

    await client.query(
      `UPDATE technicians SET wallet_balance = wallet_balance + $1 WHERE id=$2`,
      [fine, technician_id]
    );
    await client.query(
      `UPDATE jobs SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [id]
    );
    await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [technician_id]);

    await client.query('COMMIT');
    res.json({ success: true, fine });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/customer-cancel ─────────────────────────────────────── */

const customerCancelJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    const { status, technician_id } = job.rows[0];
    assertCustomerOwnsJob(job.rows[0], req.body.customer_phone);

    if (status === 'IN_PROGRESS') {
      await client.query('ROLLBACK');
      throw new AppError('Cannot cancel a job in progress', 400);
    }
    if (!['JOB_CREATED','ASSIGNED','ACCEPTED'].includes(status)) {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot cancel from status: ${status}`, 400);
    }

    if (status === 'JOB_CREATED') {
      await client.query(
        `UPDATE job_offers SET status='EXPIRED' WHERE job_id=$1 AND status='PENDING'`,
        [id]
      );
    }
    if (['ASSIGNED','ACCEPTED'].includes(status) && technician_id) {
      await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [technician_id]);
    }
    await client.query(
      `UPDATE jobs SET status='CANCELLED', technician_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [id]
    );
    await client.query('COMMIT');

    res.json({ success: true, status: 'CANCELLED' });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /internal/watchdog-tick ───────────────────────────────────────── */

const watchdogTick = asyncHandler(async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.API_KEY) {
    throw new AppError('Unauthorized', 401);
  }
  await runTimeoutChecks();
  res.json({ success: true });
});

/* ─── POST /jobs/:id/arrived ──────────────────────────────────────────────── */
/*
 * Technician taps ARRIVED button.
 * Validates job is ACCEPTED, records arrived_at, notifies customer,
 * then moves technician's WhatsApp state to PRICE_ENTRY (done in messageRouter).
 * No job status change — status stays ACCEPTED until price is set.
 */

const arrivedJob = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const { technician_phone } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    const row = job.rows[0];

    if (row.status !== 'ACCEPTED') {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot mark arrived from status: ${row.status}`, 400);
    }

    // Verify technician owns this job
    let techRow = null;
    if (technician_phone) {
      const cleanPhone = String(technician_phone).replace(/^\+?91/, '');
      const r = await client.query('SELECT * FROM technicians WHERE phone=$1', [cleanPhone]);
      techRow = r.rows[0] || null;
    }
    if (techRow && row.technician_id !== techRow.id) {
      await client.query('ROLLBACK');
      await rejectTechAction(technician_phone, `❌ Job #${id.slice(0,8)} is not assigned to you. If you think this is an error, contact support.`);
      throw new AppError('Not authorized for this job', 403);
    }

    // Record arrival timestamp
    await client.query(
      `UPDATE jobs SET arrived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');

    await insertJobLog(id, 'TECHNICIAN_ARRIVED', 'technician', techRow?.id || null, {});

    // Notify customer their technician has arrived
    await enqueueJobNotification('notify_customer_arrived', {
      jobId:          id,
      customerPhone:  row.customer_phone,
      technicianName: techRow?.name || 'Your technician',
      serviceType:    row.service_type,
    }, `notify:arrived:${id}`);

    res.json({ success: true, status: 'ACCEPTED', message: 'Arrival recorded. Customer notified.' });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/confirm-payment ─────────────────────────────────────── */
/*
 * Customer taps PAYMENT_DONE.
 * Verifies Razorpay payment link status before advancing.
 * On verified: moves PAYMENT_PENDING → IN_PROGRESS.
 * Notifies technician with commission breakdown + MARK_DONE button.
 */

const confirmPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  // Fetch job (no row lock yet — just need payment_id to verify)
  const jobCheck = await db.query('SELECT * FROM jobs WHERE id=$1', [id]);
  if (!jobCheck.rows.length) throw new AppError('Job not found', 404);

  const row = jobCheck.rows[0];
  assertCustomerOwnsJob(row, req.body.customer_phone);

  if (row.status !== 'PAYMENT_PENDING') {
    throw new AppError(`Cannot confirm payment from status: ${row.status}`, 400);
  }

  // ── Verify with Razorpay ────────────────────────────────────────────────
  const paymentLinkId = row.payment_id;
  const { paid, reason } = await verifyPaymentLink(paymentLinkId);

  if (!paid) {
    // Return 200 so the WhatsApp handler can send a friendly retry message
    return res.json({
      success: false,
      paid:    false,
      reason:  reason || 'payment_pending',
      message: 'Payment not confirmed yet. Please wait and try again.',
    });
  }

  // ── Payment confirmed — advance to IN_PROGRESS ──────────────────────────
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Re-fetch with row lock to prevent race conditions
    const jobLocked = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    const lockedRow = jobLocked.rows[0];

    if (lockedRow.status !== 'PAYMENT_PENDING') {
      await client.query('ROLLBACK');
      // Another process already advanced — return success gracefully
      return res.json({ success: true, paid: true, status: lockedRow.status, alreadyAdvanced: true });
    }

    await client.query(`
      UPDATE jobs
      SET status                = 'IN_PROGRESS',
          payment_confirmed_at  = CURRENT_TIMESTAMP,
          payment_status        = 'PAID',
          updated_at            = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [id]);

    await client.query('COMMIT');

    await insertJobLog(id, 'PAYMENT_CONFIRMED', 'customer', lockedRow.customer_phone, { paymentLinkId });

    // Retrieve technician info for commission breakdown
    let techRow = null;
    if (lockedRow.technician_id) {
      const t = await db.query('SELECT * FROM technicians WHERE id=$1', [lockedRow.technician_id]);
      techRow = t.rows[0] || null;
    }

    // Calculate commission breakdown for tech notification
    const price             = parseFloat(lockedRow.price || 0);
    const commissionPercent = getCommission(lockedRow.service_type);
    const visitingFee       = await getSetting('visiting_fee', 99);
    const servicePrice      = Math.max(price - visitingFee, 0);
    const rawFee            = servicePrice > 0 ? servicePrice * (commissionPercent / 100) : 0;
    const minCommission     = await getSetting('min_commission_amount', 0);
    const fee               = rawFee > 0 ? Math.max(rawFee, minCommission) : 0;
    const earning           = price - fee;

    // Notify technician: payment confirmed + commission breakdown + MARK_DONE button
    if (techRow?.phone) {
      await enqueueJobNotification('notify_payment_confirmed', {
        jobId:              id,
        technicianPhone:    techRow.phone,
        customerPhone:      lockedRow.customer_phone,
        serviceType:        lockedRow.service_type,
        price,
        commissionPercent,
        visitingFee,
        fee:                Math.round(fee),
        earning:            Math.round(earning),
      }, `notify:payconf:${id}`);
    }

    return res.json({
      success: true,
      paid:    true,
      status:  'IN_PROGRESS',
      earning: Math.round(earning),
      fee:     Math.round(fee),
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── POST /jobs/:id/mark-done ───────────────────────────────────────────── */
/*
 * Technician taps MARK_DONE after completing the work.
 * Requires IN_PROGRESS status (payment already confirmed).
 * Runs completeJobInTransaction to credit wallet + set COMPLETED.
 */

const markDone = asyncHandler(async (req, res) => {
  const { id } = req.params;
  requireUUID(id, 'job ID');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError('Job not found', 404);
    }
    const row = job.rows[0];

    if (row.status !== 'IN_PROGRESS') {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot mark done from status: ${row.status}`, 400);
    }

    const result = await completeJobInTransaction(client, id, row);
    await client.query('COMMIT');

    // Notify both parties — use existing job_completed_notify handler
    const techRow = row.technician_id
      ? (await db.query('SELECT phone FROM technicians WHERE id=$1', [row.technician_id])).rows[0]
      : null;

    await enqueueJobNotification('job_completed_notify', {
      jobId:           id,
      customerPhone:   row.customer_phone,
      technicianPhone: techRow?.phone,
      serviceType:     row.service_type,
      amount:          row.price,
      earning:         result.earning,
      fee:             result.fee,
    }, `notify:done:${id}`);

    res.json({ success: true, status: 'COMPLETED', ...result });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ─── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  listJobs,
  createJob,
  acceptJob,
  rejectOffer,
  startJob,
  rejectJob,
  setPrice,
  approvePrice,
  rejectPrice,
  requestPayment,
  completeJob,
  cancelJob,
  customerCancelJob,
  arrivedJob,
  confirmPayment,
  markDone,
  watchdogTick,
  completeJobInTransaction,   // shared by payment.controller.js
};
