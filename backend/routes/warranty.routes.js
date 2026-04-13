'use strict';

/**
 * routes/warranty.routes.js
 *
 * Mounted at: app.use('/warranty', authenticate, warrantyRouter)
 *
 * All routes require the x-api-key header (via authenticate middleware).
 */

const express = require('express');
const {
  getWarrantyByJob,
  getWarrantiesByCustomer,
  voidWarrantyHandler,
  listClaims,
  getClaimById,
  expireStale,
} = require('../controllers/warranty.controller');

const router = express.Router();

/* ─── Read ───────────────────────────────────────────────────────────────── */

router.get('/job/:jobId',         getWarrantyByJob);
router.get('/customer/:phone',    getWarrantiesByCustomer);
router.get('/claims',             listClaims);
router.get('/claims/:id',         getClaimById);

/* ─── Write ──────────────────────────────────────────────────────────────── */

router.post('/:id/void',          voidWarrantyHandler);
router.post('/expire-stale',      expireStale);

module.exports = router;
