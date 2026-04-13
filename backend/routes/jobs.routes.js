'use strict';

/**
 * routes/jobs.routes.js — Job lifecycle routes (v5) NEW
 *
 * Mounted at: app.use('/jobs', authenticate, jobsRouter)
 *             app.use('/internal', internalRouter)   ← watchdog-tick
 *
 * All handlers live in controllers/jobs.controller.js.
 * Rate limiters are applied per-route where needed.
 */

const express = require('express');
const {
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
} = require('../controllers/jobs.controller');

const {
  createJobLimiter,
  pricingLimiter,
} = require('../middleware/rateLimiters');

/* ─── Jobs router ─────────────────────────────────────────────────────────── */

const router = express.Router();

router.get('/',                          listJobs);
router.post('/create', createJobLimiter, createJob);
router.post('/:id/accept',               acceptJob);
router.post('/:id/reject-offer',         rejectOffer);
router.post('/:id/start',                startJob);
router.post('/:id/reject',               rejectJob);
router.post('/:id/set-price',    pricingLimiter, setPrice);
router.post('/:id/approve-price', pricingLimiter, approvePrice);
router.post('/:id/reject-price',  pricingLimiter, rejectPrice);
router.post('/:id/request-payment',      requestPayment);
router.post('/:id/complete',             completeJob);
router.post('/:id/cancel',               cancelJob);
router.post('/:id/customer-cancel',      customerCancelJob);
// ── New price-flow endpoints ──────────────────────────────────────────────
router.post('/:id/arrived',              arrivedJob);
router.post('/:id/confirm-payment',      confirmPayment);
router.post('/:id/mark-done',            markDone);

/* ─── Internal router (watchdog) — mounted separately without authenticate ── */

const internalRouter = express.Router();
internalRouter.post('/watchdog-tick', watchdogTick);

module.exports = { router, internalRouter };
