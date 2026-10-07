# DoseDaughter 🐘

**A caregiver chatbot that never re-asks a dose.** It remembers your mother's medications, allergies, and routines across conversations — permanently, on Walrus — and flags unsafe answers before the model replies.

> **A chatbot that forgets is annoying. A chatbot that remembers the wrong dose is dangerous.** DoseDaughter is the one that proves it tells the difference — a measured before/after (`npm run eval`): memory **changes the outcome on 12/12** adverse probes, with **0 false positives** ([evidence/AB-RESULTS.md](evidence/AB-RESULTS.md)).

Built for **Walrus Session 8: Chatbots That Remember** (Sept 18 – Oct 9, 2026).

![DoseDaughter](docs/images/banner-dosedaughter.png)

## The problem

Family caregivers manage a parent's medications from memory and scattered notes. Every new chatbot session starts from zero: *"What medications is she on? Any allergies?"* — asked again and again. For a person juggling Metformin schedules and a parent who can't remember what they told the doctor last week, that amnesia isn't an inconvenience; it's a safety hazard.

## The fix: memory that does the work

DoseDaughter stores every fact the family teaches it as an **encrypted blob on Walrus Mainnet** via [Walrus Memory](https://www.walrus.xyz) — then recalls it at the right moment:

- **Teach once, remember forever.** *"Mom takes Metformin 500mg at 8pm after food"* → stored as a Walrus blob, recalled in every future session.
- **Allergy STOP guard.** Ask *"Can she take ibuprofen for her headache?"* and a coded, rule-based guard runs **before the LLM** — blocking by drug class (Advil, Aleve and Excedrin all match an ibuprofen allergy), ignoring negated facts, and citing the exact blob that recorded it. It works with no LLM key, so safety doesn't hinge on the model behaving — though it does depend on recall returning the allergy fact (a dedicated allergy recall keeps it in context).
- **Drug–drug interaction guard.** The same coded guard blocks curated interactions — warfarin + ibuprofen, nitrate + sildenafil, statin + clarithromycin, SSRI + NSAID — matched by drug class, with no LLM key.
- **Doctor-visit summary from recall only.** `GET /api/summary` (and the printable `/print` card) compiles medications, allergies, routine, and care contacts — no hallucination, every line traceable to a blob.
- **Day 1 → Day 90 replay.** `/replay` animates a caregiver's memory accumulating — and the day the guard stops a dangerous dose.
- **Public receipts.** A `/memory` page shows every stored fact with a live [walruscan.com](https://walruscan.com) link. Nothing to hide, everything to verify.
- **Guard proof, not guard claims.** Every STOP/CAUTION is appended to `/guard-proof` — an append-only, **hash-chained** ledger with the exact recalled fact and blob id that fired it; the published chain re-verifies itself on every view, so an edit after the fact is detectable. Judges don't have to trust the demo — the receipt is public.
- **The memory reaches out.** A proactive tick (6-hourly in dev, on-demand via `/api/proactive` and `/api/nudge`) sends a **morning med brief** from recall and runs the **interaction cross-check over the whole namespace nightly** — the same curated table as chat, so a warfarin taught on Monday and an SSRI taught on Thursday still collide on Friday, even though no single message ever named both.
- **Usage you can grade.** `npm run stats` reads the per-user memory ledger (`/api/usage`) — or Walrus itself with `--live` — and judges the hackathon's ≥3 users × ≥10 memories requirement with an honest exit code and a walruscan link for every blob.

**All memory lives on Walrus Mainnet** — 13 memory facts for the demo persona (12 seeded + 1 taught live), all live on Mainnet; the [blob ledger](evidence/blob-ledger.md) records every blob ID (15 unique, including probes). No Postgres, no vector DB, no server-side memory store.

## Quickstart (2 minutes, no keys)

```bash
git clone https://github.com/tejas0111/dosedaughter.git
cd dosedaughter/app
npm install
cp .env.example .env        # defaults = local keyless demo; Mainnet needs keys
npm test                    # 315 checks (180 core + 61 wallet + 41 route + 11 stats + 22 frontend), no network
npm run dev                 # server on :3001
```

Try it:

```bash
# Teach a fact
curl -X POST localhost:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo-mom","message":"I take Metformin 500mg at 8pm after food"}'

# Ask — it recalls from memory
curl -X POST localhost:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo-mom","message":"What meds does mom take?"}'

# Doctor-visit summary, compiled from recall only
curl 'localhost:3001/api/summary?user=demo-mom'

# See every stored fact + Walrus blob links
open 'localhost:3001/memory?user=demo-mom'

# Live before/after demo: empty memory (day 1) vs taught memory (day 7)
open 'localhost:3001/demo'

# Printable emergency card + doctor-visit summary
open 'localhost:3001/print?user=demo-mom'

# Day 1 -> Day 90 animated replay
open 'localhost:3001/replay?user=demo-mom'
```

Without an LLM key the bot still works (echo replies that prove the memory flow). Add `OPENROUTER_API_KEY` to `.env` for real Gemini-powered replies. See `app/README.md` for the full endpoint table, Telegram setup, and troubleshooting.

## How it works

```
User (web / Telegram)
        │
        ▼
Express server ── recall top-5 (distance < 0.7) ──► inject into system prompt
        │                                                    │
        │                                         coded allergy guard (STOP)
        │                                                    │
        ▼                                                    ▼
write gate (shouldRemember) ──► Walrus Memory ──► Walrus Mainnet blob
(never saves questions)          Seal-encrypted      (receipt on /memory)
```

- **Recall before generation** — relevant memories are fetched and injected *before* the LLM sees the message.
- **Write gate after** — a `shouldRemember()` classifier decides what's worth storing; questions and chit-chat are never saved.
- **Allergy STOP guard** — runs before the LLM and blocks when the allergy is in recalled memory (distance < 0.7), citing the blob ID.
- **Per-user namespaces** — `user-<id>` isolates every family member's memory.

Full architecture, request lifecycle, safety model, and API: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

```
app/                  Express server (API + React SPA at /), Telegram bot, MemWal wrapper, seeder, 180 core + 61 wallet + 36 route + 11 stats + 22 frontend tests
docs/images/          Architecture + demo visuals (sources included)
evidence/             Append-only proof: blob ledger, test log, transcripts, load probe
```

## Evidence

Everything claimed here is verifiable:

| Claim | Proof |
|---|---|
| 13 demo-persona memory facts live on Walrus Mainnet | [evidence/blob-ledger.md](evidence/blob-ledger.md) — every blob ID with walruscan link (15 unique, incl. probes) |
| Recall + STOP guard + summary E2E | [evidence/TEST-LOG.md](evidence/TEST-LOG.md) — 44 dated probes |
| Full teach→recall→reply transcripts | [evidence/DEMO-TRANSCRIPT.md](evidence/DEMO-TRANSCRIPT.md) |
| 50/50 requests, p95 12ms, 0 errors | [evidence/LOAD-PROBE.md](evidence/LOAD-PROBE.md) |
| 315/315 offline checks pass (180 core + 61 wallet + 41 route + 11 stats + 22 frontend) | `npm test` — run it yourself |
| **Real-use requirement (≥3 users × ≥10 memories) — judged from Walrus, not vibes** | `npm run stats` (`--live` reads the relayer; every blob id links to walruscan) · [`/api/usage`](app/README.md) |
| **Every STOP/CAUTION is public and tamper-evident** | [`/guard-proof`](app/src/page.js) — append-only hash-chain ledger; `/api/guard-proof` includes a chain verification |
| **Memory that reaches out** | morning med brief + nightly interaction cross-check over the whole namespace — `/api/proactive` (on demand), `/api/nudge` (per-user tick), 6-hourly scheduler in dev |
| **Memory changes the outcome on 12/12 adverse probes** (0/5 false positives) | [`evidence/AB-RESULTS.md`](evidence/AB-RESULTS.md) — `npm run eval` (memory-off vs memory-on) |

Demo namespace on mainnet: `user-demo-mom` · Agent ID: `0x8c66ca90cc9b282f028df78dee53a89416db780dae0bc9879f605324bdbbb783`

**Judge path:** the graded memory lives in the Mainnet namespace `user-demo-mom`. Run with `MEMWAL_MODE=mainnet` + keys (or open the deployed URL) and use `/demo` (Day 1 vs Day 7 live recall) and `/memory?user=demo-mom` (every fact with its walruscan blob link). Local mode is a keyless dev stand-in only — the rubric's "all memory on Mainnet" refers to the deployed path.

## Stack

- **Node.js ≥ 20** + Express
- [`@mysten-incubation/memwal`](https://www.npmjs.com/package/@mysten-incubation/memwal) — Walrus Memory SDK (Seal-encrypted blobs on Walrus Mainnet)
- **Gemini 2.5 Flash** via OpenRouter (swappable — Gemini default with a free-model fallback chain; recall→reply verified live on three free non-OpenAI/Anthropic models, two wired into the fallback chain)
- Optional Telegram channel (`node-telegram-bot-api`)
- Vercel-ready for the shared demo (`api/index.js` + `DEPLOY.md`) — see deployment caveat below

**Deployment caveat:** per-user wallet memory stores delegate keys in a local JSON registry (`app/src/userRegistry.js`). Vercel's serverless disk is ephemeral, so a redeploy loses those keys and users must relink their wallet; the memory blobs themselves remain on Mainnet.

## UI

The chat interface is **hand-written** (HTML/CSS/JS, no framework, no build step) and served from `app/public/` — no UI library is vendored, and the Content-Security-Policy allows scripts only from `'self'`. Third-party runtime dependencies are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Medical disclaimer

DoseDaughter reminds and flags only — it never adjusts dosages and is not medical advice. Always confirm with your doctor.

## License

[MIT](LICENSE)
