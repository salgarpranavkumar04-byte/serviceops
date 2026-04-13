'use strict';

/**
 * services/settings.service.js — System settings cache (v5) NEW
 *
 * Extracted from server.js. Single source of truth for system_settings
 * and commission_rules.
 *
 * Provides:
 *   loadSettings()           — refresh in-memory settings cache from DB
 *   loadCommissionRules()    — refresh commission rules from DB
 *   getSetting(key, fallback)— read a setting (cache → DB → default)
 *   getCommission(svcType)   — get commission % for a service type
 *
 * Used by: jobs.controller.js, payment.controller.js, dispatch.service.js
 */

const db = require('../db/db');

/* ─── Defaults ────────────────────────────────────────────────────────────── */

const SETTING_DEFAULTS = {
  commission_percentage:   12,
  cancellation_fine:       100,
  min_wallet_balance:      500,
  max_active_jobs:         1,
  offer_timeout_seconds:   45,
  max_dispatch_attempts:   3,
  min_commission_amount:   20,
  job_accept_timeout_min:  2,
  conv_expire_hours:       2,
  dispatch_radius_km:      10,
  max_offers_per_wave:     3,
  visiting_fee:            99,
  surge_multiplier:        1.0,
  price_approval_timeout:  30,
  payment_link_expire_min: 60,
  arrived_price_timeout_min: 30,
  in_progress_timeout_hours: 6,
};

/* ─── In-memory caches ────────────────────────────────────────────────────── */

let settingsCache   = {};
let commissionCache = {};

/* ─── Load helpers ────────────────────────────────────────────────────────── */

async function loadSettings() {
  try {
    const result = await db.query('SELECT key, value FROM system_settings');
    settingsCache = {};
    for (const row of result.rows) {
      settingsCache[row.key] = row.value;
    }
    console.log(JSON.stringify({
      ts:   new Date().toISOString(),
      ctx:  '[settings]',
      msg:  `Loaded ✓`,
      keys: Object.keys(settingsCache).length,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      ts:  new Date().toISOString(),
      ctx: '[settings][error]',
      msg: 'Failed to load settings — using defaults',
      err: err.message,
    }));
  }
}

async function loadCommissionRules() {
  try {
    const result = await db.query(
      'SELECT service_type, commission_percentage FROM commission_rules'
    );
    commissionCache = {};
    result.rows.forEach(r => {
      commissionCache[r.service_type] = parseFloat(r.commission_percentage);
    });
    console.log(JSON.stringify({
      ts:    new Date().toISOString(),
      ctx:   '[settings]',
      msg:   'Commission rules loaded ✓',
      count: result.rows.length,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      ts:  new Date().toISOString(),
      ctx: '[settings][error]',
      msg: 'Commission load failed',
      err: err.message,
    }));
  }
}

/* ─── Read helpers ────────────────────────────────────────────────────────── */

/**
 * Returns a parsed numeric value for a system setting.
 * Priority: in-memory cache → DB lookup → provided fallback → SETTING_DEFAULTS
 *
 * @param {string} key
 * @param {number} [fallback]
 * @returns {Promise<number>}
 */
async function getSetting(key, fallback) {
  const def = fallback !== undefined ? fallback : (SETTING_DEFAULTS[key] ?? null);

  if (settingsCache[key] !== undefined) {
    const v = parseFloat(settingsCache[key]);
    return isNaN(v) ? def : v;
  }

  try {
    const result = await db.query(
      'SELECT value FROM system_settings WHERE key = $1', [key]
    );
    if (result.rows.length > 0) {
      settingsCache[key] = result.rows[0].value;
      const v = parseFloat(result.rows[0].value);
      return isNaN(v) ? def : v;
    }
  } catch (err) {
    console.error(JSON.stringify({
      ts:  new Date().toISOString(),
      ctx: '[settings][error]',
      msg: `getSetting("${key}") DB fallback failed`,
      err: err.message,
    }));
  }

  return def;
}

/**
 * Returns the commission percentage for a service type.
 * Falls back to 'default' rule, then to 12%.
 *
 * @param {string} serviceType
 * @returns {number}
 */
function getCommission(serviceType) {
  return commissionCache[serviceType]
    ?? commissionCache['default']
    ?? 12;
}

/**
 * Get raw string value of a setting (for non-numeric like surge_enabled).
 * Returns null if not found.
 *
 * @param {string} key
 * @returns {string|null}
 */
function getSettingRaw(key) {
  return settingsCache[key] ?? null;
}

module.exports = {
  loadSettings,
  loadCommissionRules,
  getSetting,
  getCommission,
  getSettingRaw,
  SETTING_DEFAULTS,
};
