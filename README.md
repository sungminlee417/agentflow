# agentflow

Background Claude agents that analyze content and run domain-specific
workflows. Phase 1 focuses on **YouTube** (analyze your own channel and
produce recommendations to grow views). The architecture is built around
a pluggable **domain** abstraction so additional domains (e.g. coachflow)
slot in later without rewriting the platform.

## Highlights

- **Four job kinds for YouTube**: diagnostic report, concrete
  recommendations, new content ideas, weekly monitor digest.
- **Live agent logs** stream into the dashboard via Supabase Realtime.
- **Scheduled jobs** via a cron-style `schedules` table; a tick endpoint
  enqueues due schedules every minute.
- **Pluggable domains**: every domain exports `tools`, `prompts`, and
  `jobKinds` against a single `DomainPlugin` interface in
  [`packages/core`](packages/core/src/types.ts).

## Project layout

```
apps/
  web/                  Next.js 16 dashboard (Vercel)
  worker/               Always-on Node poller (Fly.io)
packages/
  core/                 Shared types, domain plugin interface, registry
  domain-youtube/       YouTube plugin: tools + prompts
  domain-coachflow/     Placeholder for the future coachflow plugin
supabase/
  migrations/           Numbered, idempotent SQL migrations
```

## Getting started

Prerequisites: Node 20+, pnpm 9+, a Supabase project, an Anthropic API
key, a Google Cloud OAuth client with YouTube Data + Analytics scopes.

```bash
# install
pnpm install

# copy and fill env vars
cp .env.example .env.local

# apply the migration to your Supabase project (paste into the SQL editor
# or use the Supabase CLI)
psql "$DATABASE_URL" -f supabase/migrations/01_init.sql

# run the dashboard
pnpm dev:web

# run the worker (separate terminal)
pnpm dev:worker
```

The worker requires `SUPABASE_SERVICE_ROLE_KEY` (it bypasses RLS to
claim jobs and write events/artifacts on behalf of users).

## Deployment

- **Dashboard** → Vercel (free Hobby plan is sufficient).
- **Worker** → Fly.io free tier. From `apps/worker/`:
  ```bash
  fly launch --no-deploy   # one-time
  fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=...
  fly deploy
  ```

## Database

Tables (see [`supabase/migrations/01_init.sql`](supabase/migrations/01_init.sql)):

| table         | purpose                                                |
| ------------- | ------------------------------------------------------ |
| `jobs`        | units of work; status flows queued → running → done    |
| `job_events`  | append-only log stream, fanned out via Realtime        |
| `artifacts`   | what jobs produce (reports, rewrites, idea briefs)     |
| `integrations`| per-user OAuth credentials (YouTube, etc.)             |
| `schedules`   | cron-style recurring job templates                     |

Plus a `claim_next_job()` SECURITY DEFINER function used by the worker
for atomic, lock-free job claiming via `UPDATE ... FOR UPDATE SKIP LOCKED`.

Migrations follow agentflow's idempotent conventions:
`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, RLS policies
wrapped in `DO $$ ... END $$` blocks. Re-running on a clean DB is a
no-op.

## Adding a new domain

1. Create `packages/domain-<slug>/` mirroring `domain-youtube/`.
2. Implement `DomainPlugin` from [`@agentflow/core`](packages/core/src/types.ts):
   `slug`, `displayName`, `jobKinds`, `buildTools`, `buildSystemPrompt`,
   `buildUserPrompt`.
3. Register it in [`apps/worker/src/index.ts`](apps/worker/src/index.ts) (and
   eventually in a dashboard registry for the UI).
4. Add OAuth flow + integration row if the domain needs third-party
   credentials.

## Status

Phase 1 scaffold is in place. Outstanding:

- [ ] Wire up `@anthropic-ai/claude-agent-sdk` in [`apps/worker/src/runAgent.ts`](apps/worker/src/runAgent.ts)
- [ ] Implement YouTube tool handlers (replace stubs in [`packages/domain-youtube/src/tools.ts`](packages/domain-youtube/src/tools.ts))
- [ ] Google OAuth flow + token storage in [`apps/web/app/api/oauth/google/callback/route.ts`](apps/web/app/api/oauth/google/callback/route.ts)
- [ ] Job detail page with live event subscription
- [ ] Schedules tick endpoint
# agentflow
