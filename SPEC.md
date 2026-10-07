# Mediara — Identity, Scope & Budget Specification

Single source of truth for WHO is chatting, WHOSE memory they touch, WHAT it
costs, and what every surface must do in every auth state. Any behavior that
contradicts this file is a bug. Tests must enforce the matrix in §5.

## 1. Goal

A caregiver chatbot with durable memory. Three memory planes that NEVER mix:

| Plane | Namespace | Backend | Who |
|---|---|---|---|
| Shared demo | `user-demo-mom` (also `demo-day7`, `demo-day1`) | Agent MemWal account (mainnet) / local stand-in | Everyone reads; NOBODY writes |
| Personal anon | `user-<id>` for any non-reserved id | Same shared backend | Anonymous caller reads + writes |
| Vault | `user-vault-<sha256(address)>` (never guessable) | The USER's own MemWalAccount via delegate key | Signed-in + onboarded wallet only |

## 2. Identities (server: `app/src/server.js` `/api/chat`, `namespaceView`)

- **Anonymous**: no session cookie. `safeUser` = normalised `userId`.
  Reserved ids (`user-w-*`, `user-vault-*`, `user-tg-*`) → 400/403, never served.
- **Guest key**: anonymous budget identity = `guest:<sha12(ip|deviceId)>`
  (`X-Device-Id`, per browser). Usage rows stay readable; never secret.
- **Wallet session**: `dd_session` cookie → address. Onboarded (account +
  delegate on file) → `walletClient` (delegate). Signed-in but NOT onboarded
  → any vault-scoped action 409 `{needsRelink|retiredDeployment...}`, never
  silent fallback to shared (that would leak private facts publicly).
- **Expired session** (cookie present, unparseable) → 401 everywhere, never
  anonymous downgrade.

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
6. **Budget identity**: wallet → the lowercase session address, ONE canonical
   key on the chat AND dashboard paths (turns, memories, guard receipts;
   pre-unification rows under the truncated id / vault-hash heal at read
   time — unioned, never dropped, never reset); demo namespaces →
   shared demo id (10 / rolling 24h); everyone else → own guest key
   (20 / rolling 24h; memories stay namespace-keyed evidence). 429 bodies carry `remaining:0 + resetAt/resetInHrs`
   (+ `loginRequired`, `demoUser` for anon/demo).
7. **Every reply carries `budget{used,cap,remaining,resetAt}`** (best-effort,
   never fails chat). UI whispers at ≤3 remaining, never nags the signed-in
   about signing in.
8. **Fail-closed safety is scope-independent**: guards run on recalled facts
   before any LLM output on EVERY medication-shaped turn; unreachable memory
   → 503 (anon/shared) or actionable 409 (dead vault credential); recaps
   answer honestly, never "no memories".

## 4. Surface matrix (must hold in all four states)

States: A=anon guest · B=signed-in, no vault · C=signed-in + vault ·
D=expired session.

| Surface | A | B | C | D |
|---|---|---|---|---|
| Personal Chat | shared ns as typed id, guest budget | 409 vault-not-linked + re-link action (never shared) | vault ns + wallet budget; default id = vault | 401 + sign-in again |
| Demo chat | shared demo, demo budget | shared demo, demo budget | shared demo, demo budget | 401 + sign-in again |
| Dashboard | guest numbers + demo readiness | demo readiness + vault: signed-in/not-onboarded | vault numbers + wallet budget | 401 path, no leak |
| Memory/Replay/Print | requested ns (403 if vault) | requested ns | vault when no explicit user; explicit demo-* honored | 401, no leak |
| Guard proof | public ledger | public ledger | public ledger | public ledger |
| Banner | live demo `used/cap` or honest fallback | same | same (demo numbers, NEVER wallet cap) | same |
| Account dialog | guest state | session + onboarding state | vault state + fresh-start/relink when broken | sign-in prompt |

No surface may show "sign in" to C, "vault ready" to B, wallet caps in the
demo banner, or demo numbers as personal numbers.

## 5. Test enforcement (`npm test` runs all nine)

- `selftest.js`: classifier/gate units (save-intent, conditions, research,
  authFailure, census scope, chain-id pins).
- `wallet.test.js` (71): auth/crypto/rate-limit + build-error classifier.
- `routes.test.js`: demo-always-shared (anon AND signed-in session), demo
  read-only + redirect, vault-409 (never shared fallback), reserved-403,
  expired-401, budget caps + 429 shape, dashboard demo-vs-vault budgets.
- `stream.test.js` (6): SSE streaming (guard instant-JSON, keyless
  chunk-stream, budget-once, 429 error event, demo read-only, parser units).
- `stats.test.js` (12): usage/proof (anon-redacted).
- `db.test.js` (7): SQLite store parity.
- `window.test.js` (11): rolling-window math both stores + route contract.
- `budget-keys.test.js` (9): canonical budget-key union (legacy + mixed-case
  healing, chat/dashboard agreement, both stores).
- `frontend.test.js`: no tunnel/URL prompt, no Coming-soon, no slang, no
  hardcoded caps, live-budget banner, reasoning block, re-link/fresh-start.
- `eval` 30/30: guards + recall + A/B before/after.

## 6. Non-goals (explicitly out)

- New runtime deps. Inline scripts (CSP `script-src 'self'`). `window.ethereum`.
- Commits by agents: implement + verify, LEAVE THE TREE UNCOMMITTED for owner
  review (`git status` dirty is the expected end state).
- Secrets in git/logs/tests (`.env` gitignored; temp paths in tests only).
- Chain writes from tests/sandbox (build-only; wallet signing is owner-only).
