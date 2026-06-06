# agentflow

Personal AI assistant with pluggable tools. Chat-driven with multi-provider
BYOK (Anthropic, OpenAI, Google), GitHub integration for reading code and
opening PRs, and **automations** — standing instructions for an autonomous
agent to watch GitHub repos and act on new issues.

## Highlights

- **Chat UI** with streaming text, live tool-call rendering, and markdown.
- **BYOK** for AI providers — your API key, encrypted at rest with
  AES-256-GCM, never stored in plain text.
- **GitHub OAuth** integration: connect any account, agent reads repos,
  files, directories, issues, and opens PRs on your behalf.
- **Automations** — "watch repo X for new issues, work on each one." The
  background worker polls every 30s and runs an autonomous agent to read
  each issue, propose a fix, and open a PR (or post a clarification
  comment if it's unclear).

## Project layout

```
apps/
  web/                  Next.js 16 dashboard (Vercel)
  worker/               Always-on polling worker (Fly.io)
packages/
  core/                 Shared agent runner, AI providers, GitHub tools,
                        crypto. Used by both apps.
supabase/
  migrations/           Numbered, idempotent SQL migrations
```

## Getting started

Prerequisites: Node 20+, pnpm 9+, a Supabase project.

```bash
pnpm install
cp .env.example .env.local
# fill in the env vars (see below)

# apply migrations: push to GitHub → Supabase auto-deploys via the
# integration. Locally: paste SQL into the Supabase SQL Editor or run
# `supabase db push` if you have the CLI linked.

# run the web app
pnpm dev:web                # http://localhost:3000

# in another terminal, run the worker (only needed for automations)
pnpm dev:worker
```

### Env vars

In `.env.local` at the repo root (the web app symlinks to it):

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...   # or legacy JWT anon key
SUPABASE_URL=https://<project-ref>.supabase.co     # used by the worker
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...            # or legacy JWT service-role

# App secret for encrypting user credentials. Generate ONCE per environment.
# Do not change after you've encrypted any keys, or they become unreadable.
#   openssl rand -hex 32
AGENTFLOW_SECRET_KEY=<64 hex chars>

# OAuth apps — shared apps every user signs in through.
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
TIKTOK_OAUTH_CLIENT_KEY=
TIKTOK_OAUTH_CLIENT_SECRET=
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
```

Register each OAuth app once at:
- GitHub: github.com/settings/developers
- Google / YouTube: console.cloud.google.com/apis/credentials — enable YouTube Data API v3 + YouTube Analytics API
- TikTok: developers.tiktok.com — Login Kit + Display API
- Instagram: developers.facebook.com — Instagram Login product

For each, set the authorized redirect URI to `http://localhost:3000/api/oauth/PROVIDER/callback` for dev and `https://YOUR-VERCEL-URL/api/oauth/PROVIDER/callback` for production. Each provider requires its own verification/approval flow before non-test users can connect.

## Deployment

### Web app — Vercel

1. Push the repo to GitHub.
2. Vercel → "Add new project" → import the repo. Root directory: `apps/web`.
3. Project Settings → Environment Variables: paste every var from
   `.env.local`. **Use a separate GitHub OAuth App with the production
   callback URL** (`https://<your-vercel-domain>/api/oauth/github/callback`).
4. Deploy.

### Worker — Fly.io

The worker is what makes automations *automatic*. Without it deployed,
automations only run when you click "Run now" in the dashboard or run
`pnpm dev:worker` locally.

From `apps/worker/`:

```bash
fly launch --no-deploy --name agentflow-worker
fly secrets set \
  SUPABASE_URL=https://<project>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<sb_secret_or_service_role_jwt> \
  AGENTFLOW_SECRET_KEY=<same value as web app>
fly deploy
fly logs              # watch it poll
```

`POLL_INTERVAL_MS` defaults to 30 seconds; set it as an env in `fly.toml`
if you want a different cadence.

## Database

Migrations under [`supabase/migrations/`](supabase/migrations/) are
timestamped and idempotent. The auto-deploy GitHub integration applies
new ones on every push to `main`.

| table              | purpose                                                |
| ------------------ | ------------------------------------------------------ |
| `user_api_keys`    | encrypted BYOK keys (one row per user × provider)      |
| `integrations`     | encrypted OAuth tokens (GitHub today; YT/etc. later)   |
| `conversations`    | chat threads                                           |
| `messages`         | chat turns; stores AI-SDK content blocks verbatim      |
| `automations`      | standing instructions (e.g. "watch repo X")            |
| `automation_runs`  | one row per (automation, issue) attempt                |
| `jobs` / `schedules` | reserved for future use; not active in v1            |

RLS is on for every user-owned table. The worker uses the service role
key to bypass RLS (it acts on behalf of all users, decrypts their
credentials with `AGENTFLOW_SECRET_KEY`).

## How automations work end-to-end

1. User signs in to the web app, configures a BYOK key, connects GitHub.
2. User adds an automation in Settings → Automations: "Watch
   `owner/repo` for new issues."
3. **Worker** (Fly.io) polls `automations` every 30s. For each enabled
   one, it fetches open issues from GitHub.
4. It skips any issue with a successful run in `automation_runs`.
5. For the next unhandled issue, it inserts a `running` row, calls the
   autonomous `runIssueAgent` (which uses the user's stored AI key and
   GitHub token), and updates the row with the outcome.
6. The agent reads the issue, explores the repo, opens a PR (or posts a
   clarification comment), and stops.

Each tick processes at most one issue per automation to keep runs short
and bounded. Click again in the dashboard or wait for the next tick to
process the next outstanding issue.
