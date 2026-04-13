'use strict';

/**
 * db.js — PostgreSQL connection pool (v4)
 *
 * CHANGES FROM v3:
 *   • query() helper with automatic timeout via SET statement_timeout
 *   • Pool health metrics (via pool events)
 *   • Safe transaction helper: withTransaction(async (client) => { ... })
 *   • Structured JSON logging
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[db] FATAL: DATABASE_URL is not set');
  process.exit(1);
}

const STATEMENT_TIMEOUT_MS = parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:                       parseInt(process.env.DB_POOL_MAX       || '20',    10),
  min:                       parseInt(process.env.DB_POOL_MIN       || '2',     10),
  idleTimeoutMillis:         parseInt(process.env.DB_IDLE_TIMEOUT   || '30000', 10),
  connectionTimeoutMillis:   parseInt(process.env.DB_CONN_TIMEOUT   || '5000',  10),
  statement_timeout:         STATEMENT_TIMEOUT_MS,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true }
    : false,
});

/* ─── Pool health counters ────────────────────────────────────────────────── */

let _totalConnections  = 0;
let _errorConnections  = 0;

pool.on('connect', () => {
  _totalConnections++;
});

pool.on('error', (err) => {
  _errorConnections++;
  console.error(JSON.stringify({
    ts:  new Date().toISOString(),
    ctx: '[db]',
    msg: 'Unexpected pool error',
    err: err.message,
  }));
});

/* ─── Startup connectivity check ─────────────────────────────────────────── */

pool.query('SELECT 1').then(() => {
  console.log('[db] PostgreSQL connection verified ✓');
}).catch(err => {
  console.error('[db] Startup connectivity check failed:', err.message);
  // Don't exit — pool may recover. Let the app attempt to start.
});

/* ─── Safe query helper ───────────────────────────────────────────────────── */

/**
 * pool.query wrapper.
 * Re-exports pool.query as-is. For use in ad-hoc queries.
 */
const query = pool.query.bind(pool);

/**
 * pool.connect passthrough — for transactions.
 */
const connect = pool.connect.bind(pool);

/* ─── Transaction helper ──────────────────────────────────────────────────── */

/**
 * Runs `fn(client)` inside a BEGIN/COMMIT/ROLLBACK transaction.
 * Automatically releases the client on success or failure.
 * Throws on error (after rolling back).
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ─── Health snapshot ────────────────────────────────────────────────────── */

function getHealthSnapshot() {
  return {
    total:   pool.totalCount,
    idle:    pool.idleCount,
    waiting: pool.waitingCount,
    errors:  _errorConnections,
    started: _totalConnections,
  };
}

/* ─── Graceful shutdown ───────────────────────────────────────────────────── */

async function closePool() {
  console.log('[db] Closing pool...');
  await pool.end();
  console.log('[db] Pool closed ✓');
}

module.exports = pool;
module.exports.query          = query;
module.exports.connect        = connect;
module.exports.withTransaction = withTransaction;
module.exports.getHealthSnapshot = getHealthSnapshot;
module.exports.closePool      = closePool;
