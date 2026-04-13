'use strict';

/**
 * routes/admin.routes.js — Admin routes (v6 — dual-key auth)
 *
 * Mounted at: app.use('/admin', authenticate, adminRouter)
 * Read-only routes accept both API_KEY and ADMIN_READ_KEY.
 * Write routes require requireWrite (API_KEY only).
 */

const express = require('express');
const {
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
} = require('../controllers/admin.controller');

const { adminLimiter }          = require('../middleware/rateLimiters');
const { requireWrite }          = require('../middleware/authenticate');

const router = express.Router();

/* ─── Read-only routes — any valid key ──────────────────────────────────── */
router.get('/stats',           adminLimiter, getDashboardStats);
router.get('/health',          adminLimiter, getSystemHealth);
router.get('/settings',        adminLimiter, getSettings);
router.get('/wallets',         adminLimiter, listAllWallets);
router.get('/conversations',   adminLimiter, listConversations);
router.get('/technicians',     adminLimiter, listTechnicians);
router.get('/jobs/stuck',      adminLimiter, getStuckJobs);
router.get('/queues/dlq',      adminLimiter, getDLQJobs);

/* ─── Commission rules ─────────────────────────────────────────────────── */
router.get('/commission-rule/:service_type', adminLimiter, getCommissionRule);

/* ─── Write routes — write key only ─────────────────────────────────────── */
router.patch('/settings/:key',               adminLimiter, requireWrite, updateSetting);
router.post('/commission-rule',              adminLimiter, requireWrite, createCommissionRule);
router.post('/wallets/topup',               adminLimiter, requireWrite, walletTopup);

router.post('/jobs/:id/assign',              adminLimiter, requireWrite, manualAssign);
router.patch('/jobs/:id',                    adminLimiter, requireWrite, adminJobOverride);
router.post('/jobs/:id/resend-notification', adminLimiter, requireWrite, resendNotification);
router.post('/jobs/:id/force-cancel',        adminLimiter, requireWrite, forceCancel);

router.post('/technicians/register',         adminLimiter, requireWrite, registerTechnician);
router.delete('/technicians/:id',            adminLimiter, requireWrite, deleteTechnician);
router.patch('/technicians/:id/status',      adminLimiter, requireWrite, updateTechStatus);
router.patch('/technicians/:id/verified',    adminLimiter, requireWrite, toggleVerified);
router.post('/technicians/:id/message',      adminLimiter, requireWrite, sendTechMessage);

router.post('/queues/dlq/retry',             adminLimiter, requireWrite, retryDLQJob);

module.exports = router;
