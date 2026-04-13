/**
 * hooks/useApi.js — Data-fetching hook (v2 — stable ref pattern)
 *
 * WHY THE REF PATTERN:
 *   Old approach stored `fn` directly in useCallback's closure and required
 *   callers to pass a `deps` array. Two failure modes:
 *     1. Caller passes wrong deps  → stale closure, fetches old data
 *     2. Caller passes inline arrow → new fn identity every render → infinite loop
 *
 *   New approach: store `fn` in a ref. The ref is mutated synchronously on
 *   every render so fnRef.current is always the latest version of `fn`.
 *   `run` can therefore use [] as its dep array — it never becomes stale
 *   because it always reads through the ref.
 *
 * RESULT:
 *   - `run` / `refresh` / `execute` have stable identity across all renders
 *   - Polling never double-fires on re-renders
 *   - Callers need zero deps boilerplate
 *   - Safe to pass `refresh` down to child components without useMemo/useCallback
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @param {() => Promise<{ok: boolean, data?: any, error?: string}>} fn
 * @param {{
 *   immediate?:    boolean,  // fetch on mount (default: true)
 *   pollInterval?: number,   // ms between auto-polls; 0 = disabled
 * }} opts
 */
export function useApi(fn, { immediate = true, pollInterval = 0 } = {}) {
  const [state, setState] = useState({
    data:    null,
    loading: immediate,
    error:   null,
  });

  // Always keep a ref to the latest fn so run() never captures a stale closure
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // run is stable for the lifetime of the component ([] dep array is intentional)
  const run = useCallback(async (...args) => {
    setState((s) => ({ ...s, loading: true, error: null }));

    const r = await fnRef.current(...args);
    if (!r) return;

    setState({
      data:    r.ok ? r.data  : null,
      loading: false,
      error:   r.ok ? null    : (r.error || 'Unknown error'),
    });

    return r;
  }, []); // [] is safe — fnRef.current is always fresh

  // Initial fetch
  useEffect(() => {
    if (immediate) run();
  }, [immediate, run]);

  // Optional polling — timer is stable because run is stable
  const timerRef = useRef(null);
  useEffect(() => {
    if (!pollInterval || pollInterval <= 0) return;

    timerRef.current = setInterval(run, pollInterval);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [pollInterval, run]);

  return { ...state, refresh: run, execute: run };
}
