-- =============================================================================
-- WARRANTY SYSTEM — Additive migration (run after base migration.sql)
-- Safe to run multiple times (all statements are idempotent).
-- =============================================================================

-- ─── 1. warranty_days column on services ─────────────────────────────────────
ALTER TABLE services ADD COLUMN IF NOT EXISTS warranty_days INTEGER NOT NULL DEFAULT 30;

UPDATE services SET warranty_days = 90  WHERE name IN ('AC_REPAIR', 'AC_INSTALLATION');
UPDATE services SET warranty_days = 60  WHERE name IN ('ELECTRICAL');
UPDATE services SET warranty_days = 30  WHERE name NOT IN ('AC_REPAIR', 'AC_INSTALLATION', 'ELECTRICAL');

-- ─── 2. Warranty columns on jobs ─────────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_warranty_job  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS original_job_id  UUID    REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_warranty     ON jobs(is_warranty_job) WHERE is_warranty_job = TRUE;
CREATE INDEX IF NOT EXISTS idx_jobs_original     ON jobs(original_job_id) WHERE original_job_id IS NOT NULL;

-- ─── 3. Enums ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE warranty_status_enum AS ENUM (
    'ACTIVE',    -- within warranty period, claimable
    'CLAIMED',   -- customer has an open claim against this warranty
    'EXPIRED',   -- past expires_at with no claim
    'VOIDED'     -- manually voided by admin
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE warranty_claim_status_enum AS ENUM (
    'OPEN',      -- claim submitted, warranty job dispatching
    'RESOLVED',  -- warranty job marked done
    'REJECTED'   -- admin rejected claim
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 4. warranties table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warranties (
  id               UUID                   PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Source job (the original paid job that generated this warranty)
  job_id           UUID                   NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,

  -- Customer info (denormalised for fast lookup without joining jobs)
  customer_phone   TEXT                   NOT NULL,
  customer_name    TEXT,

  -- Service info
  service_type     TEXT                   NOT NULL,

  -- Technician who did the original work
  technician_id    UUID                   REFERENCES technicians(id) ON DELETE SET NULL,

  -- Validity window
  issued_at        TIMESTAMPTZ            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at       TIMESTAMPTZ            NOT NULL,
  warranty_days    INTEGER                NOT NULL,

  -- Lifecycle
  status           warranty_status_enum   NOT NULL DEFAULT 'ACTIVE',
  voided_reason    TEXT,
  voided_by        TEXT,
  voided_at        TIMESTAMPTZ,

  created_at       TIMESTAMPTZ            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ            NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT uq_warranty_job UNIQUE (job_id),
  CONSTRAINT chk_warranty_expires CHECK (expires_at > issued_at),
  CONSTRAINT chk_warranty_days    CHECK (warranty_days > 0)
);

CREATE INDEX IF NOT EXISTS idx_warranties_job       ON warranties(job_id);
CREATE INDEX IF NOT EXISTS idx_warranties_phone     ON warranties(customer_phone);
CREATE INDEX IF NOT EXISTS idx_warranties_service   ON warranties(service_type);
CREATE INDEX IF NOT EXISTS idx_warranties_status    ON warranties(status);
CREATE INDEX IF NOT EXISTS idx_warranties_expires   ON warranties(expires_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_warranties_tech      ON warranties(technician_id) WHERE technician_id IS NOT NULL;

-- ─── 5. warranty_claims table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warranty_claims (
  id                UUID                        PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The warranty being claimed against
  warranty_id       UUID                        NOT NULL REFERENCES warranties(id) ON DELETE RESTRICT,

  -- The new job created to fulfil this claim (NULL until dispatch succeeds)
  claim_job_id      UUID                        REFERENCES jobs(id) ON DELETE SET NULL,

  -- What the customer reported
  issue_description TEXT                        NOT NULL,

  -- Lifecycle
  status            warranty_claim_status_enum  NOT NULL DEFAULT 'OPEN',
  resolved_at       TIMESTAMPTZ,
  rejection_reason  TEXT,

  claimed_at        TIMESTAMPTZ                 NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at        TIMESTAMPTZ                 NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ                 NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wclaims_warranty  ON warranty_claims(warranty_id);
CREATE INDEX IF NOT EXISTS idx_wclaims_job       ON warranty_claims(claim_job_id) WHERE claim_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wclaims_status    ON warranty_claims(status);

-- ─── 6. system_settings additions ────────────────────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('warranty_enabled',            'true',  'Enable or disable the warranty system globally'),
  ('warranty_claim_limit',        '1',     'Max open warranty claims per warranty (prevent abuse)')
ON CONFLICT (key) DO NOTHING;

-- ─── 7. job_status_enum — add WARRANTY_JOB (if not already present) ──────────
-- Warranty jobs reuse the existing enum states (JOB_CREATED → ASSIGNED → ACCEPTED → IN_PROGRESS → COMPLETED)
-- No new enum values are required.

-- ─── Rollback guide (manual — run if needed) ─────────────────────────────────
-- DROP TABLE IF EXISTS warranty_claims;
-- DROP TABLE IF EXISTS warranties;
-- DROP TYPE IF EXISTS warranty_status_enum;
-- DROP TYPE IF EXISTS warranty_claim_status_enum;
-- ALTER TABLE jobs DROP COLUMN IF EXISTS is_warranty_job;
-- ALTER TABLE jobs DROP COLUMN IF EXISTS original_job_id;
-- ALTER TABLE services DROP COLUMN IF EXISTS warranty_days;
-- DELETE FROM system_settings WHERE key IN ('warranty_enabled','warranty_claim_limit');
