# Mediara backend — autonomous drive to production-grade

UI is the owner's territory: no agent touches `app/web/**`. Servers stay DOWN
(`:3001`/`:3114` start only on owner command); all verification uses scratch
ports + temp env paths. Agents never commit; owner reviews dirty trees.

- Web functional batch blessing (owner-ordered 2026-10-09): streaming render, Compare/Stats nav, history cache, rename affordance — owner territory (`app/web/**`), no agent touches.

## Task list (backend only)

- [ ] T1: budget-identity unification — implemented, red-green proven, REVIEW Changes-requested, findings fixed, awaiting re-review (DO NOT mark done until gates pass)
- [x] T2: SSE streaming chat — implemented, red-green proven
- [x] T3: lose-list P0s (LLM 402/max_tokens+order, census pills, TTL cache, device-keyed limiters, guard snapshot) — done, committed 03edfd2 (418/418 + eval 30/30, my gate)
- [x] GATE WAVE 2: G1 PASS + G2 Approved + G3 2 exploits fixed — CLOSED by wave-3 gates
- [x] GATE WAVE 5: G1 PASS + G2 behavior-approved + G3 findings FIXED — CLOSED
- [x] T4: `eval.js` hardcoded store-path wart (same class as the fixed selftest one) — FIXED in tree: `app/src/eval.js:63` tmp override + `:79-83` same-path cleanup; H6 pins it (hardening green; then-current total now historical)
- [x] T5: budget edge cases (window prune cap, `resetAt` clock skew, concurrent touch atomicity) — COVERED in tree: H5a/H5b/H5c both-stores + `window.test.js` 15 incl. fail-closed cap (green; then-current total now historical)
- [x] T6: log hygiene (single-line request errors, no blob text/PII, no stack leaks) — ENFORCED in tree: `loghygiene.test.js` 4 (allowlist + bounded/static + no stacks/paths/secrets + single-line; green — the then-current figure beside it is historical)

## Gate loop (ALL THREE must be green — otherwise fix + rerun, never stop)

- [ ] G1 JUDGE: acceptance vs SPEC-FULL.md + SPEC.md (every claim, every matrix cell, beta bar) — verdict PASS/FAIL with evidence
- [ ] G2 REVIEWER: code quality (YAGNI, no dead code, test hygiene, edge cases, no UI touched)
- [ ] G3 BUG-HUNTER: adversarial — break it (auth bypass, namespace confusion, budget bypass, injection via stored facts, race windows, malformed inputs); report exploits with repro or certify none found

## Submission track (from win-patterns research — deadline Oct 9, 2 days)

Gates: mainnet memory ✅ / 3×10 usage 🔴FAIL (1 persona) / live deploy ⚠️unproven / repo ✅ / article 🔴missing / X+form ⚠️partial.
- [ ] S1: seed 2 more mainnet personas × 12 facts (demo-dad, demo-aunt, distinct allergies) + `npm run stats --live` prints 3/3 — OWNER-GATED (long unattended run; laptop is down)
- [ ] S2: 60-sec judge demo script (Day-1-vs-7 + live STOP trap + guard-proof re-verify + print) rehearsed on deployed URL
- [ ] S3: article 500–800w (architecture + what broke + exact STOP moment + stats output + walruscan link) — OWNER-GATED (publish)
- [ ] S4: confirm deploy healthz=mainnet + submit form + X post (bug #967 + improvement #968) — OWNER-GATED
- [ ] S5: promo post third-party community — OWNER-GATED
- [ ] S6: throttle-math paragraph (delegate-key throughput + keyless guards under 429) for article/resilience story
- Press: coded pre-LLM STOPs, A/B 12/12 + 0/5 FP, hash-chained ledger, Sui vaults, proactive cross-checks, gradeable honesty infra
- Number freeze: ONE truth (693/693 + eval 30/30) everywhere — README, SPEC-FULL, app/README, article, form. Re-sweep before submit, never reword after.
- Judge-start-here block at README top: agent id, `user-demo-mom`, one STOP-receipt walruscan link, `/guard-proof` URL (owner/UI)
- `submission/` mirror pack: form answers, ~700w article (compress, keep blob ids), X kit + timeline, demo script, bug tickets #966-968, 5-entry judge QA (owner)
- S7 lessons: no live-edit number drift; 3 REAL users × 10 (family teaches on mainnet + CHAT-LOGS, not just seeded personas); human tail (URL, video, article, users) is the whole game — code already beats S7 winners
- Killer differentiators (ranked): 1) Red Team Arena — dare judges to break guards, live counter (8–12h, low risk, PICK FIRST) 2) Guard Autopsy — split view of blocked LLM answer vs verdict (6–10h) 3) Memory Inheritance QR handoff (10–14h) 4) Memory Health Score from census+cross-checks (8–12h) 5) Cross-bot export (6–10h). All need UI (owner) — queue post-gate
- Arena backend SHIPPED in tree: `GET /api/arena` (static 6-challenge corpus — 5 STOP traps + 1 Tylenol control, expired-public; spec'd SPEC-FULL §8 + app/README, enforced SPEC §5/routes.test.js) — Arena UI pending owner.
- Lose-list P0s (verified live by hunter): LLM 402-dead (max_tokens 300>282 affordable; paid model first) → lower to ~200 + free-first order; landing pills 0/0 self-refute (local ledger vs dashboard census) → census-sourced pills + "—" when zero; count drift (6 contradictory) → single sweep; SSE unwired in UI (owner); perf 6–17s screens → boot-warmed TTL census cache; demo 10-shared + IP buckets for judging day → deploy envs; AB-RESULTS synthetic rows vs demo persona → seed missing facts or relabel; wallet unpassable (gas/pending/CSP) → owner flow steps; README false claims + article placeholders + stats NOT MET → owner packaging; guard ledger empty on fresh deploy → commit evidence snapshot (see below)

## Rules for every implementer

Skills first: verification-before-completion, systematic-debugging,
test-driven-development. TDD red-green; extend-never-weaken; FULL `npm test`
+ `npm run eval` 30/30 + `tsc --noEmit` + `vite build` green in-session;
temp env paths only; no chain writes; no secrets printed; scratch ports only;
DO NOT COMMIT; report DONE + test evidence + concerns.
- Owner-authorized 2026-10-08 (chat): app/web demo-section split — `demo-strip` + `demo-feats` render behind `isDemo` (`app/web/src/ChatView.tsx:287,299,334-336`; personal chat renders neither; enforced `app/src/frontend.test.js:205-206`). No UI-territory breach.
- SECURITY.md authorized as the canonical disclosure/policy note (agents may read + update it; secrets never enter it — `.env` gitignored, temp paths in tests only).
- `app/web/src/vite-env.d.ts` blessed as a tsc-required scaffold (single `/// <reference types="vite/client" />` line; `tsc --noEmit -p web/tsconfig.json` fails without it) — do not delete or "clean up".
- T1 vault-display permanent-behavior blessing re-affirmed (owner-proxied earlier; pointer only, no change): vault dashboard display stays vault-grounded/fail-closed per SPEC.md §3 rule 6 footnote — the read-time union heals pre-unification rows for budget *enforcement*, never for vault *display*. Counts untouched.
- [ ] GATE WAVE 8: G2 changes + G3 CERTIFIED CLEAN + G1 pending — batch, then wave 9
- [ ] Personal-chat login gate (SPEC §4/A): POST /api/chat + /stream anon-personal → 401 `{loginRequired, action: sign-in}` pre-budget, demo open, reads untouched — IMPLEMENTED in tree (server.js handleChat gate; routes 79 + stream 12 green; guest chat cap vestigial)

- [ ] FINAL GATE: Judge PASS (693/693 + 30/30) + Reviewer Approved (Spec ✅) + Hunter CERTIFY NONE FOUND — THREE GREENS, loop stopped, tree left dirty for owner review (no commit per rule) — REOPENED: re-close only with T1 + wave-8 evidence