# Deploy Runbook — Mediara on Railway (owner-run, SSO)

No live link exists yet. The owner runs every step below. Nothing here needs
committing first, and no secrets go in git at any point.

What gets deployed: the Express server in `app/` (`node src/server.js`) plus
the committed React bundle (`app/web/dist`) served at `/app`. Railway injects
`PORT` and the server respects it (`app/src/server.js`). Health checks hit
`/healthz`. Coherence checked against `app/railway.json`, `app/RAILWAY.md`,
`app/.env.example`, and the route table in `app/src/server.js`
(`/healthz`, `/`, `/app`, `/api/models`, `/api/seed-status`, `/api/chat`).

## 0. Preconditions

- You (the owner) hold the mainnet keys: `MEMWAL_ACCOUNT_ID`,
  `MEMWAL_PRIVATE_KEY`, plus an `OPENROUTER_API_KEY` for real replies.
- The Railway CLI works here via `npx @railway/cli`. Only `login` needs your
  browser (SSO). Everything else runs in the terminal.

## 1. Push the repo

```bash
cd /home/tejas/Tejas/walrus-session8
git status --porcelain | head -20
git push origin <branch>
```

Expected: push succeeds. Don't stage or commit anything you didn't intend;
the runbook never stages files.

## 2. Log in (you, one browser click)

```bash
cd /home/tejas/Tejas/walrus-session8/app
npx @railway/cli login
```

Expected: browser opens, SSO completes, CLI reports logged in.

## 3. Create and link the service

```bash
npx @railway/cli init        # name it mediara (creates project + service + env)
npx @railway/cli link        # confirm the linked project/service if asked
npx @railway/cli status
```

Expected: `status` shows project `mediara` (or your chosen name) linked.
If you prefer GitHub auto-deploys instead, connect the repo in the dashboard
and set the service **Root Directory to `app`** so `railway.json` is picked up.

## 4. Set environment variables

Dashboard → service → Variables, or one by one:

```bash
npx @railway/cli variables --set NIXPACKS_NODE_VERSION=22
npx @railway/cli variables --set MEMWAL_MODE=mainnet
npx @railway/cli variables --set MEMWAL_ACCOUNT_ID='<paste-account-id>'
npx @railway/cli variables --set MEMWAL_PRIVATE_KEY='<paste-private-key>'
npx @railway/cli variables --set SESSION_SECRET='$(openssl rand -hex 32)'
npx @railway/cli variables --set OPENROUTER_API_KEY='<paste-key>'
npx @railway/cli variables --set TRUST_PROXY=1
```

Generate the session secret properly first (don't paste the literal
`$(...)` above):

```bash
openssl rand -hex 32
```

Expected: each `--set` echoes the variable name. `SESSION_SECRET` is required
on mainnet; without it wallet onboarding fails closed instead of storing
plaintext keys. `TRUST_PROXY=1` is required because Railway terminates TLS at
its edge. Chat still guards and falls back without `OPENROUTER_API_KEY`, but
replies will be echo-only.

## 5. Add the persistence volume (else redeploys wipe memory)

Service → **Volumes** → New Volume, mount path **`/data`**, then set:

```bash
npx @railway/cli variables --set DD_LOCAL_STORE=/data/.local-memory.json
npx @railway/cli variables --set DD_USAGE_LEDGER=/data/usage-ledger.json
npx @railway/cli variables --set DD_GUARD_PROOF=/data/guard-proof.json
npx @railway/cli variables --set DD_REGISTRY_PATH=/data/.wallet-registry.json
```

Expected: volume listed on the service; four vars set. Without them the
JSON files live on ephemeral disk and vanish on redeploy.

## 6. Deploy

```bash
npx @railway/cli up
```

Expected: build uses Nixpacks, start command `node src/server.js`
(from `railway.json`), health check on `/healthz` passes, service reports
running with a public URL like `https://<you>.up.railway.app`.

## 7. Health check

```bash
export APP=https://<you>.up.railway.app
curl "$APP/healthz"
```

Expected (shape from `app/src/server.js`):

```json
{"ok":true,"mode":"mainnet","memory":"ok","registry":{...},"time":"..."}
```

`ok` must be `true` and `mode` must read `mainnet`. If `memory` reads
`degraded`, recall is faulted; check the relayer and keys before continuing.

## 8. Smoke tests (in order)

```bash
# Landing page
curl -s -o /dev/null -w '%{http_code}\n' "$APP/"

# React SPA (served from committed web/dist; falls back to legacy chat without a build)
curl -s -o /dev/null -w '%{http_code}\n' "$APP/app"

# Public model list (no auth)
curl "$APP/api/models"

# Seed status for the demo namespace
curl "$APP/api/seed-status?user=demo-mom"

# Demo chat turn (shared demo channel, anonymous-read path)
curl -X POST "$APP/api/chat" -H 'Content-Type: application/json' \
  -d '{"userId":"demo-mom","message":"What meds does mom take?"}'

# Doctor-visit summary compiled from recall only
curl "$APP/api/summary?user=demo-mom"
```

Expected:

- `/` → `200`.
- `/app` → `200` (HTML shell).
- `/api/models` → JSON list of available models.
- `/api/seed-status?user=demo-mom` → JSON with seed counts for the namespace.
- `/api/chat` → JSON `{reply, recalled[], recalledMeta[], memoryScope,
  identity, savedBlob, mode, disclaimer}` with HTTP `200`. A STOP-guard reply
  (e.g. asking for a drug the persona is allergic to) returns the coded
  template with zero LLM tokens, still `200`.
- `/api/summary` → JSON `{user, mode, medications[], allergies[], routine[],
  familyAndCare[], blobCount, disclaimer}`.

Then open in a browser: `$APP/` (landing), `$APP/app` (chat UI),
`$APP/memory?user=demo-mom` (every fact with its walruscan blob link),
`$APP/demo?persona=day1` vs `$APP/demo?persona=day7` (before/after recall).

## 9. If something fails

- `401` on chat with staging-vs-mainnet mismatch: match `MEMWAL_SERVER_URL`
  to where the account was created, or confirm `MEMWAL_MODE=mainnet` with
  owner keys. Local mode is dev-only and loses memory on serverless.
- Empty `recalled: []` means no topical hit under the `distance < 0.7`
  filter, not a bug. The bot then asks for the three onboarding facts.
- Recall index can lag seconds after a write. Wait ~10s and re-GET `/memory`.
- Wallet onboarding `501`: `SESSION_SECRET` isn't set. Set it and redeploy.
- Never paste real keys into git, chat logs, or issue reports. Variables only.
