# Deploy (Vercel) — 5 minutes

1. From the repo root: `cd app && vercel --prod` (or import the repo in the Vercel dashboard with Root Directory = `app`).
2. Env vars in Vercel dashboard (ALL, no defaults for secrets):
   - `VERCEL=1` (disables the direct listener; requests route via `api/index.js`)
   - `MEMWAL_MODE=mainnet`, `MEMWAL_ACCOUNT_ID`, `MEMWAL_PRIVATE_KEY` (fresh Sessions wallet)
   - `OPENROUTER_API_KEY`, `LLM_MODEL=google/gemini-2.5-flash`
   - `SESSION_SECRET` (any long random string — signs wallet sign-in cookies)
   - Optional: `SPONSOR_PRIVATE_KEY` (gas wallet for user onboarding fallback),
     `SUI_GRAPHQL_URL` (defaults to `https://graphql.mainnet.sui.io/graphql`)

Wallet users (the full-stack path): each visitor connects a Sui wallet, signs a
personal message (free), then creates their OWN MemWalAccount onchain (two
signed transactions they pay for) and registers Mediara's delegate key.
After that, chat memory lands in THEIR account — the app wallet is never used
for user data. `MEMWAL_ACCOUNT_ID`/`MEMWAL_PRIVATE_KEY` remain for the shared
demo channel and the Telegram bot only.
3. Open `https://<you>.vercel.app/healthz` → `{"ok":true,"mode":"mainnet"}`.
4. Seed: from your machine with the same `.env`, `node src/seed10.js demo-mom` (writes 12 Mainnet blobs; serverless has no disk — see below).
5. Verify: `/demo?persona=day1` vs `day7`, `/memory?user=demo-mom`, `/api/summary?user=demo-mom`.

CRITICAL: serverless has ephemeral disk — `MEMWAL_MODE=local` on Vercel loses memory between requests. PROD MUST BE `mainnet`. Local mode is dev/offline-demo only (honest statement for the article: the graded path is Mainnet).
