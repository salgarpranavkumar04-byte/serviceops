/**
 * services/api.js — Centralised API client
 * Auth: x-api-key header (matches backend authenticate.js)
 */

const LS_KEY = 'serviceops_api_key';
const BASE   = import.meta.env.VITE_API_URL || '';

export function getApiKey() {
  return localStorage.getItem(LS_KEY) || import.meta.env.VITE_API_KEY || '';
}

let _onUnauthorized = null;

export function setUnauthorizedHandler(fn) {
  _onUnauthorized = fn;
}

async function req(method, path, body) {
  const apiKey = getApiKey();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      _onUnauthorized?.();
      return { ok: false, error: 'Unauthorized — check your API key', status: 401 };
    }

    const data = await res.json().catch(() => ({}));
    return res.ok
      ? { ok: true, data }
      : { ok: false, error: data.message || data.error || `HTTP ${res.status}`, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message || 'Network error', status: 0 };
  }
}

export const api = {
  get:   (path)        => req('GET',    path),
  post:  (path, body)  => req('POST',   path, body),
  patch: (path, body)  => req('PATCH',  path, body),
  del:   (path)        => req('DELETE', path),
};

export function saveApiKey(key) {
  localStorage.setItem(LS_KEY, key.trim());
}

export function clearApiKey() {
  localStorage.removeItem(LS_KEY);
}

export function isApiKeySet() {
  return !!getApiKey();
}
