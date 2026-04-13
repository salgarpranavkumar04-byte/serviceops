'use strict';

/**
 * workers/jobWorker.js — Async job lifecycle event consumer (v4)
 *
 * Processes jobs from job_processing_queue:
 *
 *   JOB TYPES:
 *     • notify_customer_accepted  — Customer told their tech has accepted
 *     • notify_tech_contact       — Send customer phone to technician (contact share)
 *     • notify_customer_contact   — Send tech details to customer (contact share)
 *     • notify_price_request      — Customer receives price quote with APPROVE buttons
 *     • notify_payment_link       — Customer receives Razorpay payment link
 *     • job_completed_notify      — Both parties told job is done
 *     • watchdog_check            — Periodic timeout check (replaces setInterval in server.js)
 *
 * Run standalone:
 *   node workers/jobWorker.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Worker }   = require('bullmq');
const { createBullMQConnection, closeRedis } = require('../queues/redisClient');
const { QUEUE_NAMES, createDLQ, safeEnqueue } = require('../queues/queue');
const { sendText, sendButtons } = require('../services/whatsappClient');
const { closePool }             = require('../db/db');
const { safePost }              = require('../services/apiClient');

/* ─── Structured logger ───────────────────────────────────────────────────── */

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[jobWorker]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[jobWorker][error]', msg, ...meta }));
}

/* ─── Job handlers ────────────────────────────────────────────────────────── */

async function handleNotifyCustomerAccepted({ jobId, customerPhone, technicianName, serviceType }) {
  if (!customerPhone) return;
  const shortId = jobId ? jobId.slice(0, 8) : '?';
  await sendText(
    customerPhone,
    `✅ *Your technician is on the way!*\n\n` +
    `Technician: *${technicianName || 'Our technician'}*\n` +
    `Service: *${serviceType}*\n` +
    `Job #${shortId}\n\n` +
    `They will contact you shortly.`
  );
  log('Customer accepted notification sent', { jobId, customerPhone: customerPhone.slice(-4) });
}

async function handleNotifyTechContact({ jobId, technicianPhone, customerPhone, customerName }) {
  if (!technicianPhone) return;
  await sendText(
    technicianPhone,
    `📞 *Customer Contact Info*\n\n` +
    `Job #${jobId ? jobId.slice(0, 8) : '?'}\n` +
    `Customer: *${customerName || 'Customer'}*\n` +
    `Phone: *${customerPhone || 'N/A'}*\n\n` +
    `You can call or message them directly.`
  );
  log('Tech contact notification sent', { jobId, technicianPhone: technicianPhone.slice(-4) });
}

async function handleNotifyCustomerContact({ jobId, customerPhone, technicianName, technicianPhone, serviceType }) {
  if (!customerPhone) return;
  await sendText(
    customerPhone,
    `🔧 *Technician Details*\n\n` +
    `Job #${jobId ? jobId.slice(0, 8) : '?'}\n` +
    `Name:  *${technicianName || 'Your technician'}*\n` +
    `Phone: *${technicianPhone || 'N/A'}*\n` +
    `Service: *${serviceType}*\n\n` +
    `Feel free to contact them directly.`
  );
  log('Customer contact notification sent', { jobId, customerPhone: customerPhone.slice(-4) });
}

async function handleNotifyPriceRequest({ jobId, customerPhone, price, serviceType, technicianName }) {
  if (!customerPhone || price == null) return;
  const formattedPrice = Number(price).toLocaleString('en-IN');

  await sendButtons(
    customerPhone,
    `💰 *Price Quote*\n\n` +
    `Technician *${technicianName || 'Our technician'}* has assessed your\n` +
    `*${serviceType}* issue and quoted:\n\n` +
    `*₹${formattedPrice}*\n\n` +
    `This includes inspection + service charges. Do you approve?`,
    [
      { id: `APPROVE_PRICE:${jobId}`, title: 'Approve & Pay' },
      { id: `REJECT_PRICE:${jobId}`,  title: 'Reject Price'  },
    ],
    'Price Approval Required'
  );
  log('Price request notification sent', { jobId, customerPhone: customerPhone.slice(-4), price });
}

async function handleNotifyPaymentLink({ jobId, customerPhone, paymentUrl, amount }) {
  if (!customerPhone || !paymentUrl) return;
  const formattedAmount = Number(amount).toLocaleString('en-IN');

  await sendText(
    customerPhone,
    `💳 *Payment Link*\n\n` +
    `Job #${jobId ? jobId.slice(0, 8) : '?'}\n` +
    `Amount: *₹${formattedAmount}*\n\n` +
    `Pay securely via Razorpay:\n${paymentUrl}\n\n` +
    `This link expires in 60 minutes. The technician will complete the job once payment is confirmed.`
  );
  log('Payment link notification sent', { jobId, customerPhone: customerPhone.slice(-4), amount });
}

async function handleJobCompletedNotify({ jobId, customerPhone, technicianPhone, serviceType, amount }) {
  const shortId = jobId ? jobId.slice(0, 8) : '?';
  const notifications = [];

  if (customerPhone) {
    notifications.push(sendText(
      customerPhone,
      `✅ *Job Completed!*\n\n` +
      `Job #${shortId}\n` +
      `Service: *${serviceType}*\n` +
      `Amount: *₹${Number(amount || 0).toLocaleString('en-IN')}*\n\n` +
      `Thank you for using ServiceOps! Please rate your experience by replying to this message.`
    ));
  }

  if (technicianPhone) {
    notifications.push(sendText(
      technicianPhone,
      `✅ *Job #${shortId} marked as COMPLETED.*\n\n` +
      `Service: *${serviceType}*\n` +
      `Earnings will reflect in your wallet shortly.\n\n` +
      `Great work! You are now AVAILABLE for new jobs.`
    ));
  }

  await Promise.allSettled(notifications);
  log('Completion notifications sent', { jobId });
}

/**
 * notify_warranty_issued — sends the warranty message with CLAIM_WARRANTY button
 * to the customer immediately after job completion.
 *
 * Enqueued by completeJobInTransaction (via issueWarranty) with a short delay
 * so it arrives AFTER the standard "Job Completed" message.
 */
async function handleNotifyWarrantyIssued({ jobId, customerPhone, serviceType, expiresAt, warrantyDays }) {
  if (!customerPhone) return;

  const shortId    = jobId ? jobId.slice(0, 8) : '?';
  const expiryDate = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
      })
    : `${warrantyDays || 30} days`;

  await sendButtons(
    customerPhone,
    `🛡️ *${warrantyDays || 30}-day warranty active*\n\n` +
    `Job #${shortId} · ${serviceType || 'Service'}\n\n` +
    `If the same issue recurs before *${expiryDate}*, your revisit is completely free.\n` +
    `Tap below to raise a claim any time.`,
    [
      { id: `CLAIM_WARRANTY:${jobId}`, title: 'Claim warranty' },
    ]
  );

  log('Warranty issued notification sent', { jobId, customerPhone: customerPhone.slice(-4), expiresAt });
}

async function handleWatchdogCheck() {
  // Delegate to the server's internal watchdog endpoint
  const { error } = await safePost('/internal/watchdog-tick', {}, 'jobWorker');
  if (error) {
    logError('Watchdog tick failed', { error });
    throw new Error(`watchdog_failed: ${error}`);
  }
  log('Watchdog tick dispatched');
}

/* ─── Router ──────────────────────────────────────────────────────────────── */

const HANDLERS = {
  notify_customer_accepted: handleNotifyCustomerAccepted,
  notify_tech_contact:      handleNotifyTechContact,
  notify_customer_contact:  handleNotifyCustomerContact,
  notify_price_request:     handleNotifyPriceRequest,
  notify_payment_link:      handleNotifyPaymentLink,
  job_completed_notify:     handleJobCompletedNotify,
  notify_warranty_issued:   handleNotifyWarrantyIssued,
  watchdog_check:           handleWatchdogCheck,
};

async function processJob(job) {
  const { name, data } = job;
  log(`Processing: ${name}`, { jobId: job.id });

  const handler = HANDLERS[name];
  if (!handler) {
    logError(`Unknown job type: ${name}`, { jobId: job.id });
    return; // Don't retry unknown types
  }

  await handler(data || {});
}

/* ─── Worker lifecycle ────────────────────────────────────────────────────── */

const CONCURRENCY = parseInt(process.env.JOB_WORKER_CONCURRENCY || '5', 10);

let _dlq    = null;
let _worker = null;

function getDLQ() {
  if (!_dlq) _dlq = createDLQ(QUEUE_NAMES.JOB_PROCESSING);
  return _dlq;
}

function startWorker() {
  const connection = createBullMQConnection();

  _worker = new Worker(
    QUEUE_NAMES.JOB_PROCESSING,
    processJob,
    { connection, concurrency: CONCURRENCY }
  );

  _worker.on('failed', (job, err) => {
    if (job.attemptsMade >= (job.opts?.attempts || 5)) {
      logError('Job exhausted retries — routing to DLQ', {
        jobId: job.id, type: job.name, err: err.message,
      });
      safeEnqueue(getDLQ(), job.name, {
        ...job.data,
        error:       err.message,
        exhaustedAt: new Date().toISOString(),
      }, `dlq:job:${job.id}`).catch(() => {});
    }
  });

  _worker.on('error', (err) => logError('Worker error', { err: err.message }));

  log(`Started ✓  concurrency=${CONCURRENCY}`);
  return _worker;
}

/* ─── Graceful shutdown ───────────────────────────────────────────────────── */

async function shutdown(signal) {
  log(`Received ${signal} — shutting down`);
  try {
    if (_worker) { await _worker.close(); log('Worker closed ✓'); }
    await closeRedis();
    await closePool();
  } catch (err) {
    logError('Shutdown error', { err: err.message });
  }
  process.exit(0);
}

if (require.main === module) {
  startWorker();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logError('Uncaught exception', { err: err.message });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logError('Unhandled rejection', { reason: String(reason) });
  });
}

module.exports = { startWorker };
