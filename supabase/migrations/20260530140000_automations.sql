-- Automations: standing instructions for the agent to act on triggers
-- (e.g. "watch this GitHub repo for new issues, open PRs for them").
--
-- Phase C of the automation rollout uses these tables but runs the
-- agent synchronously when the user clicks "Run now". A future phase
-- adds a background worker that polls automations on a schedule.

-- automations: one row per standing instruction.

CREATE TABLE IF NOT EXISTS automations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,  -- 'github_issue_to_pr', extensible later
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- e.g. { repo: "owner/name" }
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS automations_user_idx
  ON automations (user_id, created_at DESC);

ALTER TABLE automations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='automations'
      AND policyname='automations_owner'
  ) THEN
    CREATE POLICY automations_owner ON automations
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- automation_runs: one row per (automation, issue) attempt. Used to
-- dedupe — we skip issues with a successful run for the same
-- automation. Failed runs can be retried by the user.

CREATE TABLE IF NOT EXISTS automation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  issue_number    INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  pr_url          TEXT,
  pr_number       INTEGER,
  tokens          INTEGER,
  error           TEXT,
  summary         TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS automation_runs_user_idx
  ON automation_runs (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS automation_runs_dedup_idx
  ON automation_runs (automation_id, issue_number, status);

ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='automation_runs'
      AND policyname='automation_runs_owner'
  ) THEN
    CREATE POLICY automation_runs_owner ON automation_runs
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
