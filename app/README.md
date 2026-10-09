# Mediara — caregiver chatbot that never re-asks a dose

Express chatbot + Telegram bot with long-term memory on Walrus Memory (`@mysten-incubation/memwal`).
You teach it meds, allergies, routines once and it doesn't forget across sessions; doctor-visit summaries come from recall only.

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
own `MemWalAccount` on-chain** and registers Mediara's delegate key — two
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
| `GET` | `/` | — | Dark premium landing (hero, 3-step how-it-works, live evidence strip, Launch app → `/app`) |
| `GET` | `/app` (+ `/app/*` fallback, static `/app/*` assets) | — | React SPA (hash routing; without a build falls back to the legacy server chat) |
| `POST` | `/api/chat` | JSON `{userId, message}` (≤500 chars) | `{reply, recalled[], recalledMeta[], memoryScope, identity, savedBlob, mode, disclaimer}` — recalls top-5, coded allergy guard, LLM, gated auto-save. Signed-in wallet users read/write **their own vault** |
| `POST` | `/api/chat/stream` | Same body as `/api/chat` (same pipeline, same budgets, same `chatLimiter`) | SSE live tokens: `thinking` → `token*` → `done` (guards stay instant JSON with zero tokens, whole-at-once replies go as a single token — see below) |
| `GET` | `/api/summary` | `?user=<id>` (default `demo-mom`) | `{user, mode, medications[], allergies[], routine[], familyAndCare[], blobCount, disclaimer}` from recall only |
| `GET` | `/memory` | `?user=<id>` | HTML memory receipts page (wallet users see their own vault) |
| `GET` | `/demo` | `?persona=day1\|day7` | LIVE before/after: real recall on empty `demo-day1` vs taught namespace |
| `GET` | `/guard-proof` | — | Public tamper-evident ledger of every STOP/CAUTION (hash-chained; `verify()` runs on every view) |
| `GET` | `/api/guard-proof` | — | Ledger as JSON with `{count, verify, entries}` |
| `GET` | `/api/arena` | — | Public eval-trap corpus `{challenges[6]}` (5 STOP traps + 1 Tylenol control; static, no auth — like `/api/models`) |
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

### Streaming (`POST /api/chat/stream`)

Same body, same pipeline (budget gate, identity, recall, guards, research,
write gate — one shared handler, never forked), same `chatLimiter`. Only the
delivery differs; `Content-Type` is `text/event-stream`:

| Event | Payload | When |
|---|---|---|
| `thinking` | `{thinking[], recalledMeta[]}` (full reasoning trace + cited facts) | FIRST, before any token, exactly once per stream (the full trace, with Answer + Memory-write entries, rides on `done`) |
| `token` | `{t:"..."}` (one live provider chunk each — forwarded as it arrives, flushed per write, never synthesized/word-split/timed; concatenated = `done.reply`) | One or more on the NON-guard path (exactly one for whole-at-once replies — keyless fallback, non-streaming provider body); zero for safety verdicts |
| `done` | `{reply, recalled[], recalledMeta[], memoryScope, identity, savedBlob, memoryPersisted, memoryOff, thinking, mode, disclaimer, budget}` (same shapes as `/api/chat`) | LAST, exactly once (budget rides here only — never on tokens) |
| `error` | Same JSON error contract as `/api/chat` (`400`/`401`/`403`/`409`/`429`/`503`, e.g. `{error, loginRequired, demoUser, remaining, resetsAt, resetAt, resetInHrs}`) with the same HTTP status | Instead of tokens, exactly once |

Rules: STOP/CAUTION guard replies are deterministic templates — they arrive
as immediate `thinking` + `done` with **zero** `token` events (a safety
verdict never dribbles out token-by-token). The keyless/memory-fallback
answer and any non-streaming provider body each arrive whole as a **single**
`token` + `done` (degraded but honest — no fake typing on the server).
Budget turns are consumed exactly once per request (same `touchUser`
semantics as `/api/chat`), pre-charged before any work is served (non-stream:
right after the budget check, before recall; stream: before the first token
is emitted): a turn that streams ≥1 token stays charged even if the client
disconnects mid-stream (at-least-once — no free provider tokens), while only
an abort before the charge stays uncharged. A client that disconnects mid-stream still stores no
partial memory (no transcript trace, no blob) and gets no `done`. Order is
always `thinking` → `token*` → `done`, with nothing after
`done`; every write flushes (`X-Accel-Buffering: no`). A ledger failure
before the first token is a pure `error` event with zero tokens sent (never
`thinking` → `token` → `error`).

```bash
curl -N -X POST localhost:3001/api/chat/stream -H 'Content-Type: application/json' \
  -d '{"userId":"demo-mom","message":"What meds does mom take?"}'
```

## Scripts

| Script | Command | Notes |
|---|---|---|
| `npm test` | `node src/selftest.js && node src/wallet.test.js && node --test src/routes.test.js && node --test src/stream.test.js && node --test src/brandguard.test.js && node --test src/stats.test.js && node --test src/db.test.js && node --test src/window.test.js && node --test src/budget-keys.test.js && node --test src/walletOnboard.test.js && node --test src/frontend.test.js && node --test src/t3.test.js && node --test src/gatewave5.test.js && node --test src/gatewave8.test.js && node --test src/hardening.test.js && node --test src/loghygiene.test.js` | 729 checks (317 core + 86 wallet incl. 15 onboarding regressions + 79 route + 27 stream + 4 brandguard + 12 stats + 8 db + 15 window + 14 budget-keys + 15 onboarding + 28 frontend + 10 t3 + 25 gatewave5 + 13 gatewave8 + 72 hardening + 4 loghygiene) |
| `npm run stats` | `node src/stats.js` | **Judge command**: per-user memory counts → the ≥3 users × ≥10 memories requirement. `-- --live` reads Walrus itself; `-- --json` is machine-readable. Exit 0 = requirement met. Appends `evidence/USAGE-LEDGER.md` |
| `npm run dev` / `npm start` | `node src/server.js` | Web widget on `$PORT` (default 3001) |
| `npm run demo:seed` | `node src/seed-demo.js` | 3-fact local quickstart for `demo-day7` (no keys); full 12-fact seed = `seed:10` (mainnet) |
| `npm run seed` / `npm run seed:10` | `node src/seed10.js [userId]` | Writes 12 facts, needs mainnet keys; appends to `evidence/blob-ledger.md` |
| `npm run verify:memwal` | `node src/verify.js [userId]` | Health + write/recall probe, needs mainnet keys |

Test-only fault hooks (never set in prod): `DD_FAULT_RECALL=throw|slow|hang` (degraded/slow/hung recall) + `DD_FAULT_LEDGER=throw` (budget-charge failure) — the degraded-recall, pre-token-abort, and ledger-failure pins.

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
- All write surfaces rate-limited per IP (auth 10/min, onboarding 12/min, chat 30/min); per-user chat budgets, all on a rolling 24h window (vault 30/rolling-24h via `DD_DAY_LIMIT_WALLET`; demo namespaces capped by `DD_DAY_LIMIT_DEMO`; the anon per-browser `guest:<hash12>` day budget now meters reads only — personal chat requires sign-in, 401 otherwise); shared demo namespaces are anonymous-read-only. JSON bodies capped at 16 KB; chat messages capped at 500 chars.
- Cost today is $0 (relayer-sponsored Walrus writes + free OpenRouter models, both upstream-rate-limited) — the budgets above guard rate, not money. If usage ever outgrows free tiers, the decision is per-vault daily caps vs user-pays (Sui micropayment before chat), not passthrough billing without caps.
- Security headers on every response: CSP (default-src 'none'), nosniff, DENY framing, no-referrer, restrictive Permissions-Policy.
- Identity separation is enforced server-side: wallet users get a delegate client scoped to their own account; the shared channel is never mixed into their namespace.
- `src/verify.js` — Mainnet health + write/recall probe.
- `src/selftest.js` — 317 offline tests (memory/safety/regression core + dead-credential tagging + chain-id pins + census scope + save-intent + research gate + teaching-order intent + spelling variants + generic-admin-verb orders + NFKC homoglyph fold + tokenizer diacritic/ligature/splitter fold + recap-exemption/OOV-junk + DRUG-for-symptom orders); `src/wallet.test.js` — 78 wallet/auth/crypto/rate-limit/build-error classifier (incl. 7 onboarding regressions); `src/walletOnboard.test.js` — onboarding contract suite; `src/brandguard.test.js` — 4 real-world brand guard checks; `src/routes.test.js` — 79 HTTP-level (guards, identity, budgets, demo read-only, dashboard, thinking trace, seed-status honesty, explicit-save, demo-bypass, demo-hijack, scope matrix, G3-FIX wave, teaching-order STOP incl. memory-off, recap honesty, for-symptom orders, expired-parser 401, vault-badge session scope, overlong-400 parity); `src/stream.test.js` — 27 SSE streaming (per-token live chunks, STOP/CAUTION instant-JSON with zero tokens, single-token whole-reply fallback + non-streaming body, budget-once, 400/401/expired-401/429 parity, charge-on-abort + pre-token-abort-uncharged + abort-transcript-clean + ledger-failure-zero-tokens, recap-abort parity, rewrite parity, single-thinking, abort propagation, guarded error-end, demo read-only, SSE parser units, fixpoint parity, teaching-order STOP); `src/stats.test.js` — 12 usage/proof (anon-redacted); `src/db.test.js` — 8 SQLite store; `src/window.test.js` — 15 rolling-window units + route contract + prune-to-cap + fail-closed cap; `src/budget-keys.test.js` — 14 canonical-union units; `src/frontend.test.js` — 5 legacy + 23 SPA checks; `src/t3.test.js` — 10 lose-list P0s; `src/gatewave5.test.js` — 25 wave-5 hunter repros; `src/gatewave8.test.js` — 13 final-gate repros (compare/nudge guard, IP backstop, capped/stale flags); `src/hardening.test.js` — 72 read backstop, junk-id refusals, union honesty, budget edges, eval cleanup, 0X carve-out, whitespace fixpoint, wave-12 scope fork + wave-13 leading-dash/credential/verify fixes + reviewer/README parity + memory-off guard enforcement (H8) + object-id 400s (H9) + teaching-shaped orders (H10) + NFKC homoglyph fork (H11) + usage id uniformity (H12) + undefined-body guard (H13) + dispensing-verb/modal orders (H14) + allergy-question yielding to orders (H15) + 48-prefix summary isolation (H16) + spaced can-not teaching (H17) + user-x9/invisible demo nesting (H18) + single-letter drug-typo guards (H19) + transposed-spelling guards (H20) + dotted-spelling guards (H21) + short-brand typo guards (H22) + multi-ingredient brand guards (H23) + distance-2 typo guards (H24) + class-word typo guards (H25) + fragment/common-word false-STOP guards (H26) + homoglyph scope fold (H27) + shattered class names (H28) + definitional hard-STOP pin (H29) + extended fold parity (H30) + long-id invisible-hash parity (H31) + cross-clause allergy widening (H32) + wallet 30-cap/rolling + 429-shape pins (H33-H35) + union scan bound (H36) + credential-400 sign-in action (H37) + NEL uniformity (H38) + session strictness/quoted-cookie honesty (H39) + novel ingestion-verb orders (H40) + novel ingestion-verb batch-2 orders (H42) + infix clause-splitter rejoin (H41) + injection write-gate (A) + research-verify refusal (B) + burst pre-charge (C) + hyphen compounds (D) + abort-signal recall (E) + abort receipt (F) + obfuscated-injection write-gate (A2) + demo-seed integrity (G) + disclosure-verb write-gate (A3) + disclosure-synonym write-gate (A4); `src/loghygiene.test.js` — 4 static log-allowlist checks — `npm test` runs all fifteen suites = 729 (sixteen suites).
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
- **LLM echo:** without `OPENROUTER_API_KEY` replies are `[no LLM key] …` echoes with memory-char counts — memory flow still works. Default model `google/gemma-4-31b-it:free` via `LLM_MODEL` (free-first chain; see GET /api/models for the live list).

> Medical disclaimer: Mediara reminds and flags only — never adjusts dosage. Always confirm with your doctor.

## React SPA (app/web) — the premium UI at `/app`

Vite + React 18 + TypeScript, hand-vendored shadcn-style primitives (zero runtime
deps, MIT-clean), charcoal dark premium shell: sidebar history + centered chat.
Guests browse the shared demo instantly with per-browser memory (persisted `X-Device-Id` → server
`guest:<hash12>` day budget on reads); personal chat requires wallet sign-in
(401 + sign-in action when signed out) — wallet sign-in opens your own
vault + the bigger `DD_DAY_LIMIT_WALLET` budget.

| Env | Meaning |
|---|---|
| Demo (same-origin, default) | Local stand-in memory; anonymous guests metered per browser on reads (`DD_DAY_LIMIT_ANON`/day, demo namespaces capped by `DD_DAY_LIMIT_DEMO`; personal chat requires sign-in) |
| Mainnet (reachable candidate backend) | Real Walrus memory; wallet vaults; coming-soon gate while unreachable — never a URL prompt |

| Command | Purpose |
|---|---|
| `npm run build:web` (in `app/`) | install `web/` deps + `vite build` → `web/dist/` (committed, so clone-and-run works; clears a user-level `allow-scripts` npmrc entry that otherwise fails `--prefix` installs with EALLOWSCRIPTS) |
| `npm run dev --prefix web` | Vite dev on :5173, `/api` proxied to the Express server on :3001 |

- Hash routing (`#/memory`, `#/demo`, `#/replay`, `#/compare`, `#/proof`, `#/stats`, `#/print`, `#/wallet`) — only `/app` + static `/app/*` need serving.
- Express serves the dark server-rendered landing at `/`, `web/dist` assets under `/app` (immutable hashed files) and `index.html` at `/app` (+ `/app/*` fallback); without a build both fall back to the legacy server-rendered chat.
- CSP unchanged (`script-src 'self'` — one bundled module file, no inline scripts).
- Chat history lives in `localStorage` per user id; memory itself stays on Walrus.
