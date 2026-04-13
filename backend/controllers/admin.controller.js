'use strict';

/**
 * controllers/admin.controller.js — Admin endpoint handlers (v5 — ALIGNED)
 *
 * ADDED in alignment pass:
 *   getDashboardStats   GET  /admin/stats
 *   getSystemHealth     GET  /admin/health
 *   listAllWallets      GET  /admin/wallets
 *   walletTopup         POST /admin/wallets/topup
 *   listConversations   GET  /admin/conversations
 *   adminJobOverride    PATCH /admin/jobs/:id
 *   toggleVerified      PATCH /admin/technicians/:id/verified
 */

const db                            = require('../db/db');
const { AppError, asyncHandler }    = require('../middleware/errorHandler');
const { loadSettings, loadCommissionRules } = require('../services/settings.service');
const { geocodeAddress }            = require('../services/geocode.service');
const { getCurrentBalanceForUpdate, insertJobLog } = require('../services/dispatch.service');

function maskPhone(phone) {
  if (!phone) return '—';
  const s = String(phone);
  return s.length >= 4 ? '****' + s.slice(-4) : '****';
}

function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[admin]', msg, ...meta }));
}

const EDITABLE_SETTINGS = new Set([
  'commission_percentage', 'cancellation_fine', 'min_wallet_balance',
  'max_active_jobs', 'offer_timeout_seconds', 'max_dispatch_attempts',
  'min_commission_amount', 'visiting_fee', 'dispatch_radius_km',
  'surge_multiplier', 'surge_enabled', 'max_offers_per_wave',
  'job_accept_timeout_min', 'conv_expire_hours',
  'price_approval_timeout', 'payment_link_expire_min',
  'arrived_price_timeout_min', 'in_progress_timeout_hours',
]);

const NUMERIC_SETTINGS = new Set([
  'commission_percentage', 'cancellation_fine', 'min_wallet_balance',
  'max_active_jobs', 'offer_timeout_seconds', 'max_dispatch_attempts',
  'min_commission_amount', 'visiting_fee', 'dispatch_radius_km',
  'surge_multiplier', 'max_offers_per_wave', 'job_accept_timeout_min',
  'conv_expire_hours', 'price_approval_timeout', 'payment_link_expire_min',
  'arrived_price_timeout_min', 'in_progress_timeout_hours',
]);

const VALID_ADMIN_JOB_STATUSES = new Set([
  'JOB_CREATED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS',
  'WAITING_FOR_PRICE', 'CUSTOMER_APPROVAL_PENDING',
  'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED',
]);

function isValidUUID(id) {
  return /^[0-9a-fA-F-]{36}$/.test(id);
}

/* ── Dashboard Stats  GET /admin/stats ──────────────────────────────────── */
const getDashboardStats = asyncHandler(async (req, res) => {
  const [jobStats, techStats, revenueToday, commissionDue] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*)                                                        AS total_jobs,
        COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED')) AS active_jobs,
        COUNT(*) FILTER (WHERE status = 'PAYMENT_PENDING')             AS pending_payments,
        ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'COMPLETED') /
              NULLIF(COUNT(*), 0), 1)                                   AS completion_rate,
        COUNT(DISTINCT customer_phone)                                  AS total_customers
      FROM jobs
    `),
    db.query(`
      SELECT COUNT(*) AS total_techs,
             COUNT(*) FILTER (WHERE status = 'AVAILABLE') AS available_techs
      FROM technicians
    `),
    db.query(`
      SELECT COALESCE(SUM(price), 0) AS today_revenue
      FROM jobs
      WHERE status = 'COMPLETED' AND updated_at >= CURRENT_DATE
    `),
    db.query(`
      SELECT COALESCE(SUM(wallet_balance), 0) AS pending_commission
      FROM technicians WHERE wallet_balance > 0
    `),
  ]);

  const j = jobStats.rows[0];
  const t = techStats.rows[0];
  res.json({
    success: true,
    totalJobs:         parseInt(j.total_jobs, 10),
    activeJobs:        parseInt(j.active_jobs, 10),
    pendingPayments:   parseInt(j.pending_payments, 10),
    completionRate:    parseFloat(j.completion_rate) || 0,
    totalCustomers:    parseInt(j.total_customers, 10),
    totalTechs:        parseInt(t.total_techs, 10),
    availableTechs:    parseInt(t.available_techs, 10),
    todayRevenue:      parseFloat(revenueToday.rows[0].today_revenue) || 0,
    pendingCommission: parseFloat(commissionDue.rows[0].pending_commission) || 0,
  });
});

/* ── System Health  GET /admin/health ───────────────────────────────────── */
const getSystemHealth = asyncHandler(async (req, res) => {
  let dbOk = false, redisOk = false;
  try { await db.query('SELECT 1'); dbOk = true; } catch {}
  if (process.env.REDIS_URL) {
    try { const { isReady } = require('../queues/redisClient'); redisOk = isReady(); } catch {}
  }
  let queues = { incoming: {}, send: {}, jobs: {} };
  try {
    const q = require('../queues/queue');
    const [m, w, j] = await Promise.allSettled([
      q.messageQueue?.getJobCounts?.(),
      q.whatsappQueue?.getJobCounts?.(),
      q.jobQueue?.getJobCounts?.(),
    ]);
    queues = {
      incoming: m.status === 'fulfilled' ? m.value : {},
      send:     w.status === 'fulfilled' ? w.value : {},
      jobs:     j.status === 'fulfilled' ? j.value : {},
    };
  } catch {}
  res.json({
    success: true, status: dbOk ? 'ok' : 'degraded',
    db: dbOk, redis: redisOk,
    workers: { message: redisOk, whatsapp: redisOk, job: redisOk },
    queues, uptime: process.uptime(),
  });
});

/* ── Wallet List  GET /admin/wallets ────────────────────────────────────── */
const listAllWallets = asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT wt.id, wt.technician_id, t.name AS tech_name,
           wt.job_id, wt.type, wt.amount, wt.balance_after, wt.created_at
    FROM wallet_transactions wt
    JOIN technicians t ON t.id = wt.technician_id
    ORDER BY wt.created_at DESC LIMIT 1000
  `);
  const transactions = result.rows.map((r) => ({
    id:          r.id,
    techName:    r.tech_name,
    techId:      r.technician_id,
    jobId:       r.job_id,
    type:        r.type.toLowerCase().replace(/_/g, '-'),
    amount:      parseFloat(r.amount),
    balanceAfter: parseFloat(r.balance_after),
    createdAt:   r.created_at,
  }));
  res.json({ success: true, transactions });
});

/* ── Wallet Topup  POST /admin/wallets/topup ────────────────────────────── */
const walletTopup = asyncHandler(async (req, res) => {
  const { technicianId, technician_id, amount } = req.body;
  const techId = technicianId || technician_id;
  if (!techId)              throw new AppError('technicianId required', 400);
  if (!isValidUUID(techId)) throw new AppError('Invalid technician ID', 400);
  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || parsedAmount <= 0) throw new AppError('Invalid amount', 400);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current    = await getCurrentBalanceForUpdate(client, techId);
    const newBalance = current - parsedAmount;
    await client.query(`
      INSERT INTO wallet_transactions (technician_id, job_id, type, amount, balance_after)
      VALUES ($1, NULL, 'COMMISSION_PAYMENT', $2, $3)
    `, [techId, parsedAmount, newBalance]);
    await client.query(
      'UPDATE technicians SET wallet_balance = wallet_balance - $1, updated_at = CURRENT_TIMESTAMP WHERE id=$2',
      [parsedAmount, techId]
    );
    await client.query('COMMIT');
    res.json({ success: true, newBalance });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ── Conversations List  GET /admin/conversations ───────────────────────── */
const listConversations = asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT c.id, c.phone, c.role, c.state, c.last_message, c.updated_at,
           COALESCE(t.name, c.phone) AS name
    FROM conversations c
    LEFT JOIN technicians t ON t.phone = c.phone AND c.role = 'technician'
    WHERE c.expires_at IS NULL OR c.expires_at > CURRENT_TIMESTAMP
    ORDER BY c.updated_at DESC LIMIT 200
  `);
  const conversations = result.rows.map((r) => ({
    id:      r.id,
    phone:   r.phone,
    role:    r.role,
    state:   r.state,
    name:    r.name,
    lastMsg: r.last_message || '',
    lastAt:  r.updated_at,
    msgs:    0,
  }));
  res.json({ success: true, conversations });
});

/* ── Admin Job Override  PATCH /admin/jobs/:id ──────────────────────────── */
const adminJobOverride = asyncHandler(async (req, res) => {
  const { id }     = req.params;
  const { status } = req.body;
  if (!isValidUUID(id)) throw new AppError('Invalid job ID', 400);
  if (!status || !VALID_ADMIN_JOB_STATUSES.has(status)) {
    throw new AppError(`Invalid status. Must be one of: ${[...VALID_ADMIN_JOB_STATUSES].join(', ')}`, 400);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) { await client.query('ROLLBACK'); throw new AppError('Job not found', 404); }
    const row = job.rows[0];
    if (status === 'COMPLETED' && (!row.price || isNaN(parseFloat(row.price)))) {
      await client.query('ROLLBACK');
      throw new AppError('Cannot complete: price not set on job', 400);
    }
    if (['CANCELLED', 'COMPLETED'].includes(status) && row.technician_id) {
      await client.query(
        `UPDATE technicians SET status='AVAILABLE', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [row.technician_id]
      );
    }
    await client.query(
      `UPDATE jobs SET status=$1::job_status_enum, updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
      [status, id]
    );
    await client.query('COMMIT');

    // ── Side effects per target status (D-6) ─────────────────────────────
    if (status === 'JOB_CREATED') {
      await db.query(`UPDATE job_offers SET status='EXPIRED' WHERE job_id=$1 AND status='PENDING'`, [id]);
      try {
        const { findNearestTechnicians } = require('../services/dispatch.service');
        const cl2 = await db.connect();
        try {
          const techs = await findNearestTechnicians(cl2, id);
          for (const tech of techs) {
            await db.query(
              `INSERT INTO job_offers (job_id, technician_id, status) VALUES ($1,$2,'PENDING') ON CONFLICT DO NOTHING`,
              [id, tech.id]
            );
          }
          if (techs.length > 0) {
            const { sendTechnicianOffer } = require('../services/notification.service');
            await Promise.allSettled(techs.map(t => sendTechnicianOffer(t.phone, {
              jobId: id, serviceType: row.service_type, lat: parseFloat(row.latitude), lng: parseFloat(row.longitude), customerName: row.customer_name,
            })));
          }
        } finally { cl2.release(); }
      } catch (err) {
        logError('adminJobOverride re-dispatch failed', { err: err.message });
      }
    }

    if (['CANCELLED', 'COMPLETED'].includes(status)) {
      const { sendCustomerMessage, sendTechnicianMessage } = require('../services/notification.service');
      const { toWaPhone } = require('../services/whatsappClient');
      const actor = req.body.reason || 'admin action';
      if (row.customer_phone) {
        await sendCustomerMessage(toWaPhone(row.customer_phone),
          `Your job #${id.slice(0,8)} has been marked ${status.toLowerCase()} by support. Reason: ${actor}.`
        ).catch(() => {});
      }
      if (row.technician_id) {
        const t = await db.query('SELECT phone FROM technicians WHERE id=$1', [row.technician_id]);
        if (t.rows[0]?.phone) {
          await sendTechnicianMessage(toWaPhone(t.rows[0].phone),
            `Job #${id.slice(0,8)} has been ${status.toLowerCase()} by support.`
          ).catch(() => {});
        }
      }
    }

    await insertJobLog(id, 'ADMIN_OVERRIDE', 'admin', 'dashboard', {
      from_status: row.status,
      to_status:   status,
      reason:      req.body.reason || null,
    });

    res.json({ success: true, id, previousStatus: row.status, status });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ── Settings ────────────────────────────────────────────────────────────── */
const getSettings = asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT key, value, description, updated_at FROM system_settings ORDER BY key`
  );
  const settings = {}, meta = {};
  for (const row of result.rows) {
    settings[row.key] = row.value;
    meta[row.key]     = { description: row.description, updated_at: row.updated_at };
  }
  res.json({ success: true, settings, meta });
});

const updateSetting = asyncHandler(async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (!EDITABLE_SETTINGS.has(key)) throw new AppError(`"${key}" is not an editable setting`, 400);
  if (value === undefined || value === null || String(value).trim() === '') throw new AppError('value is required', 400);
  const strValue = String(value).trim();
  if (NUMERIC_SETTINGS.has(key)) {
    const num = parseFloat(strValue);
    if (isNaN(num) || num < 0) throw new AppError(`${key} must be a non-negative number`, 400);
  }
  if (key === 'surge_enabled' && !['true', 'false'].includes(strValue)) throw new AppError('surge_enabled must be true or false', 400);
  await db.query(`UPDATE system_settings SET value=$1, updated_at=CURRENT_TIMESTAMP WHERE key=$2`, [strValue, key]);
  await loadSettings();
  res.json({ success: true, key, value: strValue });
});

/* ── Commission ──────────────────────────────────────────────────────────── */
const getCommissionRule = asyncHandler(async (req, res) => {
  const { service_type } = req.params;
  const result = await db.query(
    `SELECT * FROM commission_rules WHERE service_type=$1 ORDER BY effective_from DESC LIMIT 1`,
    [service_type]
  );
  res.json({ success: true, rule: result.rows[0] || null });
});

const createCommissionRule = asyncHandler(async (req, res) => {
  const { service_type, commission_percentage } = req.body;
  if (!service_type || commission_percentage === undefined) throw new AppError('Missing required fields', 400);
  await db.query(
    `INSERT INTO commission_rules (service_type, commission_percentage, created_by) VALUES ($1, $2, 'admin')`,
    [service_type, commission_percentage]
  );
  await loadCommissionRules();
  res.json({ success: true });
});

/* ── Technicians ─────────────────────────────────────────────────────────── */
const listTechnicians = asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT
      t.id, t.name, t.phone, t.status, t.latitude, t.longitude,
      t.wallet_balance, t.verified, t.rating, t.created_at,
      COALESCE(ARRAY_AGG(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS skills,
      COUNT(DISTINCT j.id) FILTER (WHERE j.status = 'COMPLETED') AS completed_jobs,
      (SELECT j2.id FROM jobs j2 WHERE j2.technician_id = t.id
       AND j2.status NOT IN ('COMPLETED','CANCELLED') ORDER BY j2.created_at DESC LIMIT 1) AS active_job_id
    FROM technicians t
    LEFT JOIN technician_services ts ON ts.technician_id = t.id
    LEFT JOIN services s             ON s.id = ts.service_id
    LEFT JOIN jobs j                 ON j.technician_id = t.id
    GROUP BY t.id ORDER BY t.created_at DESC
  `);
  const technicians = result.rows.map((r) => ({
    id:            r.id,
    name:          r.name,
    phone:         r.phone,
    status:        r.status,
    walletBalance: parseFloat(r.wallet_balance) || 0,
    verified:      r.verified || false,
    rating:        r.rating ? parseFloat(r.rating).toFixed(1) : null,
    skills:        r.skills || [],
    totalJobs:     parseInt(r.completed_jobs, 10) || 0,
    activeJobId:   r.active_job_id || null,
    joinedAt:      r.created_at,
  }));
  res.json({ success: true, technicians });
});

const registerTechnician = asyncHandler(async (req, res) => {
  const { name, phone, latitude, longitude, service_types = [] } = req.body;
  if (!name || !phone) throw new AppError('name and phone are required', 400);

  // Normalize phone: strip non-digits, strip leading 91 if 12-digit
  const rawDigits = phone.trim().replace(/\D/g, '');
  const normalizedPhone = rawDigits.length === 12 && rawDigits.startsWith('91')
    ? rawDigits.slice(2)
    : rawDigits;
  if (!/^[6-9]\d{9}$/.test(normalizedPhone)) {
    throw new AppError('Invalid phone number — must be a 10-digit Indian mobile number', 400);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let lat = null, lng = null;
    if (latitude !== undefined && longitude !== undefined) {
      lat = parseFloat(latitude); lng = parseFloat(longitude);
      if (isNaN(lat) || isNaN(lng)) { await client.query('ROLLBACK'); throw new AppError('Invalid coordinates', 400); }
    } else if (req.body.address) {
      const geo = await geocodeAddress(req.body.address);
      if (geo) { lat = geo.lat; lng = geo.lng; }
    }
    const locationExpr = (lat !== null && lng !== null) ? `ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)` : 'NULL';
    const result = await client.query(`
      INSERT INTO technicians (name, phone, latitude, longitude, location)
      VALUES ($1, $2, $3, $4, ${locationExpr})
      ON CONFLICT (phone) DO NOTHING
      RETURNING id, name, phone, status
    `, [name.trim(), normalizedPhone, lat, lng]);
    if (!result.rows.length) { await client.query('ROLLBACK'); throw new AppError('Phone already registered', 409); }
    const techId = result.rows[0].id;
    if (Array.isArray(service_types) && service_types.length > 0) {
      for (const svcName of service_types) {
        await client.query(
          `INSERT INTO technician_services (technician_id, service_id) SELECT $1, id FROM services WHERE name=$2 ON CONFLICT DO NOTHING`,
          [techId, svcName.trim().toUpperCase()]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, technician: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Postgres check violation (23514) or unique violation (23505) → 400/409
    if (err.code === '23514') throw new AppError('Phone number format is invalid (DB constraint)', 400);
    if (err.code === '23505') throw new AppError('Phone already registered', 409);
    throw err;
  } finally {
    client.release();
  }
});

const deleteTechnician = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) throw new AppError('Invalid technician ID', 400);
  const result = await db.query('DELETE FROM technicians WHERE id=$1 RETURNING name', [id]);
  if (!result.rows.length) throw new AppError('Technician not found', 404);
  res.json({ success: true, message: `Technician "${result.rows[0].name}" removed.` });
});

const updateTechStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!isValidUUID(id)) throw new AppError('Invalid technician ID', 400);
  if (!status || !['AVAILABLE', 'OFFLINE'].includes(status)) throw new AppError('status must be AVAILABLE or OFFLINE', 400);
  const result = await db.query(
    `UPDATE technicians SET status=$1::technician_status_enum, updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING name, status`,
    [status, id]
  );
  if (!result.rows.length) throw new AppError('Technician not found', 404);
  res.json({ success: true, name: result.rows[0].name, status: result.rows[0].status });
});

const toggleVerified = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { verified } = req.body;
  if (!isValidUUID(id)) throw new AppError('Invalid technician ID', 400);
  if (typeof verified !== 'boolean') throw new AppError('verified must be a boolean', 400);
  const result = await db.query(
    `UPDATE technicians SET verified=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING name, verified`,
    [verified, id]
  );
  if (!result.rows.length) throw new AppError('Technician not found', 404);
  res.json({ success: true, name: result.rows[0].name, verified: result.rows[0].verified });
});

const manualAssign = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { technician_id } = req.body;
  if (!isValidUUID(id)) throw new AppError('Invalid job ID', 400);
  if (!technician_id)   throw new AppError('technician_id required', 400);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const job = await client.query('SELECT * FROM jobs WHERE id=$1', [id]);
    if (!job.rows.length) { await client.query('ROLLBACK'); throw new AppError('Job not found', 404); }
    if (!['JOB_CREATED', 'ASSIGNED'].includes(job.rows[0].status)) {
      await client.query('ROLLBACK');
      throw new AppError(`Cannot assign from status: ${job.rows[0].status}`, 400);
    }
    if (job.rows[0].status === 'ASSIGNED' && job.rows[0].technician_id && job.rows[0].technician_id !== technician_id) {
      await client.query("UPDATE technicians SET status='AVAILABLE' WHERE id=$1", [job.rows[0].technician_id]);
    }
    await client.query(
      `UPDATE jobs SET technician_id=$1, status='ASSIGNED', updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
      [technician_id, id]
    );
    await client.query(
      `UPDATE technicians SET status='BUSY', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [technician_id]
    );
    await client.query('COMMIT');
    res.json({ success: true, technician_id, status: 'ASSIGNED' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ── D-1: Stuck Jobs ─────────────────────────────────────────────────────── */
const getStuckJobs = asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT
      j.id, j.status, j.customer_name, j.customer_phone, j.service_type,
      j.price, j.updated_at, j.payment_confirmed_at, j.price_set_at,
      j.arrived_at, j.created_at,
      t.name AS technician_name, t.phone AS technician_phone,
      ROUND(EXTRACT(EPOCH FROM (NOW() - j.updated_at)) / 60) AS minutes_since_update,
      CASE
        WHEN j.status = 'PAYMENT_PENDING' AND j.updated_at < NOW() - INTERVAL '90 minutes'
          THEN 'Payment link may be expired — resend or cancel'
        WHEN j.status = 'CUSTOMER_APPROVAL_PENDING' AND j.updated_at < NOW() - INTERVAL '25 minutes'
          THEN 'Customer near price approval timeout'
        WHEN j.status = 'IN_PROGRESS' AND j.payment_confirmed_at < NOW() - INTERVAL '3 hours'
          THEN 'Job running unusually long — check with technician'
        WHEN j.status = 'ACCEPTED' AND j.arrived_at IS NOT NULL AND j.price IS NULL AND j.arrived_at < NOW() - INTERVAL '15 minutes'
          THEN 'Technician arrived but has not submitted a price'
        WHEN j.status = 'JOB_CREATED'
          AND NOT EXISTS (SELECT 1 FROM job_offers jo WHERE jo.job_id = j.id AND jo.status = 'PENDING')
          AND EXISTS     (SELECT 1 FROM job_offers jo2 WHERE jo2.job_id = j.id)
          THEN 'All offers expired — awaiting next dispatch wave'
        ELSE 'Stuck'
      END AS suggested_action
    FROM jobs j
    LEFT JOIN technicians t ON t.id = j.technician_id
    WHERE
      (j.status = 'PAYMENT_PENDING'            AND j.updated_at < NOW() - INTERVAL '90 minutes')
      OR (j.status = 'CUSTOMER_APPROVAL_PENDING' AND j.updated_at < NOW() - INTERVAL '25 minutes')
      OR (j.status = 'IN_PROGRESS'               AND j.payment_confirmed_at < NOW() - INTERVAL '3 hours')
      OR (j.status = 'ACCEPTED' AND j.arrived_at IS NOT NULL AND j.price IS NULL AND j.arrived_at < NOW() - INTERVAL '15 minutes')
      OR (j.status = 'JOB_CREATED'
          AND NOT EXISTS (SELECT 1 FROM job_offers jo WHERE jo.job_id=j.id AND jo.status='PENDING')
          AND EXISTS     (SELECT 1 FROM job_offers jo2 WHERE jo2.job_id=j.id))
    ORDER BY j.updated_at ASC
    LIMIT 50
  `);
  res.json({
    success: true,
    count:   result.rows.length,
    jobs:    result.rows.map(r => ({
      id:              r.id,
      status:          r.status,
      customerName:    r.customer_name,
      customerPhone:   maskPhone(r.customer_phone),
      serviceType:     r.service_type,
      price:           r.price ? parseFloat(r.price) : null,
      technicianName:  r.technician_name || null,
      minutesStuck:    parseInt(r.minutes_since_update, 10) || 0,
      suggestedAction: r.suggested_action,
      createdAt:       r.created_at,
      updatedAt:       r.updated_at,
    })),
  });
});

/* ── D-2: Resend notification ────────────────────────────────────────────── */
const resendNotification = asyncHandler(async (req, res) => {
  const { id }   = req.params;
  const { type } = req.body;
  if (!isValidUUID(id)) throw new AppError('Invalid job ID', 400);
  const VALID_TYPES = ['payment_link', 'price_request', 'arrival_confirmed', 'payment_confirmed'];
  if (!type || !VALID_TYPES.includes(type)) throw new AppError(`type must be one of: ${VALID_TYPES.join(', ')}`, 400);

  const job = await db.query(`
    SELECT j.*, t.phone AS tech_phone, t.name AS tech_name
    FROM jobs j LEFT JOIN technicians t ON t.id = j.technician_id WHERE j.id = $1
  `, [id]);
  if (!job.rows.length) throw new AppError('Job not found', 404);
  const row = job.rows[0];

  const { enqueueJobNotification } = require('../services/dispatch.service');

  if (type === 'payment_link') {
    if (!row.payment_id) throw new AppError('No payment link exists for this job', 400);
    await enqueueJobNotification('notify_payment_link', {
      jobId: id, customerPhone: row.customer_phone,
      paymentUrl: row.payment_url || `https://rzp.io/l/${row.payment_id}`, amount: row.price,
    }, `resend:payment_link:${id}:${Date.now()}`);
  }
  if (type === 'price_request') {
    if (!row.price) throw new AppError('No price set on this job', 400);
    await enqueueJobNotification('notify_price_request', {
      jobId: id, customerPhone: row.customer_phone, price: row.price,
      serviceType: row.service_type, technicianName: row.tech_name || 'Your technician',
    }, `resend:price_request:${id}:${Date.now()}`);
  }
  if (type === 'arrival_confirmed') {
    await enqueueJobNotification('notify_customer_arrived', {
      jobId: id, customerPhone: row.customer_phone,
      technicianName: row.tech_name || 'Your technician', serviceType: row.service_type,
    }, `resend:arrived:${id}:${Date.now()}`);
  }
  if (type === 'payment_confirmed') {
    if (!row.tech_phone) throw new AppError('No technician assigned', 400);
    const { getCommission, getSetting } = require('../services/settings.service');
    const price = parseFloat(row.price || 0);
    const commissionPercent = getCommission(row.service_type);
    const visitingFee = parseFloat(await getSetting('visiting_fee', 99));
    const servicePrice = Math.max(price - visitingFee, 0);
    const minComm = parseFloat(await getSetting('min_commission_amount', 0));
    const fee = servicePrice > 0 ? Math.max(servicePrice * commissionPercent / 100, minComm) : 0;
    await enqueueJobNotification('notify_payment_confirmed', {
      jobId: id, technicianPhone: row.tech_phone, serviceType: row.service_type,
      price, commissionPercent, visitingFee, fee: Math.round(fee), earning: Math.round(price - fee),
    }, `resend:payconf:${id}:${Date.now()}`);
  }

  await insertJobLog(id, 'ADMIN_RESEND', 'admin', 'dashboard', { type });
  res.json({ success: true, type, jobId: id });
});

/* ── D-3: Force cancel ───────────────────────────────────────────────────── */
const forceCancel = asyncHandler(async (req, res) => {
  const { id }     = req.params;
  const { reason } = req.body;
  if (!isValidUUID(id)) throw new AppError('Invalid job ID', 400);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const job = await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job.rows.length) { await client.query('ROLLBACK'); throw new AppError('Job not found', 404); }
    const row = job.rows[0];

    if (['COMPLETED', 'CANCELLED'].includes(row.status)) {
      await client.query('ROLLBACK');
      throw new AppError(`Job is already ${row.status}`, 400);
    }
    if (row.technician_id) {
      await client.query(`UPDATE technicians SET status='AVAILABLE' WHERE id=$1`, [row.technician_id]);
    }
    await client.query(`UPDATE jobs SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [id]);
    await client.query(`UPDATE job_offers SET status='EXPIRED' WHERE job_id=$1 AND status='PENDING'`, [id]);
    await client.query('COMMIT');

    await insertJobLog(id, 'ADMIN_FORCE_CANCEL', 'admin', 'dashboard', { reason: reason || null, from_status: row.status });

    const { sendCustomerMessage, sendTechnicianMessage } = require('../services/notification.service');
    const { toWaPhone } = require('../services/whatsappClient');
    const reasonNote = reason ? ` Reason: ${reason}.` : '';

    if (row.customer_phone) {
      await sendCustomerMessage(toWaPhone(row.customer_phone),
        `❌ Your job #${id.slice(0,8)} has been cancelled by support.${reasonNote}`
      ).catch(() => {});
    }
    if (row.technician_id) {
      const t = await db.query('SELECT phone FROM technicians WHERE id=$1', [row.technician_id]);
      if (t.rows[0]?.phone) {
        await sendTechnicianMessage(toWaPhone(t.rows[0].phone),
          `❌ Job #${id.slice(0,8)} has been cancelled by support.${reasonNote} You are now available.`
        ).catch(() => {});
      }
    }
    res.json({ success: true, id, status: 'CANCELLED', fromStatus: row.status });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ── D-4: Send message to technician ─────────────────────────────────────── */
const sendTechMessage = asyncHandler(async (req, res) => {
  const { id }      = req.params;
  const { message } = req.body;
  if (!isValidUUID(id)) throw new AppError('Invalid technician ID', 400);
  if (!message || String(message).trim().length === 0) throw new AppError('message is required', 400);
  if (String(message).length > 1000) throw new AppError('message too long (max 1000 chars)', 400);

  const result = await db.query('SELECT phone, name FROM technicians WHERE id=$1', [id]);
  if (!result.rows.length) throw new AppError('Technician not found', 404);

  const { sendTechnicianMessage } = require('../services/notification.service');
  const { toWaPhone } = require('../services/whatsappClient');
  await sendTechnicianMessage(toWaPhone(result.rows[0].phone), `📢 Admin message:\n\n${message.trim()}`);

  res.json({ success: true, technician: result.rows[0].name, message: message.trim() });
});

/* ── D-5: DLQ visibility ─────────────────────────────────────────────────── */
const getDLQJobs = asyncHandler(async (req, res) => {
  let QUEUE_NAMES, createDLQ;
  try {
    ({ QUEUE_NAMES, createDLQ } = require('../queues/queue'));
  } catch {
    return res.json({ success: true, total: 0, jobs: [], error: 'Queue module unavailable' });
  }
  const dlqSources = [
    QUEUE_NAMES?.INCOMING_MESSAGES || 'incoming_messages',
    QUEUE_NAMES?.WHATSAPP_SEND     || 'whatsapp_send',
    QUEUE_NAMES?.JOB_PROCESSING    || 'job_processing',
  ];
  const results = [];
  for (const queueBaseName of dlqSources) {
    try {
      const q      = createDLQ(queueBaseName);
      const failed = await q.getFailed(0, 49);
      for (const job of failed) {
        results.push({
          queue: queueBaseName + '_dlq', id: job.id, name: job.name,
          failedReason: job.failedReason, attemptsMade: job.attemptsMade,
          data: job.data, timestamp: job.timestamp, processedOn: job.processedOn,
        });
      }
      await q.close();
    } catch (err) {
      results.push({ queue: queueBaseName + '_dlq', error: err.message });
    }
  }
  results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  res.json({ success: true, total: results.length, jobs: results });
});

const retryDLQJob = asyncHandler(async (req, res) => {
  const { queue: queueBaseName, jobId } = req.body;
  if (!queueBaseName || !jobId) throw new AppError('queue and jobId are required', 400);
  const { createDLQ } = require('../queues/queue');
  const q   = createDLQ(queueBaseName.replace('_dlq', ''));
  const job = await q.getJob(jobId);
  if (!job) { await q.close(); throw new AppError('Job not found in DLQ', 404); }
  await job.retry();
  await q.close();
  res.json({ success: true, jobId, queue: queueBaseName });
});

module.exports = {
  getDashboardStats, getSystemHealth,
  listAllWallets, walletTopup,
  listConversations, adminJobOverride,
  toggleVerified,
  getSettings, updateSetting,
  getCommissionRule, createCommissionRule,
  listTechnicians, registerTechnician, deleteTechnician, updateTechStatus,
  manualAssign,
  getStuckJobs, resendNotification, forceCancel, sendTechMessage,
  getDLQJobs, retryDLQJob,
};
