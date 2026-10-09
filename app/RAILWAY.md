# Railway deploy (free trial) — Mediara backend + SPA

One service, zero code changes: Express serves the API **and** the committed
React bundle (`web/dist`) at `/`. Railway injects `PORT`; the server respects it.

> The CLI is already usable here via `npx @railway/cli` (v5.26.0, cached).
> `railway login` needs YOUR browser (SSO) — that one click is yours.

## 0. Log in (you)

```bash
npx @railway/cli login        # opens browser, creates account / free trial
```

## 1. Create the service from `app/`

```bash
cd /home/tejas/Tejas/walrus-session8/app
npx @railway/cli init         # name it mediara (creates project+service+env)
```

Prefer GitHub auto-deploys? Connect the repo in the dashboard instead and set
the service **Root Directory to `app`** — `railway.json` here is picked up.

## 2. Variables (dashboard → service → Variables, or `railway variables --set`)

| Var | Value / source |
|---|---|
| `NIXPACKS_NODE_VERSION` | `22` (app requires ≥20) |
| `MEMWAL_MODE` | `mainnet` (real Walrus memory; `local` = ephemeral demo) |
| `MEMWAL_ACCOUNT_ID` | your MemWal agent account id |
| `MEMWAL_PRIVATE_KEY` | your MemWal private key (**never commit**) |
| `SESSION_SECRET` | `openssl rand -hex 32` (required on mainnet — without it wallet onboarding 501s instead of storing plaintext keys) |
| `OPENROUTER_API_KEY` | LLM key (chat still guards/falls-back without it) |
| `TRUST_PROXY` | `1` (Railway terminates TLS at its edge) |

## 3. Persistence volume (else memory is wiped on every redeploy)

Service → **Volumes** → New Volume, mount path **`/data`**, then set:

| Var | Value |
|---|---|
| `DD_LOCAL_STORE` | `/data/.local-memory.json` |
| `DD_USAGE_LEDGER` | `/data/usage-ledger.json` |
| `DD_GUARD_PROOF` | `/data/guard-proof.json` |
| `DD_REGISTRY_PATH` | `/data/.wallet-registry.json` |

(All four are honored by the server; without them the repo-local JSON files
live on ephemeral disk.)

## 4. Deploy

```bash
npx @railway/cli up           # from app/
```

## 5. Verify (replace host)

```bash
curl https://<you>.up.railway.app/healthz
curl 'https://<you>.up.railway.app/api/seed-status?user=demo-mom'
```

Open `https://<you>.up.railway.app/` for the SPA. Point any local UI at it via
the in-app **Mainnet** environment toggle (Account → Mainnet server URL).

## Notes

- `railway.json` (here): nixpacks build, `node src/server.js`, `/healthz` check.
- `web/dist` is committed, so no frontend build runs on Railway.
- Trial credit ($5) covers this easily (one 512MB service, low traffic).
- Don't put real keys in git. Keep them in Variables only.
