# Mediara — Full Project Specification

Umbrella spec. `SPEC.md` (identity, scope, budgets) is normative and part of
this document by reference — where they overlap, `SPEC.md` wins on numbers.

## 1. Product

- **What**: a caregiver chatbot with durable, verifiable memory. Tell it once
  (meds, allergies, routines) — every future answer is checked against that
  memory before it speaks, and every safety stop cites its evidence.
- **Users**: family caregivers (non-technical), hackathon judges, future
  self-hosters. No accounts, no passwords — guest-first, wallet-upgraded.
- **Beta bar**: every screen works in all four auth states (anon, signed-in
  unlinked, signed-in + vault, expired); every failure names its recovery; no
  mock data, no dead buttons, no dev wording anywhere user-visible.

## 2. Surfaces

| Surface | Serves | Notes |
|---|---|---|
| `GET /` | `landingPage()` (`app/src/page.js`) — zero JS, CSP-clean | Hero, 3-step, live evidence strip, Launch → `/app` |
| `/app` (+ `/app/*`) | Vite SPA (`app/web/dist`, base `/app/`) | Hash routing `#/chat #/demo #/dashboard #/memory #/replay #/proof #/print #/wallet` (+ `#/compare`, `#/stats` compat) |
| Legacy HTML (`/memory /demo /print /replay /compare /guard-proof`) | Same `page.js` shells, charcoal shim | Shareable views; routes + content frozen by tests; nav points into `/app` |
| JSON API (`/api/*`) | Express (`app/src/server.js`) | §8 |

## 3. Identity, scope, budgets → `SPEC.md` (normative)

Planes (demo shared / personal anon / vault), four auth states, §3 rules
(demo-always-shared, demo-never-writes, vault-default for owners, explicit
demo bypass, no vault naming by anon, budget identities, per-reply budget
object, fail-closed independence), §4 surface matrix, §5 test enforcement.
Canonical budget key: a wallet vault owner's turns, memories, and guard
receipts are keyed by the lowercase session address on both the chat and
dashboard paths (pre-unification rows under the truncated id / vault-hash
heal at read time — unioned, never dropped, never reset); demo ids share one
key; guests spend per-browser guest key with memories attributed per
namespace.

## 4. Memory pipeline (`app/src/memory.js`, local: `app/src/localClient.js`)

- Recall: 3 query angles (message + allergy sweep + medication sweep),
  distance filter `<0.7`, allergy/med facts force-kept past the cap.
  Whole-namespace reads (`recallAllMeta`, 7 angles) for recaps/exports/views.
- Write gate `shouldRemember()`: allergies, meds with time/context, routines,
  contacts/care facts, explicit save commands, health conditions
  (typo-tolerant). NEVER questions, chit-chat, injections, >500 chars.
- Dedup near-identical facts; truncate without amputating safety signals;
  guard-fired turns are NEVER stored.
- Degraded: breaker + `authFailure` tag on 401-class (dead credential →
  actionable 409, never "retry shortly"). Stale reads labelled, never silent.
- Census `namespaceCensus(client, ns)`: scoped, `memory_count` field.

## 5. Safety system (never weakened, ever)

- Coded guards run BEFORE any LLM output: allergy conflict → STOP,
  curated interaction table → STOP/CAUTION. Deterministic, keyless-capable.
- Every fired guard → hash-chained `GuardProof` ledger (`/guard-proof` +
  `/api/guard-proof`, verifiable).
- Fail-closed: unreachable memory + medication question → 503 shared / 409
  vault; recaps honest, never "no memories".
- Proof: `npm run eval` 30/30 (guards + recall + A/B), red-team clean.

## 6. Agent loop (`app/src/server.js` `/api/chat`: think → act → answer)

1. Recall (wide for guards, top-5 shown) → 2. Research (bounded web
   background ONLY for definitional questions on empty memory —
   `shouldResearch` gate; safety/personal/guard shapes never touch the web;
   cited + fenced) → 3. Guards → 4. Answer (LLM with memory in context;
   deterministic templates for STOP/CAUTION; memory-grounded fallback when
   no LLM) → 5. Write (gated, deduped, receipted; lies corrected inline;
   demo teaches redirected to personal Chat).
- Visible trace `thinking[]` per reply (Recall/Research/Guards/Answer/Write),
  merged with cited Sources in one reasoning block; auto-open on guard fire;
  staggered reveal, reduced-motion safe.
- LLM: OpenRouter free-only registry (`GET /api/models`), live list +
  fallback chain, 25s chain budget. No keys → memory-grounded answers, demo
  never dies.

## 7. Wallet & onboarding (`app/src/onboarding.js`, `onchain.js`, `WalletView`)

- Sui wallet signs; server verifies (`@mysten/sui/verify`) — no ethereum path.
- Fresh: create account (tx1) → link delegate (tx2), verify-then-persist each.
- Recovery, in order: Relink (dead-key probe → fresh delegate → link step) →
  fresh vault (`/api/wallet/reset` self-row only → create → link).
- Chain IDs track the relayer `/config` (current: package
  `0xe7c1…f5`, registry `0x8bf8…9f`; retired `0xcee7…` kept for event lookup;
  env-overridable). Retired-typed accounts get actionable 409, never 500.
- Every state has a next action; no green "vault ready" on a dead delegate.

## 8. API contract (key routes; full list in `app/README.md`)

- `POST /api/chat {userId,message,model?,memory?}` → `{reply, recalledMeta,
  thinking, savedBlob, memoryPersisted, budget, mode, disclaimer}`.
  Errors: 400 validation/model, 401 expired, 403 reserved/vault-peek, 409
  vault-unlinked/dead-delegate/retired (+ `needsRelink`/`retiredDeployment`
  flags), 429 budget (+ `resetAt/resetInHrs/loginRequired/demoUser`), 503
  shared outage (retryable).
- Reads (`/api/summary|/export|/dashboard|/usage|/proactive|/nudge|
  /api/guard-proof|/api/seed-status`): `namespaceView` auth everywhere;
  `/api/usage` redacts blob texts to non-owners (counts public).
- Machine-readable evidence preserved for article/submission.

## 9. UI/UX standard (`app/web/src`, tokens in `tokens.css`)

- Dark charcoal default everywhere; light primary buttons; grey-gradient
  brand moments; hairline borders; one radius/shadow language; tabular
  numerals. Print stays paper with URLs preserved.
- Claude-grade reasoning: verdict-first on guard fire, thinking-before-text
  otherwise, staggered step reveal, cited sources inline, honest pending
  states (never fake progress), reduced-motion + focus-trap + 360px rules.
- Copy rules: no "demo"/"free"/"mock"/TODO/slang/jargon; conditional honesty
  (Walrus receipt vs local id; vault claims gated on live state); one short
  guiding question for empty memory (allergies first).
- No URL prompts, no hardcoded backends, no `window.prompt`, no native
  unstyled controls in primary flows.

## 10. Testing gates (all must be green, always)

`npm test` = selftest + wallet + routes + stream + stats + db + window + budget-keys + frontend
(currently 408); `npm run eval` = 30/30; `tsc --noEmit`; `vite build`;
boot smoke `:3001` + `:3114`-class scratch. Rules: TDD red-green for new
behavior; extend-never-weaken; temp env paths in tests; no chain writes;
no secrets in git/logs.

## 11. Ops

- Env: `OPENROUTER_API_KEY` (opencode-auth sourced), `MEMWAL_*` (mainnet),
  `SESSION_SECRET` (generated) — all in gitignored `app/.env`, overridable
  per above. SQLite (`node:sqlite`, zero deps) primary store; JSON ledgers
  only under test envs.
- Ports: `:3001` local demo, `:3114` mainnet live. Agents use scratch ports,
  never kill live servers. Railway-ready (`app/railway.json`, `RAILWAY.md`).
- Push + browser-SSO deploy + wallet signing = owner-only (sandbox cannot).

## 12. Beta-done acceptance

1. SPEC §4 matrix: every cell exercised over HTTP, green.
2. A stranger can: land → demo chat → teach in personal → get STOP on the
   trap → print the emergency card → sign in → own a vault, with zero dead
   ends and zero lies (spot-check each claim against §8).
3. Gates in §10 green on a fresh checkout.
4. No P0/P1 from the audit list; P2s triaged, not silent.

## 13. Work order (binding for agents)

scope-matrix (running) → integrate+gate+commit → UI perfection → backend
hardening → final gate+commit. One track at a time on shared files; skills
required: verification-before-completion, systematic-debugging,
test-driven-development always; shadcn + ui-animation for UI work. Agents
never commit; owner reviews dirty trees.
