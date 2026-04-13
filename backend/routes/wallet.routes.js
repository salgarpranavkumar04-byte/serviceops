'use strict';

/**
 * routes/wallet.routes.js — Wallet routes (v5) NEW
 *
 * Mounted at: app.use('/wallet', authenticate, walletRouter)
 */

const express = require('express');
const {
  getWallet,
  getWalletHistory,
  walletPay,
} = require('../controllers/wallet.controller');

const router = express.Router();

router.get('/:technician_id',         getWallet);
router.get('/:technician_id/history', getWalletHistory);
router.post('/pay',                   walletPay);

module.exports = router;
