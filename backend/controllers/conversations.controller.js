'use strict';

/**
 * controllers/conversations.controller.js — Conversation CRUD (v5) NEW
 *
 * Handles:
 *   getConversation  GET  /conversations/:phone
 *   upsertConversation POST /conversations/upsert
 */

const db                         = require('../db/db');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { getSetting }             = require('../services/settings.service');

const VALID_CONV_STATES = new Set([
  'idle', 'service_selected', 'name_requested', 'location_received',
  'awaiting_price_approval', 'price_entry', 'completed',
]);

/* ─── GET /conversations/:phone ───────────────────────────────────────────── */

const getConversation = asyncHandler(async (req, res) => {
  const { phone } = req.params;
  if (!phone?.trim()) throw new AppError('phone is required', 400);

  const result = await db.query(`
    SELECT id, phone, role, state, context, step, last_message, expires_at, updated_at
    FROM conversations
    WHERE phone = $1 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    ORDER BY updated_at DESC LIMIT 1
  `, [phone.trim()]);

  res.json({ success: true, conversation: result.rows[0] || null });
});

/* ─── POST /conversations/upsert ─────────────────────────────────────────── */

const upsertConversation = asyncHandler(async (req, res) => {
  const { phone, state, context } = req.body;

  if (!phone || typeof phone !== 'string' || !phone.trim()) {
    throw new AppError('phone is required', 400);
  }
  if (!state || !VALID_CONV_STATES.has(state)) {
    throw new AppError(`state must be one of: ${[...VALID_CONV_STATES].join(', ')}`, 400);
  }
  if (context !== undefined && (typeof context !== 'object' || Array.isArray(context))) {
    throw new AppError('context must be a JSON object', 400);
  }

  const expireHours = await getSetting('conv_expire_hours', 2);

  await db.query(`
    INSERT INTO conversations (phone, role, state, step, context, expires_at, updated_at)
    VALUES ($1, 'customer', $2::conv_state_enum, $2, $3::jsonb,
            CURRENT_TIMESTAMP + ($4 || ' hours')::INTERVAL, CURRENT_TIMESTAMP)
    ON CONFLICT (phone) DO UPDATE SET
      state      = EXCLUDED.state,
      step       = EXCLUDED.step,
      context    = CASE
                     WHEN $3::jsonb = '{}'::jsonb THEN '{}'::jsonb
                     ELSE COALESCE(conversations.context, '{}') || $3::jsonb
                   END,
      expires_at = CURRENT_TIMESTAMP + ($4 || ' hours')::INTERVAL,
      updated_at = CURRENT_TIMESTAMP
  `, [phone.trim(), state, JSON.stringify(context || {}), expireHours.toString()]);

  res.json({ success: true });
});

module.exports = { getConversation, upsertConversation };
