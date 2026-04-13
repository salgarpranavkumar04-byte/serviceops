'use strict';

/**
 * controllers/wallet.controller.js — Wallet endpoints (v5) NEW
 */

const db                         = require('../db/db');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { getSetting }             = require('../services/settings.service');
const { getCurrentBalanceForUpdate } = require('../services/dispatch.service');

function isValidUUID(id) {
  return /^[0-9a-fA-F-]{36}$/.test(id);
}

/* ─── GET /wallet/:technician_id ─────────────────────────────────────────── */

const getWallet = asyncHandler(async (req, res) => {
  const { technician_id } = req.params;
  if (!isValidUUID(technician_id)) throw new AppError('Invalid technician ID', 400);

  const result = await db.query(
    'SELECT wallet_balance FROM technicians WHERE id=$1', [technician_id]
  );
  if (!result.rows.length) throw new AppError('Technician not found', 404);

  const total_due        = parseFloat(result.rows[0].wallet_balance);
  const minWalletBalance = await getSetting('min_wallet_balance');

  res.json({
    success: true,
    wallet: {
      technician_id,
      total_due,
      status: total_due > minWalletBalance ? 'BLOCKED' : 'ACTIVE',
    },
  });
});

/* ─── GET /wallet/:technician_id/history ─────────────────────────────────── */

const getWalletHistory = asyncHandler(async (req, res) => {
  const { technician_id } = req.params;
  if (!isValidUUID(technician_id)) throw new AppError('Invalid technician ID', 400);

  const result = await db.query(`
    SELECT job_id, type, amount, balance_after, created_at
    FROM wallet_transactions WHERE technician_id=$1 ORDER BY created_at DESC
  `, [technician_id]);

  res.json({ success: true, transactions: result.rows });
});

/* ─── POST /wallet/pay ───────────────────────────────────────────────────── */

const walletPay = asyncHandler(async (req, res) => {
  const { technician_id, amount } = req.body;

  if (!technician_id) throw new AppError('technician_id required', 400);
  if (!isValidUUID(technician_id)) throw new AppError('Invalid technician ID', 400);

  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || parsedAmount <= 0) throw new AppError('Invalid amount', 400);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const current    = await getCurrentBalanceForUpdate(client, technician_id);
    const newBalance = current - parsedAmount;

    await client.query(`
      INSERT INTO wallet_transactions (technician_id, job_id, type, amount, balance_after)
      VALUES ($1, NULL, 'COMMISSION_PAYMENT', $2, $3)
    `, [technician_id, parsedAmount, newBalance]);

    await client.query(
      'UPDATE technicians SET wallet_balance = wallet_balance - $1 WHERE id=$2',
      [parsedAmount, technician_id]
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

module.exports = { getWallet, getWalletHistory, walletPay };
