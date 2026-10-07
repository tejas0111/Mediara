# TEST-LOG — Mediara (Walrus Sessions 8)

> Append-style probe log. REAL rows only from `evidence/DEMO-TRANSCRIPT.md` §§1–9.
> Early rows' `local-*` ids are LOCAL DEMO records in `app/.local-memory.json`
> (file-backed stand-in, zero network) — NOT Walrus Mainnet. The later
> "MAINNET E2E" and "MAINNET SEED COMPLETE" sections ARE real Walrus Mainnet,
> with real blob IDs.
>
> **Current suite:** `npm test` = 334 passed (185 core + 61 wallet/crypto + 45 route-level + 12 stats + 7 db + 24 frontend); `npm run eval` = 30/30 guard+recall probes.

## E2E probes — 2026-09-20 ~22:46 UTC, `PORT=3001 node src/server.js`, MEMWAL_MODE unset → local, no LLM key

| # | Date | User | Query / Probe | Expected | Actual | Result | Blob id |
|---|------|------|---------------|----------|--------|--------|---------|
| 1 | 2026-09-20 | e2e-mom | Teach: `My mom takes Metformin 500mg at 8pm after food` | Saved, recalled=[] (cold) | `recalled: []`, `savedBlob` set, no-key fallback reply (479 chars) | ✅ PASS | LOCAL DEMO `local-0b1c191cc8f1` |
| 2 | 2026-09-20 | e2e-mom | Teach: `She is allergic to ibuprofen, rash` | Saved, prior med recalled | `recalled: [Metformin fact]`, `savedBlob` set | ✅ PASS | LOCAL DEMO `local-f82300ff296a` |
| 3 | 2026-09-20 | e2e-mom | Teach: `Dinner 7:30pm, bedtime 10pm` | Saved (bare-time routine gate) | `savedBlob` set | ✅ PASS | LOCAL DEMO `local-3436ef5e6054` |
| 4 | 2026-09-20 | e2e-mom | Recall: `What meds does mom take?` | 3/3 recalled, med first, question not saved | `recalled: 3/3` (med first), `savedBlob: null`, 575-char injection | ✅ PASS | LOCAL DEMO `local-0b1c191cc8f1` / `local-f82300ff296a` / `local-3436ef5e6054` |
| 5 | 2026-09-20 | e2e-mom | Trap (pre-STOP): `Can she take ibuprofen for headache?` | Allergy fact recalled via injection; question not saved | `recalled: [med, allergy]`, `savedBlob: null` (no coded STOP in v1 — recall only) | ✅ PASS | LOCAL DEMO `local-f82300ff296a` recalled |
| 6 | 2026-09-20 | e2e-mom | `GET /api/summary?user=e2e-mom` | All sections filled, blobCount 3 | meds 1 / allergies 1 / routine 1 / familyAndCare 3, `blobCount: 3` | ✅ PASS | LOCAL DEMO 3 blobs counted |
| 7 | 2026-09-20 | e2e-mom | `GET /memory?user=e2e-mom` | 3 facts, LOCAL DEMO badges, no walruscan links | 3 `<li>` rows with `LOCAL DEMO local-*` badges + local banner | ✅ PASS | LOCAL DEMO `local-0b1c191cc8f1` / `local-f82300ff296a` / `local-3436ef5e6054` |

## v2 safety + v3 real-LLM — 2026-09-21 04:27 / 04:31 IST

| # | Date | User | Query / Probe | Expected | Actual | Result | Blob id |
|---|------|------|---------------|----------|--------|--------|---------|
| 8 | 2026-09-21 | demo-day7 | Trap: `Can she take ibuprofen for her headache?` (no LLM key) | Deterministic STOP citing blob, before LLM | `STOP — do not give ibuprofen. Recalled allergy: "…" (blob local-7dca6520a17d). Confirm with your doctor…` | ✅ PASS | LOCAL DEMO `local-7dca6520a17d` |
| 9 | 2026-09-21 | demo-day7 | `GET /demo?persona=day7` | LIVE recall, day1 empty vs day7 real counts | Renders `LIVE recall` with per-namespace counts | ✅ PASS | n/a (read path) |
| 10 | 2026-09-21 | llm-mom | Real LLM: `What meds does mom take?` (OpenRouter key in-process only, model `inclusionai/ling-3.0-flash-vl:free`) | Reply cites med + allergy from recall; `recalled: 3` | Reply cites Metformin 500mg 8pm + ibuprofen rash; allergy trap on same user still STOPs | ✅ PASS | LOCAL DEMO (llm-mom namespace, same 3 facts re-taught; `recalled: 3`) |

## Self-tests + static checks (from transcript §§8 Checks)

| # | Date | Probe | Expected | Actual | Result |
|---|------|-------|----------|--------|--------|
| 11 | 2026-09-20 | `npm test` (`node src/selftest.js`) — namespace group (3: basic / sanitizes / empty→anon) | pass | 13 passed, 0 failed (v1) | ✅ PASS |
| 12 | 2026-09-20 | `npm test` — truncate group (2: ≤500 bytes / passthrough) | pass | 13 passed, 0 failed (v1) | ✅ PASS |
| 13 | 2026-09-20 | `npm test` — system-prompt group (3: empty→onboarding / empty disclaimer / recall injected + disclaimer) | pass | 13 passed, 0 failed (v1) | ✅ PASS |
| 14 | 2026-09-20 | `npm test` — threshold group (1: MAX_DISTANCE 0.7) + write-gate group (4: med / allergy / chit-chat skip / >500 skip) | pass | 13 passed, 0 failed (v1) | ✅ PASS |
| 15 | 2026-09-21 | `npm test` — findConflict group (4: blocks ibuprofen + cites blob / null on meds question / null without allergy / null on empty) | pass | 17 passed, 0 failed (at the time; now 37 — row 22) | ✅ PASS |
| 16 | 2026-09-20 | `node --check` on `app/src/memory.js`, `localClient.js`, `server.js`, `selftest.js`, `seed10.js`, `verify.js` | all OK | all OK | ✅ PASS |

## Not yet run

| # | Probe | Command (from `app/`) | Status |
|---|-------|------------------------|--------|
| 17 | Mainnet memory verify (needs `MEMWAL_ACCOUNT_ID` + `MEMWAL_PRIVATE_KEY`) | `npm run verify:memwal` | ⏳ PENDING |
| 18 | Mainnet seed 10 facts (needs keys, `MEMWAL_MODE=mainnet`) | `npm run seed:10` | ⏳ PENDING |

> **Later completed (kept for history):** row 17 was completed by row 26 (`node src/verify.js` on Mainnet); row 18 by row 34 (sequential idempotent seeder, 12/12 blobs). Both ran for real — see the MAINNET sections below.

## model-independence — 2026-09-20 ~23:20 UTC, `PORT=3002 node src/server.js`, MEMWAL_MODE unset → local, OpenRouter key in-process only (never printed/stored)

> Proves MEMORY does the work, not the model. Same `llm-mom` namespace (LOCAL DEMO, 3 facts re-taught this run), same query `What meds does mom take?` across two NEW free non-OpenAI/Anthropic models ≠ `inclusionai/ling-3.0-flash-vl:free`. Endpoint note: `api.openrouter.ai` is NXDOMAIN; used canonical `openrouter.ai/api/v1`. `:free` list = 21 models; no `deepseek*:free` exists right now. Tried and 429-skipped (upstream_provider_shared_pool): `google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free`, `qwen/qwen3.8-27b:free`, `z-ai/glm-5.2:free`.

| # | Date | User | Query / Probe | Expected | Actual | Result | Blob id |
|---|------|------|---------------|----------|--------|--------|---------|
| 19 | 2026-09-20 | llm-mom | Real LLM `liquid/lfm-2.5-2.6b:free`: `What meds does mom take?` | Reply cites Metformin 8pm + ibuprofen allergy from recall; `recalled: 3` | `recalled: 3`; reply: "Your mom takes Metformin 500mg at 8pm after food. She is also allergic to ibuprofen (rash). Dinner 7:30pm, bedtime 10pm…" | ✅ PASS | LOCAL DEMO `local-59abcf67cfe5` / `local-aac804a44355` / `local-2f0b9efcb8da` |
| 20 | 2026-09-20 | llm-mom | Real LLM `nex-agi/nex-n2.5-mini:free`: `What meds does mom take?` | Reply cites Metformin 8pm + ibuprofen allergy from recall; `recalled: 3` | `recalled: 3`; reply: "Your mom takes Metformin 500mg at 8pm after food. She is also allergic to ibuprofen (rash). Dinner 7:30pm, bedtime 10pm…" | ✅ PASS | LOCAL DEMO `local-59abcf67cfe5` / `local-aac804a44355` / `local-2f0b9efcb8da` |
| 21 | 2026-09-21 | llm-mom | Restart persistence: fresh `node src/server.js`, same namespace, `What time is dinner?` | Recall survives restart (file-backed) | `recalled: 1` → `Dinner 7:30pm, bedtime 10pm` (relevance-filtered, not dump-all) | ✅ PASS | LOCAL DEMO |
| 22 | 2026-09-21 | — | `npm test` current suite: 17 core + 19 fuzz-regression + 1 bulk-fallback | 37 passed, 0 failed | 37 passed, 0 failed | ✅ PASS | n/a (offline) |
| 23 | 2026-09-21 | demo-day7 | `npm run demo:seed` (local, no server): 3 facts → probe 3/3, exit 0; `/demo?persona=day7` shows AFTER side live | Seeded + live | Seeded `local-b0f7a7f09754/0e7f3566e905/78dbba2b1f29`, probe 3/3 | ✅ PASS | LOCAL DEMO |
| 24 | 2026-09-21 | e2e-mom/llm-mom | State restore after `.local-memory.json` wipe: reseed both namespaces, blob-id determinism check | Identical ids to transcript | All 9 ids match DEMO-TRANSCRIPT exactly | ✅ PASS | LOCAL DEMO |
| 25 | 2026-09-21 | demo-day7 | COLD-CLONE drill (/tmp, no node_modules/memory): install → .env → test → seed-demo → boot → healthz/chat/summary/demo | Zero friction, identical ids | 93 pkgs, 37/37, same 3 ids, trap STOP, summary 3, demo live | ✅ PASS | LOCAL DEMO |

## MAINNET E2E — 2026-09-21 ~12:00–12:10 UTC, real Walrus Memory (owner keys, relayer.memory.walrus.xyz), OpenRouter google/gemini-2.5-flash

| # | Date | User | Query / Probe | Expected | Actual | Result | Blob id |
|---|------|------|---------------|----------|--------|--------|---------|
| 26 | 2026-09-21 | verify-probe | `node src/verify.js` mainnet: health → rememberAndWait → recall | write+recall OK on Mainnet | health OK; blob 5A280mTx…; recall 1 (d≈0.5) | ✅ PASS | `5A280mTxCLUq3mZ7GiEPt7BSn1J4Z18ws7okx-VMkME` |
| 27 | 2026-09-21 | demo-mom | Single `rememberAndWait` + recall "What meds does mom take?" (d=0.5409) | blob stored + recalled | blob drJsuPZq…, recalled 1 | ✅ PASS | `drJsuPZqT8XKUInCiIElzjhDkV66U2J1Tw71v37FR2U` |
| 28 | 2026-09-21 | demo-mom | POST /api/chat "What meds does mom take?" (mainnet + Gemini 2.5 Flash) | reply cites meds from recall | "You told me your mom takes Metformin 500mg at 8pm after food, and Amlodipine 5mg at 8am with water." `mode:mainnet`, `savedBlob:null` | ✅ PASS | drJsuPZq… / GZJ36Lu-… |
| 29 | 2026-09-21 | demo-mom | Allergy trap: "Can she take ibuprofen for her headache?" | deterministic STOP citing MAINNET blob, before LLM | "STOP — do not give ibuprofen. Recalled allergy: … (blob _7oVBL39o-…)" `mode:mainnet` | ✅ PASS | `_7oVBL39o-pYqcQno30vZrIFHDj-ZvBJX9okIDKciMg` |
| 30 | 2026-09-21 | demo-mom | GET /memory?user=demo-mom (mainnet) | facts + walruscan links, no fake ids | 3 facts, real walruscan anchors | ✅ PASS | 3 real blob links |
| 31 | 2026-09-21 | demo-mom | GET /api/summary?user=demo-mom (mainnet, classifier v2) | meds/allergies correctly split | medications 2, allergies 1, blobCount 3 | ✅ PASS | recall-only |
| 32 | 2026-09-21 | — | `npm test` after dedup + classifier changes: 37 + recall-dedup regressions | all pass | 39 passed, 0 failed | ✅ PASS | n/a (offline) |
| 33 | 2026-09-21 | demo-mom | OpenRouter 402 (credits) on 65k default max_tokens | graceful, no crash | fixed: max_tokens 400 + free-model fallback chain (ling-3.0-flash, lfm-2.5) | ✅ FIXED | n/a |

Known issue (tracked): relayer bulk endpoint 202-but-not-indexed under rate limit → replaced with
sequential paced idempotent seeder. Transient 503/500/504s during congestion; all retried clean.

## MAINNET SEED COMPLETE + RESILIENCE — 2026-09-21 12:30–12:45 UTC

| # | Date | User | Query / Probe | Expected | Actual | Result | Blob id |
|---|------|------|---------------|----------|--------|--------|---------|
| 34 | 2026-09-21 | demo-mom | Sequential idempotent seeder v3 (paced 10.5s, retry+backoff, wedged-job escape) | 12/12 blobs | 12/12, failed=0, recall probe 13/20 | ✅ PASS | 12 walruscan links in blob-ledger.md |
| 35 | 2026-09-21 | demo-mom | Write path: teach "Mom takes Calcium 600mg at 9pm with milk" | new MAINNET blob saved | savedBlob o1fud… (13th blob), reply confirms | ✅ PASS | o1fud… (ledger) |
| 36 | 2026-09-21 | demo-mom | "Who manages weekend doses?" | recalls Priya fact; question not saved | "your daughter, Priya, manages your weekend doses", savedBlob:null | ✅ PASS | HXrwMUUo… |
| 37 | 2026-09-21 | demo-mom | Recall abort mid-index-settle ("This operation was aborted") | no 500 to client | FIXED: safeRecall retry×3 → graceful empty → LLM onboarding; 41/41 tests | ✅ FIXED | n/a |
| 38 | 2026-09-21 | demo-mom | GET /memory — receipts page, 13-fact namespace | walruscan links render | 11+ live anchors | ✅ PASS | n/a |
| 39 | 2026-09-21 | demo-mom | GET /api/summary — classifier v2 on full namespace | correct split | meds 3 / allergies 1 / routine 3 / family 5, blobCount 13 | ✅ PASS | n/a |

Relayer incidents survived: 503 AUTH_UPSTREAM_UNAVAILABLE, 500 seal-encrypt/durable-upload, 504 job
waits ×2, stuck idempotency job (escaped by dropping key), recall aborts during index settle.

| 40 | 2026-09-22 | demo-mom | Metformin blob id re-verified via live recall (ledger transcription caught + fixed) | 1 recall hit | JbCdbC3Hx85f5Ddg0H5bkxdjeTbHGrmWVgawEggKRyo matches ledger 12:33 block | ✅ PASS | ledger line corrected; honesty rule: verify links, never infer |
| 41 | 2026-09-22 | MystenLabs/MemWal | Filed #966 (wedged job poisons idempotency key) with live logs | issue live | https://github.com/MystenLabs/MemWal/issues/966 | ✅ FILED | dupe-checked vs #932/#814 |
| 42 | 2026-09-22 | MystenLabs/MemWal | Filed #967 (bulk accepts 12, lands 0 — silent loss) | issue live | https://github.com/MystenLabs/MemWal/issues/967 | ✅ FILED | dupe-checked vs #767/#940/#611 |
| 43 | 2026-09-22 | MystenLabs/MemWal | Filed #968 (recall has no relevance cutoff; filler d≥0.9) with measured distances | issue live | https://github.com/MystenLabs/MemWal/issues/968 | ✅ FILED | dupe-checked vs #373/#715 |
| 44 | 2026-09-22 | docs/images | 4 article visuals rendered 2× DPI (banner/stop-receipt/before-after/architecture) | 4 PNGs | 218–2500 KB each, sources in docs/images/src/*.html | ✅ PASS | playbook + alt text in docs/images/VISUALS.md |
