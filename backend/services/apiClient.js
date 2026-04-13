'use strict';

/**
 * apiClient.js — Internal axios wrapper (v4)
 *
 * CHANGES FROM v3:
 *   • Retry on network errors and 5xx (via retryService)
 *   • DELETE wrapper added
 *   • More granular error classification (TIMEOUT / NETWORK / HTTP_ERROR)
 *   • Consistent structured JSON logging
 */

const axios = require('axios');
const { retryOnHttp } = require('./retryService');

const BASE_URL = process.env.BASE_URL      || 'http://localhost:8000';
const TIMEOUT  = parseInt(process.env.API_TIMEOUT_MS || '5000', 10);

if (!process.env.API_KEY) {
  console.warn('[apiClient] WARNING: API_KEY env var is not set — all authenticated requests will be rejected');
}

const client = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
    'x-api-key':    process.env.API_KEY || '',
  },
});

/* ─── Structured logger ───────────────────────────────────────────────────── */

function logError(ctx, path, reason, err) {
  console.error(JSON.stringify({
    ts:     new Date().toISOString(),
    ctx:    '[apiClient][error]',
    label:  `[${ctx}]`,
    path,
    reason,
    status: err?.response?.status,
    msg:    err?.message,
  }));
}

/* ─── Error classifier ────────────────────────────────────────────────────── */

function classifyError(err) {
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return 'NETWORK';
  return 'HTTP_ERROR';
}

/* ─── POST wrapper — never throws ────────────────────────────────────────── */

async function safePost(path, payload, ctx = 'api', retries = 1, traceId = null) {
  try {
    const headers = traceId ? { 'x-trace-id': traceId } : {};
    const fn = () => client.post(path, payload, { headers });
    const { data } = retries > 1
      ? await retryOnHttp(fn, [429, 500, 502, 503, 504], { attempts: retries })
      : await fn();
    return { data };
  } catch (err) {
    const reason = classifyError(err);
    logError(ctx, path, reason, err);
    return { error: err.message, status: err.response?.status };
  }
}

/* ─── GET wrapper — never throws ─────────────────────────────────────────── */

async function safeGet(path, params = {}, ctx = 'api', retries = 1) {
  try {
    const fn = () => client.get(path, { params });
    const { data } = retries > 1
      ? await retryOnHttp(fn, [429, 500, 502, 503, 504], { attempts: retries })
      : await fn();
    return { data };
  } catch (err) {
    const reason = classifyError(err);
    logError(ctx, path, reason, err);
    return { error: err.message, status: err.response?.status };
  }
}

/* ─── PATCH wrapper — never throws ───────────────────────────────────────── */

async function safePatch(path, payload, ctx = 'api', retries = 1) {
  try {
    const fn = () => client.patch(path, payload);
    const { data } = retries > 1
      ? await retryOnHttp(fn, [429, 500, 502, 503, 504], { attempts: retries })
      : await fn();
    return { data };
  } catch (err) {
    const reason = classifyError(err);
    logError(ctx, path, reason, err);
    return { error: err.message, status: err.response?.status };
  }
}

/* ─── DELETE wrapper — never throws ──────────────────────────────────────── */

async function safeDelete(path, ctx = 'api') {
  try {
    const { data } = await client.delete(path);
    return { data };
  } catch (err) {
    const reason = classifyError(err);
    logError(ctx, path, reason, err);
    return { error: err.message, status: err.response?.status };
  }
}

module.exports = { safePost, safeGet, safePatch, safeDelete };
