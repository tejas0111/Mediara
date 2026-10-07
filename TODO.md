# Mediara backend — autonomous drive to production-grade

UI is the owner's territory: no agent touches `app/web/**`. Servers stay DOWN
(`:3001`/`:3114` start only on owner command); all verification uses scratch
ports + temp env paths. Agents never commit; owner reviews dirty trees.

## Task list (backend only)

- [x] T1: budget-identity unification (canonical wallet key + read-time union healing) — implemented, red-green proven, REVIEW: Changes-requested (dashboard guard-union omits trunc keys; mixed-case legacy gap; doc drift; comment/test fragility notes). FIX QUEUED behind T2 (same files) — will dispatch fix+re-review on the settled tree.
- [ ] T1: budget-identity unification — implemented + reviewed Changes-requested + findings fixed, awaiting re-review (DO NOT mark done until gates pass)
- [x] T2: SSE streaming chat — implemented, red-green proven
- [x] T3: lose-list P0s (LLM 402/max_tokens+order, census pills, TTL cache, device-keyed limiters, guard snapshot) — done, committed 03edfd2 (418/418 + eval 30/30, my gate)
- [x] GATE WAVE 2: G1 PASS + G2 Approved + G3 2 exploits fixed — CLOSED by wave-3 gates
- [ ] GATE WAVE 5: G1 + G2 + G3 re-gate (439 frozen, hygiene landed) — RUNNING (G2 done: behavior ✅, ledger staleness only)
- [ ] T4: `eval.js` hardcoded store-path wart (same class as the fixed selftest one)
- [ ] T5: budget edge cases (window prune cap, `resetAt` clock skew, concurrent touch atomicity)
- [ ] T6: log hygiene (single-line request errors, no blob text/PII, no stack leaks)

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
- Number freeze: ONE truth (439/439 + eval 30/30) everywhere — README, SPEC-FULL, app/README, article, form. Re-sweep before submit, never reword after.
- Judge-start-here block at README top: agent id, `user-demo-mom`, one STOP-receipt walruscan link, `/guard-proof` URL (owner/UI)
- `submission/` mirror pack: form answers, ~700w article (compress, keep blob ids), X kit + timeline, demo script, bug tickets #966-968, 5-entry judge QA (owner)
- S7 lessons: no live-edit number drift; 3 REAL users × 10 (family teaches on mainnet + CHAT-LOGS, not just seeded personas); human tail (URL, video, article, users) is the whole game — code already beats S7 winners
- Killer differentiators (ranked): 1) Red Team Arena — dare judges to break guards, live counter (8–12h, low risk, PICK FIRST) 2) Guard Autopsy — split view of blocked LLM answer vs verdict (6–10h) 3) Memory Inheritance QR handoff (10–14h) 4) Memory Health Score from census+cross-checks (8–12h) 5) Cross-bot export (6–10h). All need UI (owner) — queue post-gate
- Lose-list P0s (verified live by hunter): LLM 402-dead (max_tokens 300>282 affordable; paid model first) → lower to ~200 + free-first order; landing pills 0/0 self-refute (local ledger vs dashboard census) → census-sourced pills + "—" when zero; count drift (6 contradictory) → single sweep; SSE unwired in UI (owner); perf 6–17s screens → boot-warmed TTL census cache; demo 10-shared + IP buckets for judging day → deploy envs; AB-RESULTS synthetic rows vs demo persona → seed missing facts or relabel; wallet unpassable (gas/pending/CSP) → owner flow steps; README false claims + article placeholders + stats NOT MET → owner packaging; guard ledger empty on fresh deploy → commit evidence snapshot (see below)

## Rules for every implementer

Skills first: verification-before-completion, systematic-debugging,
test-driven-development. TDD red-green; extend-never-weaken; FULL `npm test`
+ `npm run eval` 30/30 + `tsc --noEmit` + `vite build` green in-session;
temp env paths only; no chain writes; no secrets printed; scratch ports only;
DO NOT COMMIT; report DONE + test evidence + concerns.
