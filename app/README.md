# DoseDaughter — caregiver chatbot that never re-asks a dose

Express chatbot + Telegram bot with long-term memory on Walrus Memory (`@mysten-incubation/memwal`).
Remembers meds, allergies, routines across sessions; compiles doctor-visit summaries from recall only.

## 2-min quickstart (local, no keys)

```bash
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"  # engines: node>=20
node --version   # expect v22.x
npm install
cp .env.example .env   # defaults already work for local demo
npm test               # offline self-test, no network
npm run dev            # server on :3001
```

Try it (readers use their own curl; Python fallback below):

```bash
curl -X POST localhost:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo-mom","message":"I take Metformin 500mg at 8pm after food"}'
curl 'localhost:3001/api/summary?user=demo-mom'
curl 'localhost:3001/memory?user=demo-mom'
```

Python (no curl binary needed):

```python
import json, urllib.request
base = "http://localhost:3001"
def post(path, obj):
    req = urllib.request.Request(base + path, data=json.dumps(obj).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(req))
print(post("/api/chat", {"userId": "demo-mom", "message": "I take Metformin 500mg at 8pm after food"}))
print(urllib.request.urlopen(base + "/api/summary?user=demo-mom").read().decode()[:500])
```

## Identity model — two channels, one memory story

**Wallet users (full-stack Walrus path).** A visitor signs in with a Sui wallet
(personal-message signature, verified server-side — free), then creates **their
own `MemWalAccount` on-chain** and registers DoseDaughter's delegate key — two
transactions that **they sign and pay for**. After that, every chat memory lands
in *their* account as Seal-encrypted Walrus blobs; the app wallet never touches
user data and the grant is revocable from the Walrus Memory dashboard.

**Shared demo channel + Telegram.** Caregivers without wallets use
`demo-mom` (web) or the Telegram bot (`user-tg-<chatId>` namespaces); memory is
stored under the app's agent account. Honest labeling everywhere: chat cards
show which scope answered (`your vault` vs `shared demo channel`), and local
dev mode is never presented as Mainnet.

## Endpoints

| Method | Path | Params / body | Returns |
|---|---|---|---|
| `GET` | `/` | — | Chat landing HTML + links to `/memory`, `/demo` |
| `POST` | `/api/chat` | JSON `{userId, message}` (≤500 chars) | `{reply, recalled[], recalledMeta[], memoryScope, identity, savedBlob, mode, disclaimer}` — recalls top-5, coded allergy guard, LLM, gated auto-save. Signed-in wallet users read/write **their own vault** |
| `GET` | `/api/summary` | `?user=<id>` (default `demo-mom`) | `{user, mode, medications[], allergies[], routine[], familyAndCare[], blobCount, disclaimer}` from recall only |
| `GET` | `/memory` | `?user=<id>` | HTML memory receipts page (wallet users see their own vault) |
| `GET` | `/demo` | `?persona=day1\|day7` | LIVE before/after: real recall on empty `demo-day1` vs taught namespace |
| `GET` | `/guard-proof` | — | Public tamper-evident ledger of every STOP/CAUTION (hash-chained; `verify()` runs on every view) |
| `GET` | `/api/guard-proof` | — | Ledger as JSON with `{count, verify, entries}` |
| `GET` | `/api/usage` | `?format=md` | Usage evidence: per-user memory counts vs the ≥3×≥10 requirement (markdown via `format=md`) |
| `GET` | `/api/proactive` | `?user=<id>` | Morning med plan + whole-namespace interaction cross-check (recall only, deterministic) |
| `POST` | `/api/nudge` | `{users:[id], hour}` | Runs the proactive tick per user on demand (scheduler-equivalent; hour 0–11 → morning brief) |
| `GET` | `/healthz` | — | `{ok, mode, time}` for uptime checks and deploy verification |
| `GET` | `/api/auth/message` · `POST /api/auth/verify` · `POST /api/auth/logout` | wallet sign-in (signature → HMAC session cookie) | rate-limited |
| `GET` | `/api/wallet/status` | session cookie | `{signedIn, onboarded, needsRelink, accountId}` |
| `POST` | `/api/wallet/onboard/create` · `/link` · `/complete` | onboarding steps (build tx → wallet signs → submit+verify) | `{txBytesBase64}` / `{stage, accountId, digest}` |
| `POST` | `/api/wallet/relink` | session cookie | re-links an account that exists onchain but not locally |

```bash
curl -X POST localhost:3001/api/chat -H 'Content-Type: application/json' \
  -d '{"userId":"demo-mom","message":"What meds does mom take?"}'
curl 'localhost:3001/api/summary?user=demo-mom'
curl 'localhost:3001/demo?persona=day7'
```

```python
print(post("/api/chat", {"userId": "demo-mom", "message": "What meds does mom take?"}))
```

## Scripts

| Script | Command | Notes |
|---|---|---|
| `npm test` | `node src/selftest.js && node src/wallet.test.js && node --test src/routes.test.js && node --test src/stats.test.js && node --test src/frontend.test.js` | 326 checks (180 core + 61 wallet + 44 route + 12 stats + 7 db + 22 frontend), no network |
| `npm run stats` | `node src/stats.js` | **Judge command**: per-user memory counts → the ≥3 users × ≥10 memories requirement. `-- --live` reads Walrus itself; `-- --json` is machine-readable. Exit 0 = requirement met. Appends `evidence/USAGE-LEDGER.md` |
| `npm run dev` / `npm start` | `node src/server.js` | Web widget on `$PORT` (default 3001) |
| `npm run demo:seed` | `node src/seed-demo.js` | 3-fact local quickstart for `demo-day7` (no keys); full 12-fact seed = `seed:10` (mainnet) |
| `npm run seed` / `npm run seed:10` | `node src/seed10.js [userId]` | Writes 12 facts, needs mainnet keys; appends to `evidence/blob-ledger.md` |
| `npm run verify:memwal` | `node src/verify.js [userId]` | Health + write/recall probe, needs mainnet keys |

## File map

- `src/server.js` — Express app: chat, memory, demo, wallet auth + onboarding routes; recall → coded allergy guard → LLM → gated auto-save flow (exports `app`; listens only when run directly).
- `src/page.js` — Server-rendered pages (chat widget, `/memory` receipts, `/demo` before/after) — no build step, all dynamic text escaped.
- `src/memory.js` — MemWal wrapper: namespaces, `shouldRemember` write gate, `findConflict` allergy guard, 500-byte cap, `MAX_DISTANCE=0.7` recall filter, system prompt.
- `src/localClient.js` — File-backed stand-in (same interface, `.local-memory.json`, `local-*` ids) for keyless demo.
- `src/telegram.js` — Polling Telegram bot (`/start /memory /summary /reset`), per-chat `user-tg-<chatId>` namespace.
- `src/seed10.js` — Seeds 12 caregiver facts for one user (mainnet only).
- `src/walletAuth.js` — Wallet signature verification (`@mysten/sui/verify`) + HMAC session cookies (HttpOnly, SameSite=Lax, Secure on https).
- `src/onchain.js` — Sui onchain ops via GraphQL: `create_account` / `add_delegate_key` PTBs, `AccountCreated` event lookup, MemWalAccount verification, balance probe. Mainnet package/registry IDs verified on-chain.
- `src/onboarding.js` — Orchestrates the two-transaction user onboarding (user signs, user pays), verifies owner + delegate on the account object before use.
- `src/userRegistry.js` — Per-user store: address → `{accountId, delegateKey…}` with **AES-256-GCM encryption at rest** (key derived from `SESSION_SECRET`); fails loudly instead of returning garbage.
- `src/cryptoUtils.js` / `src/rateLimit.js` — Secret-at-rest crypto; dependency-free fixed-window rate limiter.
- `src/usage.js` — Usage evidence (`UsageTracker`: the per-user blob ledger behind `/api/usage` and `npm run stats`), `GuardProof` (hash-chained, tamper-evident STOP/CAUTION ledger on `/guard-proof`), and the proactive engine (`morningBriefFromRecall`, `nightlyCrossCheckFromRecall`, `tickOnce`).
- `src/stats.js` — Judge-facing CLI: per-user usage evidence from the server ledger, or **live from Walrus** with `-- --live` (multi-angle recall per namespace, walruscan links, honest exit code: 0 only when ≥3 users × ≥10 memories is met).

## Security posture

- Signatures verified server-side (`verifyPersonalMessageSignature`); the client-supplied address is never trusted — it is re-derived from the verified key.
- Sessions: HMAC-signed tokens, HttpOnly + SameSite=Lax cookies, Secure flag on https, 7-day expiry; no session store to lose.
- Delegate private keys encrypted at rest (AES-256-GCM); wrong `SESSION_SECRET` fails closed (null), never garbage.
- All write surfaces rate-limited per IP (auth 10/min, onboarding 12/min, chat 30/min); per-user daily chat budgets (anon 20/day, vault 200/day via `DD_DAY_LIMIT_ANON`/`DD_DAY_LIMIT_WALLET`); shared demo namespaces are anonymous-read-only. JSON bodies capped at 16 KB; chat messages capped at 500 chars.
- Cost today is $0 (relayer-sponsored Walrus writes + free OpenRouter models, both upstream-rate-limited) — the budgets above guard rate, not money. If usage ever outgrows free tiers, the decision is per-vault daily caps vs user-pays (Sui micropayment before chat), not passthrough billing without caps.
- Security headers on every response: CSP (default-src 'none'), nosniff, DENY framing, no-referrer, restrictive Permissions-Policy.
- Identity separation is enforced server-side: wallet users get a delegate client scoped to their own account; the shared channel is never mixed into their namespace.
- `src/verify.js` — Mainnet health + write/recall probe.
- `src/selftest.js` — 180 offline tests (memory/safety/regression core); `src/wallet.test.js` — 61 wallet/auth/crypto/rate-limit; `src/routes.test.js` — 44 HTTP-level (guards, identity, budgets, demo read-only, dashboard, thinking trace); `src/stats.test.js` — 12 usage/proof (anon-redacted); `src/db.test.js` — 7 SQLite store; `src/frontend.test.js` — 5 legacy + 17 SPA checks — `npm test` runs all six = 326.
- `api/index.js` + `vercel.json` + `DEPLOY.md` — Vercel deploy wiring (serverless entry, rewrites, 5-min guide; prod MUST be mainnet — serverless disk is ephemeral).

## Local vs Mainnet — honesty box

| | Local (default) | Mainnet (`MEMWAL_MODE=mainnet`) |
|---|---|---|
| Backend | `localClient.js` → `.local-memory.json` | Real Walrus Memory via hosted relayer |
| Blob ids | `local-*` — **NEVER Mainnet, never share as blobs** | Real Walrus blob ids, viewable on `walruscan.com/mainnet` |
| Keys | None needed | Requires owner `MEMWAL_ACCOUNT_ID` + `MEMWAL_PRIVATE_KEY` — **never run without owner keys** |
| `/memory` banner | `LOCAL DEMO` | Mainnet storage notice |

## Telegram setup

```bash
# 1. Chat @BotFather on Telegram → /newbot → copy token
# 2. From app/: npm i node-telegram-bot-api
# 3. Add TELEGRAM_BOT_TOKEN=<token> to .env (keep MEMWAL_MODE=local unless owner keys present)
npm i node-telegram-bot-api
node src/telegram.js
# Talk to your bot: /start → send 3 facts → /memory → /summary → /reset
```

Per-chat namespace is `user-tg-<chatId>`; `/reset` clears local rows only (mainnet blobs persist till epoch expiry).

## Troubleshooting

- **Node version:** needs `node>=20` — `export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"`, then `node --version`.
- **401 / staging-vs-mainnet:** relayer defaults to `https://relayer.memory.walrus.xyz`; a 401 usually means staging keys against the mainnet relayer (or vice versa) — match `MEMWAL_SERVER_URL` to where the account was created, or run local (`MEMWAL_MODE` unset).
- **Index lag:** `rememberAndWait` waits for the job, but recall index can lag seconds — `verify.js` warns `retry in 10s if 0`; re-GET `/memory` after a pause.
- **Distance filter:** recall keeps only `distance < 0.7` (`MAX_DISTANCE` in `memory.js`); empty `recalled: []` means "no topical hit", not a bug — the bot then asks for the 3 onboarding facts.
- **Telegram won't start:** `Missing dependency: node-telegram-bot-api` → run `npm i node-telegram-bot-api` from `app/`; `Missing TELEGRAM_BOT_TOKEN` → add it to `.env`.
- **LLM echo:** without `OPENROUTER_API_KEY` replies are `[no LLM key] …` echoes with memory-char counts — memory flow still works. Default model `google/gemini-2.5-flash` via `LLM_MODEL`.

> Medical disclaimer: DoseDaughter reminds and flags only — never adjusts dosage. Always confirm with your doctor.

## React SPA (app/web) — the premium UI at `/`

Vite + React 18 + TypeScript, hand-vendored shadcn-style primitives (zero runtime
deps, MIT-clean), white/greyish ChatGPT-type shell: sidebar history + centered chat.

| Command | Purpose |
|---|---|
| `npm run build:web` (in `app/`) | install `web/` deps + `vite build` → `web/dist/` (committed, so clone-and-run works) |
| `npm run dev --prefix web` | Vite dev on :5173, `/api` proxied to the Express server on :3001 |

- Hash routing (`#/memory`, `#/demo`, `#/replay`, `#/compare`, `#/proof`, `#/stats`, `#/print`, `#/wallet`) — no server fallback needed.
- Express serves `web/dist` at `/app` (immutable hashed assets) and `index.html` at `/`; without a build it falls back to the legacy server-rendered chat.
- CSP unchanged (`script-src 'self'` — one bundled module file, no inline scripts).
- Chat history lives in `localStorage` per user id; memory itself stays on Walrus.
