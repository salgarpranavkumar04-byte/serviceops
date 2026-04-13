'use strict';

/**
 * config/validateEnv.js — Environment variable validation (v5)
 *
 * CHANGES FROM v4:
 *   • REDIS_URL is now REQUIRED in production (was optional-warn only).
 *   • price_approval_timeout + payment_link_expire_min defaults added.
 *   • NODE_ENV defaults strictly to 'development' if unset.
 */

const REQUIRED_ALWAYS = [
  'API_KEY',
  'DATABASE_URL',
];

const REQUIRED_IN_PRODUCTION = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'REDIS_URL',                 // Required in prod for multi-instance safety
];

const OPTIONAL_WITH_DEFAULTS = {
  PORT:                        '8000',
  NODE_ENV:                    'development',
  WEBHOOK_VERIFY_TOKEN:        'changeme_in_env',
  API_TIMEOUT_MS:              '5000',
  BASE_URL:                    'http://localhost:8000',
  WHATSAPP_API_VERSION:        'v19.0',
  GOOGLE_MAPS_API_KEY:         null,
  REDIS_URL:                   null,
  WHATSAPP_TOKEN:              null,
  WHATSAPP_PHONE_NUMBER_ID:    null,
  WHATSAPP_APP_SECRET:         null,
  RAZORPAY_KEY_ID:             null,
  RAZORPAY_KEY_SECRET:         null,
  RAZORPAY_WEBHOOK_SECRET:     null,
  RAZORPAY_CALLBACK_URL:       null,
  SHUTDOWN_DRAIN_TIMEOUT_MS:   '15000',
  DB_POOL_MAX:                 '20',
  DB_POOL_MIN:                 '2',
  WHATSAPP_WORKER_CONCURRENCY: '5',
  MESSAGE_WORKER_CONCURRENCY:  '3',
  JOB_WORKER_CONCURRENCY:      '5',
  ADMIN_READ_KEY:              null,   // Read-only API key (FIX B-3)
  ENABLE_SIMULATE:             'false', // Explicit simulate flag (FIX B-7)
};

function validateEnv() {
  const isProduction = (process.env.NODE_ENV || 'development') === 'production';
  const missing      = [];
  const warnings     = [];

  for (const key of REQUIRED_ALWAYS) {
    if (!process.env[key] || process.env[key].trim() === '') {
      missing.push(key);
    }
  }

  if (isProduction) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!process.env[key] || process.env[key].trim() === '') {
        missing.push(key);
      }
    }
  }

  for (const [key, def] of Object.entries(OPTIONAL_WITH_DEFAULTS)) {
    if (!process.env[key] || process.env[key].trim() === '') {
      if (def !== null) {
        process.env[key] = def;
        warnings.push(`${key} not set — using default: "${def}"`);
      } else {
        const severity = isProduction ? 'WARN' : 'INFO';
        warnings.push(`${key} not set — ${severity}: some features will be unavailable`);
      }
    }
  }

  // Sanity checks
  if (process.env.WEBHOOK_VERIFY_TOKEN === 'changeme_in_env' && isProduction) {
    missing.push('WEBHOOK_VERIFY_TOKEN (must not be the default "changeme_in_env" in production)');
  }

  // Warn if read key equals write key
  if (process.env.ADMIN_READ_KEY && process.env.ADMIN_READ_KEY === process.env.API_KEY) {
    warnings.push('ADMIN_READ_KEY is the same as API_KEY — this defeats the purpose of key separation');
  }

  const apiTimeoutMs = parseInt(process.env.API_TIMEOUT_MS || '5000', 10);
  if (isNaN(apiTimeoutMs) || apiTimeoutMs < 100) {
    warnings.push('API_TIMEOUT_MS is invalid — using 5000ms');
    process.env.API_TIMEOUT_MS = '5000';
  }

  if (missing.length > 0) {
    console.error('\n[config] ╔══════════════════════════════════════════════╗');
    console.error('[config] ║  FATAL — Missing required environment vars   ║');
    console.error('[config] ╚══════════════════════════════════════════════╝');
    missing.forEach(k => console.error(`[config]   ✕  ${k}`));
    console.error('[config]\n  Set these in your .env file and restart.\n');
    process.exit(1);
  }

  if (warnings.length > 0) {
    warnings.forEach(w => console.warn(`[config] WARN: ${w}`));
  }

  const nodeEnv = process.env.NODE_ENV;
  console.log(JSON.stringify({
    ts:         new Date().toISOString(),
    ctx:        '[config]',
    msg:        'Environment validated ✓',
    NODE_ENV:   nodeEnv,
    production: isProduction,
  }));

  return { isProduction };
}

module.exports = { validateEnv };
