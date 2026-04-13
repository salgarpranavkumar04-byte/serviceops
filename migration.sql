-- =============================================================================
-- ServiceOps v5 — Complete Production Database Migration
-- PostgreSQL 14+ with PostGIS extension
-- =============================================================================
-- Run as:  psql -U postgres -d serviceops -f migration.sql
-- Or:      \i migration.sql
-- =============================================================================

BEGIN;

-- ─── Enable extensions ───────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- for fast ILIKE text search

-- =============================================================================
-- ENUMS
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE job_status_enum AS ENUM (
    'JOB_CREATED',
    'ASSIGNED',
    'ACCEPTED',
    'IN_PROGRESS',
    'WAITING_FOR_PRICE',
    'CUSTOMER_APPROVAL_PENDING',
    'PAYMENT_PENDING',
    'COMPLETED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE technician_status_enum AS ENUM (
    'AVAILABLE',
    'BUSY',
    'OFFLINE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status_enum AS ENUM (
    'NOT_REQUIRED',
    'PENDING',
    'PAID',
    'FAILED',
    'REFUNDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE offer_status_enum AS ENUM (
    'PENDING',
    'ACCEPTED',
    'REJECTED',
    'EXPIRED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE wallet_txn_type_enum AS ENUM (
    'JOB_EARNING',
    'COMMISSION_DUE',
    'COMMISSION_PAYMENT',
    'CANCELLATION_FINE',
    'MANUAL_ADJUSTMENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE conv_state_enum AS ENUM (
    'idle',
    'service_selected',
    'name_requested',
    'location_received',
    'awaiting_price_approval',
    'price_entry',
    'completed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE conv_role_enum AS ENUM (
    'customer',
    'technician'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- SERVICES — lookup table for service categories
-- =============================================================================

CREATE TABLE IF NOT EXISTS services (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT        NOT NULL UNIQUE,              -- e.g. 'AC_REPAIR', 'PLUMBING'
  display_name TEXT       NOT NULL,
  description TEXT,
  base_price  NUMERIC(10,2),
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_services_name      ON services(name);
CREATE INDEX IF NOT EXISTS idx_services_is_active ON services(is_active);

-- =============================================================================
-- TECHNICIANS
-- =============================================================================

CREATE TABLE IF NOT EXISTS technicians (
  id               UUID                    PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             TEXT                    NOT NULL,
  phone            TEXT                    NOT NULL UNIQUE,
  status           technician_status_enum  NOT NULL DEFAULT 'AVAILABLE',

  -- Location (PostGIS)
  latitude         NUMERIC(10,8),
  longitude        NUMERIC(11,8),
  location         GEOGRAPHY(POINT, 4326),  -- PostGIS spatial column

  -- Financials
  -- Positive balance = technician owes platform (commission due)
  -- Negative balance = platform owes technician (overpayment)
  wallet_balance   NUMERIC(12,2)           NOT NULL DEFAULT 0.00,

  -- Profile
  verified         BOOLEAN                 NOT NULL DEFAULT FALSE,
  rating           NUMERIC(3,2),                     -- NULL until first rating
  profile_image    TEXT,

  -- Timestamps
  created_at       TIMESTAMPTZ             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ             NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Constraints
  CONSTRAINT chk_technician_phone     CHECK (phone ~ '^[6-9][0-9]{9}$'),
  CONSTRAINT chk_technician_rating    CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  CONSTRAINT chk_wallet_balance       CHECK (wallet_balance >= -1000000 AND wallet_balance <= 1000000)
);

CREATE INDEX IF NOT EXISTS idx_technicians_status   ON technicians(status);
CREATE INDEX IF NOT EXISTS idx_technicians_phone    ON technicians(phone);
CREATE INDEX IF NOT EXISTS idx_technicians_location ON technicians USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_technicians_verified ON technicians(verified) WHERE verified = TRUE;

COMMENT ON COLUMN technicians.wallet_balance IS
  'Positive = owes commission to platform. Reduced by COMMISSION_PAYMENT transactions.';

-- =============================================================================
-- TECHNICIAN_SERVICES — junction: which service types each tech handles
-- =============================================================================

CREATE TABLE IF NOT EXISTS technician_services (
  technician_id  UUID NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  service_id     UUID NOT NULL REFERENCES services(id)    ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (technician_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_tech_services_tech    ON technician_services(technician_id);
CREATE INDEX IF NOT EXISTS idx_tech_services_service ON technician_services(service_id);

-- =============================================================================
-- JOBS — core table, full lifecycle support
-- =============================================================================

CREATE TABLE IF NOT EXISTS jobs (
  id                     UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Customer
  customer_name          TEXT              NOT NULL,
  customer_phone         TEXT              NOT NULL,
  customer_address       TEXT,                          -- reverse-geocoded

  -- Service
  service_type           TEXT              NOT NULL,    -- matches services.name

  -- Location (PostGIS)
  latitude               NUMERIC(10,8)     NOT NULL,
  longitude              NUMERIC(11,8)     NOT NULL,
  location               GEOGRAPHY(POINT, 4326) NOT NULL,
  city                   TEXT,

  -- Status lifecycle
  status                 job_status_enum   NOT NULL DEFAULT 'JOB_CREATED',

  -- Assignment
  technician_id          UUID              REFERENCES technicians(id) ON DELETE SET NULL,
  dispatch_attempts      INTEGER           NOT NULL DEFAULT 0,

  -- Pricing — no default (must be explicitly set by technician)
  price                  NUMERIC(10,2),
  price_set_by           UUID              REFERENCES technicians(id) ON DELETE SET NULL,
  price_set_at           TIMESTAMPTZ,

  -- Payment
  payment_status         payment_status_enum NOT NULL DEFAULT 'NOT_REQUIRED',
  payment_id             TEXT,             -- Razorpay payment link ID
  payment_paid_at        TIMESTAMPTZ,

  -- Approval timestamps
  customer_approved_at   TIMESTAMPTZ,

  -- Idempotency
  request_id             TEXT UNIQUE,      -- external idempotency key (max 128 chars)

  -- Commission tracking
  commission_amount      NUMERIC(10,2),
  commission_collected   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Timestamps (one per major lifecycle transition)
  created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at            TIMESTAMPTZ,
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Constraints
  CONSTRAINT chk_job_phone          CHECK (customer_phone ~ '^[6-9][0-9]{9}$'),
  CONSTRAINT chk_job_price_positive CHECK (price IS NULL OR price > 0),
  CONSTRAINT chk_job_dispatch       CHECK (dispatch_attempts >= 0),
  CONSTRAINT chk_request_id_len     CHECK (request_id IS NULL OR LENGTH(request_id) <= 128)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status         ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_technician     ON jobs(technician_id) WHERE technician_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_customer_phone ON jobs(customer_phone);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at     ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_location       ON jobs USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_jobs_request_id     ON jobs(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_payment_status ON jobs(payment_status);
CREATE INDEX IF NOT EXISTS idx_jobs_active         ON jobs(status)
  WHERE status NOT IN ('COMPLETED', 'CANCELLED');

-- Text search index
CREATE INDEX IF NOT EXISTS idx_jobs_customer_name_trgm
  ON jobs USING GIN(customer_name gin_trgm_ops);

COMMENT ON COLUMN jobs.price IS
  'Set by technician via set-price. No default — must be explicitly provided.';
COMMENT ON COLUMN jobs.request_id IS
  'Caller-supplied idempotency key. Duplicate request_id returns existing job.';

-- =============================================================================
-- JOB_OFFERS — dispatch wave tracking
-- =============================================================================

CREATE TABLE IF NOT EXISTS job_offers (
  id             UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id         UUID             NOT NULL REFERENCES jobs(id)        ON DELETE CASCADE,
  technician_id  UUID             NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  status         offer_status_enum NOT NULL DEFAULT 'PENDING',
  wave           INTEGER          NOT NULL DEFAULT 1,
  offered_at     TIMESTAMPTZ      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at   TIMESTAMPTZ,

  UNIQUE (job_id, technician_id)
);

CREATE INDEX IF NOT EXISTS idx_offers_job       ON job_offers(job_id);
CREATE INDEX IF NOT EXISTS idx_offers_tech      ON job_offers(technician_id);
CREATE INDEX IF NOT EXISTS idx_offers_status    ON job_offers(status);
CREATE INDEX IF NOT EXISTS idx_offers_pending   ON job_offers(job_id, status)
  WHERE status = 'PENDING';

-- =============================================================================
-- JOB_LOGS — immutable audit trail
-- =============================================================================

CREATE TABLE IF NOT EXISTS job_logs (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id      UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event       TEXT        NOT NULL,   -- e.g. 'JOB_CREATED', 'OFFER_SENT', 'PRICE_SET'
  actor_type  TEXT,                   -- 'customer', 'technician', 'system', 'admin'
  actor_id    TEXT,                   -- phone number or UUID
  payload     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_logs_job       ON job_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_event     ON job_logs(event);
CREATE INDEX IF NOT EXISTS idx_job_logs_created   ON job_logs(created_at DESC);

COMMENT ON TABLE job_logs IS
  'Append-only audit log. Never update or delete rows.';

-- =============================================================================
-- CONVERSATIONS — WhatsApp session state
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversations (
  id            UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone         TEXT            NOT NULL UNIQUE,  -- only one active conv per phone
  role          conv_role_enum  NOT NULL DEFAULT 'customer',
  state         conv_state_enum NOT NULL DEFAULT 'idle',
  step          TEXT,                             -- alias for state, backward compat
  context       JSONB           NOT NULL DEFAULT '{}',
  last_message  TEXT,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_conv_phone CHECK (phone ~ '^[0-9]{10,15}$')
);

CREATE INDEX IF NOT EXISTS idx_conversations_phone      ON conversations(phone);
CREATE INDEX IF NOT EXISTS idx_conversations_state      ON conversations(state);
CREATE INDEX IF NOT EXISTS idx_conversations_expires    ON conversations(expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_updated    ON conversations(updated_at DESC);

-- =============================================================================
-- WALLET_TRANSACTIONS — double-entry style ledger
-- =============================================================================

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              UUID                 PRIMARY KEY DEFAULT uuid_generate_v4(),
  technician_id   UUID                 NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  job_id          UUID                 REFERENCES jobs(id) ON DELETE SET NULL,
  type            wallet_txn_type_enum NOT NULL,
  amount          NUMERIC(10,2)        NOT NULL,      -- always positive
  balance_after   NUMERIC(12,2)        NOT NULL,      -- snapshot of wallet_balance after txn
  notes           TEXT,
  created_at      TIMESTAMPTZ          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_wallet_txn_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_wallet_txns_tech     ON wallet_transactions(technician_id);
CREATE INDEX IF NOT EXISTS idx_wallet_txns_job      ON wallet_transactions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_txns_type     ON wallet_transactions(type);
CREATE INDEX IF NOT EXISTS idx_wallet_txns_created  ON wallet_transactions(created_at DESC);

COMMENT ON COLUMN wallet_transactions.balance_after IS
  'Snapshot of technician.wallet_balance immediately after this transaction committed.';

-- =============================================================================
-- PAYMENT_LINKS — Razorpay payment link tracking
-- =============================================================================

CREATE TABLE IF NOT EXISTS payment_links (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id           UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  razorpay_link_id TEXT        NOT NULL UNIQUE,
  short_url        TEXT        NOT NULL,
  amount           NUMERIC(10,2) NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'created',   -- created|paid|expired
  expires_at       TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  razorpay_payload JSONB,      -- full webhook payload on payment
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_payment_link_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_payment_links_job    ON payment_links(job_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_rzp_id ON payment_links(razorpay_link_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_status ON payment_links(status);

-- =============================================================================
-- COMMISSION_RULES — per-service commission overrides
-- =============================================================================

CREATE TABLE IF NOT EXISTS commission_rules (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_type          TEXT        NOT NULL,
  commission_percentage NUMERIC(5,2) NOT NULL,
  effective_from        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by            TEXT        NOT NULL DEFAULT 'admin',
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_commission_pct CHECK (commission_percentage >= 0 AND commission_percentage <= 100)
);

CREATE INDEX IF NOT EXISTS idx_commission_rules_service ON commission_rules(service_type);
CREATE INDEX IF NOT EXISTS idx_commission_rules_from    ON commission_rules(effective_from DESC);

-- =============================================================================
-- SYSTEM_SETTINGS — key-value configuration store
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_settings (
  key          TEXT        PRIMARY KEY,
  value        TEXT        NOT NULL,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   TEXT        NOT NULL DEFAULT 'system'
);

-- =============================================================================
-- IDEMPOTENCY_KEYS — request deduplication across all endpoints
-- =============================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT        PRIMARY KEY,
  endpoint     TEXT        NOT NULL,
  status_code  INTEGER     NOT NULL,
  response     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- =============================================================================
-- TRIGGERS — auto-update updated_at
-- =============================================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_technicians_updated_at
    BEFORE UPDATE ON technicians
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_services_updated_at
    BEFORE UPDATE ON services
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_payment_links_updated_at
    BEFORE UPDATE ON payment_links
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- TRIGGER — auto-fill location from lat/lng on jobs
-- =============================================================================

CREATE OR REPLACE FUNCTION trigger_jobs_set_location()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326);
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_jobs_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON jobs
    FOR EACH ROW EXECUTE FUNCTION trigger_jobs_set_location();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- TRIGGER — auto-fill location from lat/lng on technicians
-- =============================================================================

CREATE OR REPLACE FUNCTION trigger_technicians_set_location()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326);
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_technicians_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON technicians
    FOR EACH ROW EXECUTE FUNCTION trigger_technicians_set_location();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- SEED DATA — Services catalog
-- =============================================================================

INSERT INTO services (name, display_name, description, base_price, is_active) VALUES
  ('AC_REPAIR',       'AC Repair & Service',      'Air conditioning repair, gas filling, servicing',     500.00, TRUE),
  ('AC_INSTALLATION', 'AC Installation',           'New AC installation and setup',                      1500.00, TRUE),
  ('PLUMBING',        'Plumbing',                  'Pipe repairs, leaks, faucet replacement',             300.00, TRUE),
  ('ELECTRICAL',      'Electrical',                'Wiring, switches, MCB, short circuit repair',         350.00, TRUE),
  ('CARPENTRY',       'Carpentry',                 'Furniture repair, door/window fixing',                400.00, TRUE),
  ('CLEANING',        'Deep Cleaning',             'Home and office deep cleaning service',               800.00, TRUE),
  ('PEST_CONTROL',    'Pest Control',              'Cockroach, ant, termite treatment',                  1200.00, TRUE),
  ('PAINTING',        'Painting',                  'Interior/exterior painting and whitewash',            600.00, TRUE),
  ('APPLIANCE_REPAIR','Appliance Repair',           'Washing machine, refrigerator, microwave repair',     450.00, TRUE),
  ('WATER_PURIFIER',  'Water Purifier Service',    'RO/UV filter cleaning and cartridge replacement',     350.00, TRUE)
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- SEED DATA — System Settings (matches backend EDITABLE_SETTINGS)
-- =============================================================================

INSERT INTO system_settings (key, value, description) VALUES
  ('commission_percentage',   '15',    'Platform commission percentage on each completed job'),
  ('cancellation_fine',       '50',    'Penalty (₹) charged when technician cancels an accepted job'),
  ('min_wallet_balance',      '500',   'Max wallet balance (₹) allowed before technician is blocked from accepting jobs'),
  ('max_active_jobs',         '3',     'Maximum simultaneous active jobs a technician can hold'),
  ('offer_timeout_seconds',   '90',    'Seconds before an unanswered offer expires and goes to next technician'),
  ('max_dispatch_attempts',   '5',     'Maximum dispatch waves before job is cancelled'),
  ('min_commission_amount',   '30',    'Minimum commission (₹) charged per job regardless of percentage'),
  ('visiting_fee',            '99',    'Fixed visiting/inspection fee (₹) included in price, exempt from commission'),
  ('dispatch_radius_km',      '10',    'Radius (km) to search for available technicians'),
  ('surge_multiplier',        '1.5',   'Price multiplier applied during surge pricing'),
  ('surge_enabled',           'false', 'Enable/disable surge pricing (true/false)'),
  ('max_offers_per_wave',     '3',     'Number of technicians contacted per dispatch wave'),
  ('job_accept_timeout_min',  '30',    'Minutes before an unaccepted JOB_CREATED resets to available for redispatch'),
  ('conv_expire_hours',       '2',     'Hours before an idle conversation session expires'),
  ('price_approval_timeout',  '30',    'Minutes for customer to approve a technician price quote'),
  ('payment_link_expire_min', '60',    'Minutes before a Razorpay payment link expires')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- VIEWS — convenience read-only views
-- =============================================================================

CREATE OR REPLACE VIEW v_active_jobs AS
  SELECT
    j.id,
    j.customer_name,
    j.customer_phone,
    j.customer_address,
    j.service_type,
    j.status,
    j.price,
    j.payment_status,
    j.dispatch_attempts,
    j.created_at,
    j.updated_at,
    t.name  AS technician_name,
    t.phone AS technician_phone
  FROM jobs j
  LEFT JOIN technicians t ON t.id = j.technician_id
  WHERE j.status NOT IN ('COMPLETED', 'CANCELLED');

CREATE OR REPLACE VIEW v_technician_summary AS
  SELECT
    t.id,
    t.name,
    t.phone,
    t.status,
    t.verified,
    t.rating,
    t.wallet_balance,
    t.created_at,
    COUNT(j.id) FILTER (WHERE j.status = 'COMPLETED')                  AS completed_jobs,
    COUNT(j.id) FILTER (WHERE j.status NOT IN ('COMPLETED','CANCELLED')) AS active_jobs
  FROM technicians t
  LEFT JOIN jobs j ON j.technician_id = t.id
  GROUP BY t.id;

CREATE OR REPLACE VIEW v_daily_revenue AS
  SELECT
    DATE(updated_at)            AS date,
    COUNT(*)                    AS total_jobs,
    SUM(price)                  AS gross_revenue,
    SUM(commission_amount)      AS total_commission,
    SUM(price - COALESCE(commission_amount, 0)) AS net_payout
  FROM jobs
  WHERE status = 'COMPLETED'
  GROUP BY DATE(updated_at)
  ORDER BY DATE(updated_at) DESC;

-- =============================================================================
-- CLEANUP — expire old idempotency keys (run via cron or pg_cron)
-- =============================================================================

-- Example cron (pg_cron extension):
-- SELECT cron.schedule('cleanup-idempotency', '0 * * * *',
--   'DELETE FROM idempotency_keys WHERE expires_at < CURRENT_TIMESTAMP');
--
-- Example cron (cleanup old conversations):
-- SELECT cron.schedule('cleanup-conversations', '0 2 * * *',
--   'DELETE FROM conversations WHERE expires_at < CURRENT_TIMESTAMP - INTERVAL ''24 hours''');

COMMIT;

-- =============================================================================
-- SECTION F — Additional migrations (FIX A-1, A-3, A-5, C-2, D-2)
-- =============================================================================
BEGIN;

-- ─── New settings (FIX A-1, A-5) ─────────────────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('arrived_price_timeout_min', '30', 'Minutes after technician arrival before job is cancelled if no price submitted'),
  ('in_progress_timeout_hours', '6',  'Hours before an IN_PROGRESS job without MARK_DONE is auto-completed')
ON CONFLICT (key) DO NOTHING;

-- ─── Payment URL storage (FIX D-2) ────────────────────────────────────────
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_url TEXT;

-- ─── WhatsApp delivery failures (FIX C-2) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_delivery_failures (
  id              SERIAL      PRIMARY KEY,
  message_id      TEXT        NOT NULL UNIQUE,
  recipient_phone TEXT,
  error_code      INTEGER,
  error_title     TEXT,
  failed_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wdf_failed_at ON whatsapp_delivery_failures (failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_wdf_phone     ON whatsapp_delivery_failures (recipient_phone);

COMMIT;

-- =============================================================================
-- POST-COMMIT VERIFICATION (run these manually to verify)
-- =============================================================================

-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
-- SELECT key, value FROM system_settings ORDER BY key;
-- SELECT name, display_name FROM services ORDER BY name;
-- SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname;
