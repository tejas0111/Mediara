# SUBMIT TODO — Mediara → Walrus Session 8 (master list)

Deadline: ~3-4 hours. Owner = you. Agent = backend/gates only.

## DONE (agent)
- [x] Backend gates green (loop until Judge PASS + Reviewer Approved + Hunter CLEAN)
- [x] Demo/personal split at API (demo read-only shared, personal login-walled 401)
- [x] Wallet cap 30/rolling-24h, per-token SSE streaming, typo-tolerant guards
- [x] SVG logo + integrated (sidebar, favicon, landing, legacy header/avatar/print)
- [x] Landing rewritten (honest copy, live pills, STOP demo block)
- [x] UI from ui-worktree copied (streaming render, history fix, Compare/Stats nav)
- [x] Docs polished, SECURITY.md, DEPLOY-RUNBOOK.md, submission/ packet (untracked)
- [x] Remote renamed dosedaughter → mediara (local only until push)

## OWNER — in order
- [ ] 1. REVIEW the dirty tree (`git status`, `git diff --stat`), then commit:
  `git add -A && git commit -m "Mediara submit: gates green + launch UI" && git push origin master`
  (Sandbox cannot push — SSH permission. If push fails, create repo `tejas0111/mediara` on GitHub first.)
- [ ] 2. NETLIFY bind (CLI logged in on your machine):
  `cd walrus-session8 && netlify link` (pick the site) — or `netlify sites:create --name mediara`
  `netlify env:set MEMWAL_MODE mainnet` + `MEMWAL_ACCOUNT_ID` + `MEMWAL_PRIVATE_KEY` +
  `SESSION_SECRET` (from `openssl rand -hex 32`) + `OPENROUTER_API_KEY`
  Push → auto-deploy. Verify: `/healthz`, `/`, `/app`, `/api/models`, one demo chat turn.
- [ ] 3. SEED 2 more personas (S1 — usage gate needs 3 users × 10 memories; only demo-mom seeded)
- [ ] 4. WALLET retest on live URL (sign in → vault → teach → trap STOPs)
- [ ] 5. VIDEO from Remotion agent (prompt delivered in chat); upload to YouTube
- [ ] 6. ARTICLE: paste `submission/ARTICLE.md`, add 4 screenshots, publish Medium + Inkray mirror
- [ ] 7. POSTS: X post tagging @WalrusProtocol #WalrusMemory + promo post outside Web3
- [ ] 8. FORMS: DeepSurge (`submission/deepsurge.md`) + Walrus form (`submission/walrus-form.md`) — fill [OWNER] blanks
- [ ] 9. FINAL check: live URL reachable, demo STOP fires on it, guard-proof verifies
