-- =============================================================================
-- Migration 001 — Price Flow additions
-- Run once against your production DB before deploying v5.2
-- Safe to run multiple times (all changes are IF NOT EXISTS / idempotent)
-- =============================================================================

BEGIN;

-- ── price_rejected_count ──────────────────────────────────────────────────────
-- Tracks how many times a customer has rejected the technician's quoted price
-- for this job. Escalation triggers at 3. Reset by REASSIGN_TECH.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS price_rejected_count INTEGER NOT NULL DEFAULT 0;

-- ── arrived_at ────────────────────────────────────────────────────────────────
-- Timestamp when the technician tapped ARRIVED — useful for SLA reporting.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;

-- ── payment_confirmed_at ──────────────────────────────────────────────────────
-- Timestamp when Razorpay payment was verified and job moved to IN_PROGRESS.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;

-- ── Index: price_rejected_count > 0 — useful for admin escalation dashboard
CREATE INDEX IF NOT EXISTS idx_jobs_rejected
  ON jobs(price_rejected_count)
  WHERE price_rejected_count > 0;

COMMIT;
