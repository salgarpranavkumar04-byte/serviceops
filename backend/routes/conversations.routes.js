'use strict';

/**
 * routes/conversations.routes.js — Conversation routes (v5) NEW
 *
 * Mounted at: app.use('/conversations', authenticate, conversationsRouter)
 *
 * Single source of truth for conversation endpoints.
 */

const express = require('express');
const {
  getConversation,
  upsertConversation,
} = require('../controllers/conversations.controller');

const router = express.Router();

router.get('/:phone',   getConversation);
router.post('/upsert',  upsertConversation);

module.exports = router;
