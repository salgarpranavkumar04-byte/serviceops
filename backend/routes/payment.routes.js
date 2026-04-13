'use strict';

/**
 * routes/payment.routes.js — Payment webhook route (v5) NEW
 *
 * Mounted at: app.use('/payment', paymentRouter)
 * No authentication — Razorpay calls this endpoint directly.
 * Security is enforced via HMAC-SHA256 signature verification inside the controller.
 */

const express = require('express');
const { handleWebhook } = require('../controllers/payment.controller');

const router = express.Router();

router.post('/webhook', handleWebhook);

module.exports = router;
