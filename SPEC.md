# Mediara — Identity, Scope & Budget Specification

Single source of truth for WHO is chatting, WHOSE memory they touch, WHAT it
costs, and what every surface must do in every auth state. Any behavior that
contradicts this file is a bug. Tests must enforce the matrix in §5.

## 1. Goal

A caregiver chatbot with durable memory. Three memory planes that NEVER mix:

| Plane | Namespace | Backend | Who |
|---|---|---|---|
| Shared demo | `user-demo-mom` (also `demo-day7`, `demo-day1`) | Agent MemWal account (mainnet) / local stand-in | Everyone reads; NOBODY writes |
| Personal anon | `user-<id>` for any non-reserved id | Same shared backend | Anonymous caller reads; writes require sign-in (chat 401s, §4/A) |
| Vault | `user-vault-<sha256(address)>` (never guessable) | The USER's own MemWalAccount via delegate key | Signed-in + onboarded wallet only |

## 2. Identities (server: `app/src/server.js` `/api/chat`, `namespaceView`)

- **Anonymous**: no session cookie. `safeUser` = normalised `userId`.
  Reserved ids (`user-w-*`, `user-vault-*`, `user-tg-*`) → 400/403, never served.
  Personal chat (POST `/api/chat`, POST `/api/chat/stream`) REQUIRES a
  signed-in session at the API layer: a caller id resolving to a PERSONAL
  namespace (anything not demo, not vault-owned-by-session) with NO valid
  session → 401 `{ loginRequired: true, action: 'sign-in' }`, before
  recall/LLM/storage/budget (no side effects: no budget touch, no rows, no
  guard receipts). Demo ids stay OPEN signed-out (read-only + demo cap,
  unchanged); reads stay as-is (world-readable anon plane except vaults).
- **Guest key**: anonymous budget identity = `guest:<sha12(ip|deviceId)>`
  (`X-Device-Id`, per browser). Usage rows stay readable; never secret.
  The guest key still meters the READS (dashboard/demo surfaces compute it
  for anonymous callers) but no longer gates a chat turn — personal chat 401s
  before the budget check, so the guest chat cap is vestigial (machinery kept,
  unenforced on chat; demo + wallet caps enforce as before).
- **Wallet session**: `dd_session` cookie → address. Onboarded (account +
  delegate on file) → `walletClient` (delegate). Signed-in but NOT onboarded
  → any vault-scoped action 409 `{needsRelink|retiredDeployment...}`, never
  silent fallback to shared (that would leak private facts publicly).
- **Expired session** (cookie present, unparseable) → 401 on every
  identity/namespaced surface, never anonymous downgrade — checked before
  body validation on chat, stream, and all reads, so an expired caller with a
  bad body still gets 401. Documented public surfaces stay public even with a
  stale cookie (static, no identity to downgrade): `GET /demo`, `/guard-proof`
  + `/api/guard-proof` (public ledger), `/api/models`, `/api/arena`.
- **Array-shaped ids**: POST `/api/chat` (+`/stream`) JSON arrays are 400
  (`userId must be a string`); query-string `?user` arrays read the first
  element (a non-string first element is 400).
- **Normalisation fixpoint**: every caller-typed id resolves nested leading
  `user-` (any case, any depth) by strip-then-trim repeated to a fixpoint —
  whitespace (space/tab/newline/NUL/NBSP) interleaved between prefixes — while
  invisible/format chars (U+200B/C/D, U+2060, U+180E, U+00AD, U+0087, U+034F,
  U+FEFF, U+200E/F, U+2061-64, U+2800, …) collapse in the canonicaliser
  (`namespaceFor` output via `scopeBareOf`, which deletes them), so
  `user-␣user-demo-mom` and `user-<ZWSP>user-demo-mom` are both `demo-mom`,
  never a writable shadow — to the canonical id BEFORE ANY scope decision
  (demo/reserved/budget/namespace) on every surface — reads and writes share
  the one canonicaliser (the collapsed `namespaceFor` output), so no depth,
  case, whitespace, or invisible-char variant can fork a
  shadow namespace.
  Every scope decision derives from the canonical namespace the data will
  actually land in (`namespaceFor` output), never from the raw caller string.
  (`0X{64}` with an uppercase prefix is accepted as non-credential-shaped:
  Sui addresses use lowercase `0x`, and the credential guard matches
  lowercase-`0x` only. Uppercase hex with a lowercase prefix (`0xAB…`)
  stays credential-shaped and is refused fail-closed — intended.)
- **Leading-dash shield rule**: guards ALSO test the leading-`[-_]+`-stripped
  form of the canonical scope id — `user--w-abc` collapses to `-w-abc`
  (which no anchored `w-|vault-|tg-` pattern matches) but stays reserved
  (400/403), and `-demo-mom` stays the shared demo (read-only + demo cap).
  Guards only: namespace derivation keeps the id as-is so no rows orphan; a
  stripped match routes to the canonical scope.
- **Dual-basis credential test**: the credential-shaped rule (`0x{64}`,
  lowercase-`0x` only) runs on BOTH the normalised basis AND the fully
  namespace-cleaned basis (what `namespaceFor` deletes, minus lowercasing and
  truncation) — either matching refuses — so invisible/format-char variants
  of an address never slip past on any surface.

## 3. Scope rules (normative)

1. **Demo turns ALWAYS use the shared channel.** `userId ∈ {demo-mom,
   demo-day7, demo-day1}` → shared agent client + `user-demo-*` namespace,
   `shared-anon` identity, even with a valid wallet session. Rationale: Demo
   chat promises premade memory; the vault would answer from an empty store.
2. **Demo NEVER writes.** `demoReadonly = DEMO_PUBLIC.has(safeUser)` for
   everyone. Teach attempts get an explicit redirect reply, never silence.
3. **Personal Chat defaults to the vault for wallet owners.** A signed-in +
   onboarded user with an untouched default id must chat as their vault
   (wallet budget, vault namespace) — NOT demo-mom with demo budget and a
   "sign in" nag while signed in. Client sends the session address as userId
   in that case; server resolves the vault from the session.
4. **Explicit public-demo reads bypass the vault** (`namespaceView`): signed-in
   users asking `?user=demo-mom` get the shared demo (banner, signed-in demo
   views). Vault data is NEVER served for a demo request and vice versa.
5. **Anonymous callers can never name a vault namespace** (403), signed-in
   non-owners can never read another vault (session binds exactly one).
6. **Budget identity**: wallet → the lowercase session address (30 / rolling
   24h — owner cost cap: every turn costs MemWal + LLM money; demo stays 10),
   ONE canonical
   key on the chat AND dashboard paths (turns, memories, and — on non-vault
   views — guard receipts; pre-unification rows under the truncated id /
   vault-hash heal at read time — unioned, never dropped, never reset; vault
   display counts only vault-namespaced receipts, never healed caller-keyed
   rows — see footnote); demo namespaces →
   shared demo id (10 / rolling 24h); everyone else → own guest key
   (20 / rolling 24h on READS — the guest chat cap is vestigial since personal
   chat 401s pre-budget; memories stay namespace-keyed evidence).
   429 bodies carry `remaining:0 + resetsAt` (date, compat) + `resetAt` (ISO)/`resetInHrs`
   (+ `loginRequired`, `demoUser` for anon/demo).
7. **Every reply carries `budget{used,cap,remaining,resetAt}`** (best-effort,
   never fails chat). UI whispers at ≤3 remaining, never nags the signed-in
   about signing in.
8. **Fail-closed safety is scope-independent**: guards run on recalled facts
   before any LLM output on EVERY medication-shaped turn; unreachable memory
   → 503 (anon/shared) or actionable 409 (dead vault credential); recaps
   answer honestly, never "no memories". Guard-ledger verification accepts
   both current sliced-body receipts and pre-change unsliced-body receipts
   (migration fallback) — any other mismatch is tamper. Recall and identity
   always derive from the canonical scope id, so scope and data can never
   disagree.
9. **Informational mentions of a recorded allergen hard-STOP by design.**
   Only allergy-status/recap questions (`Is she allergic to …?`) are exempt —
   a definitional mention (`What is ibuprofen?` with an ibuprofen allergy on
   file) STOPs, fail-closed over helpfulness (judge P2 triaged, not silent;
   pinned by H29).

Footnote to rule 6 (vault-display fail-closed exception — permanent intended behavior): the read-time union
heals pre-unification rows for budget *enforcement*, but vault *display* is
vault-grounded and fail-closed — legacy pre-namespaced rows are excluded from
the vault dashboard because caller-keyed rows are attacker-writable (any
caller can plant rows under another key, which the dashboard would otherwise
present as vault evidence), while enforcement still unions
them. Vault recall displays at most 25 facts (the `namespaceView` recall
ceiling); when the recall hits that ceiling the dashboard reports
`personal.memoriesCapped:true` (false otherwise), so no surface silently
understates the `/api/usage` true count. Vault guard counts come from the
bounded `vaultGuardCount` scan (cap 5000); a failed or full-page scan reports
`personal.guardStale:true` instead of a silent 0. Non-vault views keep the
userId union over the same bounded scan (cap 5000) with the same stale bit —
no guard count on any surface is ever a silent 0. The rolling-window write
path keeps at most 10,000 turn rows per key (`WINDOW_KEEP_MAX`, both stores)
when the cap is unknown at write time, so per-key growth stays bounded while
no live turn a real cap could count is ever dropped early. The `{mode:'daily'}`
window machinery in both stores is frozen legacy (kept, never extended — the
stores still unit-pin it; every chat/dashboard path enforces rolling 24h). The credential-shaped rule
(`0x{64}`, lowercase-`0x` only) covers anonymous callers (400 with a sign-in
action) and signed-in non-self readers (400) alike on EVERY id-naming surface
— the 8 `namespaceView` reads including the dashboard, `/compare` (per id),
and `/api/nudge` (per target) — all routed through the ONE shared guard (no
looser reimplementations); a signed-in-but-vaultless reader naming their OWN
address fails closed with 409 vault-not-linked on every read surface including
the dashboard (never a guest-served shadow); only the session's own address
WITH a vault follows the vault path. POST `/api/chat` and `/api/chat/stream`
share one IP-keyed secondary limiter (`DD_CHAT_IP_LIMIT`, default 300/min)
behind the device-keyed fairness limiter: a judging-day NAT room (~20
browsers × ~3 turns/min ≈ 60/min sustained, 5× burst headroom) never trips
it, while device-rotation storms are capped per IP. Every `namespaceView` read
surface (plus `/compare` per id and `/api/nudge` per target) shares one
IP-keyed secondary limiter (`DD_READ_IP_LIMIT`, default 600/min) behind the
device-keyed fairness limiter: a judging-day NAT room (~20 browsers × ~6
reads/min ≈ 120/min sustained, 5× burst headroom) never trips it, while
device-rotation storms — each read fanning out to 7 recall angles plus guard
scans — are capped per IP. Explicit junk-only ids (no letters or digits after the `user-` fixpoint strip, e.g.
`!!!`, `user-!!!`) are 400 on chat/stream and every read surface — deliberately
fail-closed and stricter than `namespaceFor`: `user-!!!` would derive the
distinct namespace `user-user-` (never the shared `user-anon`) but is still
refused rather than served under a meaningless namespace. `-`/`_` are namespace-significant (kept by `namespaceFor`), so dash/underscore-only ids (e.g. `---`) keep their own fail-closed namespace and per-key budget and are not junk. A missing id still defaults to anon;
`''`/whitespace still 400.

## 4. Surface matrix (must hold in all four states)

States: A=anon guest · B=signed-in, no vault · C=signed-in + vault ·
D=expired session.

| Surface | A | B | C | D |
|---|---|---|---|---|
| Personal Chat | 401 + sign-in action (`loginRequired`, `action: sign-in`; no storage, no budget touch — signed-in session required) | 409 vault-not-linked + re-link action (never shared) | vault ns + wallet budget (30/rolling 24h); default id = vault | 401 + sign-in again |
| Demo chat | shared demo, demo budget | shared demo, demo budget | shared demo, demo budget | 401 + sign-in again |
| Dashboard | guest numbers + demo readiness | demo readiness + vault: signed-in/not-onboarded (own credential-shaped id → 409) | vault numbers + wallet budget (30/rolling 24h) | 401 path, no leak |
| Memory/Replay/Print | requested ns (403 if vault) | requested ns (own credential-shaped id → 409) | vault when no explicit user; explicit demo-* honored | 401, no leak |
| Guard proof | public ledger | public ledger | public ledger | public ledger |
| Banner | live demo `used/cap` or honest fallback | same | same (demo numbers, NEVER wallet cap) | same |
| Account dialog | guest state | session + onboarding state | vault state + fresh-start/relink when broken | sign-in prompt |

No surface may show "sign in" to C, "vault ready" to B, wallet caps in the
demo banner, or demo numbers as personal numbers.

## 5. Test enforcement (`npm test` runs all fourteen)

- `selftest.js` (317): classifier/gate units (save-intent, conditions, research,
  authFailure, census scope, chain-id pins).
- `wallet.test.js` (71): auth/crypto/rate-limit + build-error classifier.
- `routes.test.js` (79): anon personal chat/stream 401 login gate (no storage, no
  budget touch) + demo-always-shared (anon AND signed-in session), demo
  read-only + redirect, session personal chat reaches the vault, vault-409 (never shared fallback), reserved-403,
  expired-401, budget caps + 429 shape, dashboard demo-vs-vault budgets,
  arena challenge bank (6-entry shape, every trap honestly STOPs, safe
  control answers, expired-public like `/api/models`).
- `stream.test.js` (27): SSE streaming (per-token live chunks in order,
  STOP/CAUTION instant-JSON with zero tokens, single-token whole-reply
  fallback + non-streaming provider body, charge-then-stream: charged before
  the first token and reported on `done`, budget-once,
  400/401/expired-401/429 error-event parity with chat,
  charge-on-abort (≥1 token stays charged) + pre-first-token-abort-uncharged +
  abort-transcript-clean + ledger-failure-zero-tokens, demo read-only, parser
  units, anon personal 401 error-event parity,
  no-rewrite-after-stream token-concat==done.reply, single-thinking on
  whole-at-once paths, abort aborts the upstream read, guarded error-end,
  recap-abort parity).
- `stats.test.js` (12): usage/proof (anon-redacted).
- `db.test.js` (8): SQLite store parity.
- `window.test.js` (15): rolling-window math both stores + route contract
  (incl. fail-closed non-numeric cap).
- `budget-keys.test.js` (14): canonical budget-key union (legacy + mixed-case
  healing, chat/dashboard agreement, both stores).
- `gatewave5.test.js` (25): wave-5 hunter repros (anon credential-shaped 400s,
  vault-grounded evidence, B-state reads serve requested ns, expired-401 on
  usage/nudge/compare).
- `gatewave8.test.js` (13): final-gate leftovers (shared credential guard on
  compare/nudge, IP rotation backstop + stream parity, vault capped/stale
  honesty flags).
- `hardening.test.js` (72): read IP backstop, junk-id 400s (chat/stream/reads),
  union guard-count honesty, budget edges (prune boundary, clock skew,
  concurrent atomicity), eval store-path cleanup, 0X chat carve-out,
  whitespace-interleaved prefix fixpoint, wave-12 invisible-char scope fork
  (demo + reserved, chat/stream/reads/caps), control-only junk-funnel,
  credential-guard parity, wave-13 leading-dash shield (reserved refusals +
  demo read-only, chat/stream/reads/caps), dual-basis credential test
  (invisible-char evasion, B-state self variants), verify-migration fallback
  (legacy unsliced rows, both stores), boolean/keyset/scap micro-items
  (single scan cap), README parity, memory-off guard enforcement (H8), object-id 400s (H9), teaching-shaped orders (H10), NFKC homoglyph fork (H11), usage id uniformity (H12), undefined-body guard (H13), dispensing-verb/modal orders (H14), allergy-question yielding to orders (H15), 48-prefix summary isolation (H16), spaced can-not teaching (H17), user-x9/invisible demo nesting (H18), single-letter/transposed/short-brand/multi-ingredient/distance-2 drug typos (H19-H24), typo-class words + fragment/common-word quiet (H25/H26), Cyrillic/Greek homoglyph scope fold (H27), shattered class names (H28), recorded-allergen definitional hard-STOP pin (H29), extended fold parity (H30), long-id invisible fork (H31), cross-clause guard-blind widening (H32), wallet 30-cap/rolling + 429-shape pins (H33-H35), union scan bound (H36), credential-400 sign-in action (H37), NEL uniformity (H38), session strictness + quoted-cookie honesty (H39), novel ingestion-verb orders (H40), novel ingestion-verb batch-2 orders (H42), infix clause-splitter rejoin (H41) + injection write-gate (A) + research-verify refusal (B) + burst pre-charge (C) + hyphen compounds (D) + abort-signal recall (E) + abort receipt (F) + obfuscated-injection write-gate (A2) + demo-seed integrity (G) + disclosure-verb write-gate (A3) + disclosure-synonym write-gate (A4).
- `loghygiene.test.js` (4): static log-call allowlist over `app/src` (bounded
  single-line logs, no fact/blob/user/credential text, no stacks/paths/secrets).
- `t3.test.js` (10): lose-list P0s (token bound, free-first order, census
  pills, TTL cache, device-keyed limiters).
- `frontend.test.js` (28): no tunnel/URL prompt, no Coming-soon, no slang, no
  hardcoded caps, live-budget banner, reasoning block, re-link/fresh-start.
- `eval` 30/30: guards + recall + A/B before/after.

## 6. Non-goals (explicitly out)

- New runtime deps. Inline scripts (CSP `script-src 'self'`). `window.ethereum`.
- Commits by agents: implement + verify, LEAVE THE TREE UNCOMMITTED for owner
  review (`git status` dirty is the expected end state).
- Secrets in git/logs/tests (`.env` gitignored; temp paths in tests only).
- Chain writes from tests/sandbox (build-only; wallet signing is owner-only).
