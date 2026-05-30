-- Initial schema for agentflow.
--
-- Five tables back the four primitives the platform composes:
--   • jobs            — units of work (queued, running, done, failed)
--   • job_events      — append-only log stream per job (Realtime fans
--                       this out to the dashboard)
--   • artifacts       — what jobs produce (markdown reports, rewrite
--                       suggestions, idea briefs, alerts)
--   • integrations    — per-user OAuth credentials for third-party
--                       APIs (YouTube, etc.). Tokens are stored as-is
--                       for now; rotate to pgsodium-encrypted columns
--                       before this gets multi-tenant.
--   • schedules       — cron-style recurring job templates
--
-- Plus a `claim_next_job()` SECURITY DEFINER function that atomically
-- flips one queued job to running and returns it. The worker calls
-- this from a poll loop; the atomic UPDATE prevents two workers from
-- claiming the same job.
--
-- All idempotent — re-running on an existing DB is a no-op.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- jobs --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  input_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  error           TEXT,
  total_tokens    INTEGER,
  cost_usd        NUMERIC(10, 4),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jobs_user_created_idx
  ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx
  ON jobs (status) WHERE status IN ('queued', 'running');

-- job_events --------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_events (
  id        BIGSERIAL PRIMARY KEY,
  job_id    UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level     TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS job_events_job_ts_idx
  ON job_events (job_id, ts);

-- artifacts ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS artifacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  content_json    JSONB,
  content_md      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS artifacts_job_idx
  ON artifacts (job_id, created_at);

-- integrations ------------------------------------------------------

CREATE TABLE IF NOT EXISTS integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  provider        TEXT NOT NULL,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, domain, provider)
);

-- schedules ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  job_kind        TEXT NOT NULL,
  input_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  cron_expression TEXT NOT NULL,
  next_run_at     TIMESTAMPTZ NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS schedules_due_idx
  ON schedules (next_run_at) WHERE active;

-- claim_next_job ----------------------------------------------------
--
-- Atomically claim one queued job. SKIP LOCKED so concurrent workers
-- don't block each other; UPDATE..RETURNING so exactly one worker
-- sees each row. SECURITY DEFINER + restrictive search_path because
-- we're going to grant EXECUTE to the service_role only.

CREATE OR REPLACE FUNCTION claim_next_job()
RETURNS SETOF jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE jobs
  SET    status = 'running',
         started_at = NOW()
  WHERE  id = (
    SELECT id FROM jobs
    WHERE  status = 'queued'
    ORDER  BY created_at
    FOR    UPDATE SKIP LOCKED
    LIMIT  1
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION claim_next_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_job() TO service_role;

-- RLS ---------------------------------------------------------------

ALTER TABLE jobs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules      ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='jobs'
      AND policyname='jobs_owner'
  ) THEN
    CREATE POLICY jobs_owner ON jobs
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='job_events'
      AND policyname='job_events_owner_read'
  ) THEN
    CREATE POLICY job_events_owner_read ON job_events
      FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM jobs j WHERE j.id = job_events.job_id AND j.user_id = auth.uid()
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='artifacts'
      AND policyname='artifacts_owner_read'
  ) THEN
    CREATE POLICY artifacts_owner_read ON artifacts
      FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM jobs j WHERE j.id = artifacts.job_id AND j.user_id = auth.uid()
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='integrations'
      AND policyname='integrations_owner'
  ) THEN
    CREATE POLICY integrations_owner ON integrations
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='schedules'
      AND policyname='schedules_owner'
  ) THEN
    CREATE POLICY schedules_owner ON schedules
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Realtime ----------------------------------------------------------
--
-- Add job_events to the realtime publication so the dashboard can
-- stream the live agent log. Wrapped because adding twice is an error.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'job_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE job_events;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE jobs;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
