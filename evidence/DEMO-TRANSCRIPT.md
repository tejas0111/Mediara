# DEMO TRANSCRIPT — DoseDaughter end-to-end (user `e2e-mom`)

> Captured 2026-09-20 ~22:46 UTC against a live local server (`PORT=3001 node src/server.js`,
> `MEMWAL_MODE` unset → `local`). **Every `local-*` blob below is a LOCAL DEMO record in
> `app/.local-memory.json` (file-backed stand-in, zero network) — NOT Walrus Mainnet.**
> No keys were added; mainnet was never called. No LLM key set, so replies are the
> no-key fallback (`[no LLM key] system would inject N chars of memory…`) — recall injection
> is still proven via `recalled[]` and the `N chars` growth.
> A separate worker owns `app/src/telegram.js` — untouched here.

## Checks

- `node --check` on all `app/src/*.js` (memory, localClient, server, selftest, seed10, verify): OK
- `npm test` (`node src/selftest.js`): **36 passed, 0 failed** (13 at v1 capture — see TEST-LOG rows 11–15 for the dated ledger). Historical run; **current suite = 134 passed (78 core + 56 wallet/crypto)** — `npm test` runs both suites.

## 1. Teach fact 1 — `POST /api/chat {"userId":"e2e-mom","message":"My mom takes Metformin 500mg at 8pm after food"}`

```json
{
  "reply": "[no LLM key] system would inject 479 chars of memory. You said: My mom takes Metformin 500mg at 8pm after food",
  "recalled": [],
  "savedBlob": "local-0b1c191cc8f1",
  "mode": "local",
  "disclaimer": "Confirm with your doctor — this is not medical advice."
}
```

`savedBlob: local-0b1c191cc8f1` — LOCAL DEMO, not Mainnet.

## 2. Teach fact 2 — `POST /api/chat {"userId":"e2e-mom","message":"She is allergic to ibuprofen, rash"}`

```json
{
  "reply": "[no LLM key] system would inject 480 chars of memory. You said: She is allergic to ibuprofen, rash",
  "recalled": [
    "User e2e-mom: My mom takes Metformin 500mg at 8pm after food"
  ],
  "savedBlob": "local-f82300ff296a",
  "mode": "local",
  "disclaimer": "Confirm with your doctor — this is not medical advice."
}
```

`savedBlob: local-f82300ff296a` — LOCAL DEMO, not Mainnet.

## 3. Teach fact 3 — `POST /api/chat {"userId":"e2e-mom","message":"Dinner 7:30pm, bedtime 10pm"}`

```json
{
  "reply": "[no LLM key] system would inject 479 chars of memory. You said: Dinner 7:30pm, bedtime 10pm",
  "recalled": [],
  "savedBlob": "local-3436ef5e6054",
  "mode": "local",
  "disclaimer": "Confirm with your doctor — this is not medical advice."
}
```

`savedBlob: local-3436ef5e6054` — LOCAL DEMO, not Mainnet.

## 4. Recall proof — `POST /api/chat {"userId":"e2e-mom","message":"What meds does mom take?"}`

```json
{
  "reply": "[no LLM key] system would inject 575 chars of memory. You said: What meds does mom take?",
  "recalled": [
    "User e2e-mom: My mom takes Metformin 500mg at 8pm after food",
    "User e2e-mom: She is allergic to ibuprofen, rash",
    "User e2e-mom: Dinner 7:30pm, bedtime 10pm"
  ],
  "savedBlob": null,
  "mode": "local",
  "disclaimer": "Confirm with your doctor — this is not medical advice."
}
```

RECALL PROOF: `recalled[]` non-empty (3/3), med fact ranked first; question itself not saved (`savedBlob: null`).

## 5. Allergy trap — `POST /api/chat {"userId":"e2e-mom","message":"Can she take ibuprofen for headache?"}`

```json
{
  "reply": "[no LLM key] system would inject 531 chars of memory. You said: Can she take ibuprofen for headache?",
  "recalled": [
    "User e2e-mom: My mom takes Metformin 500mg at 8pm after food",
    "User e2e-mom: She is allergic to ibuprofen, rash"
  ],
  "savedBlob": null,
  "mode": "local",
  "disclaimer": "Confirm with your doctor — this is not medical advice."
}
```

Allergy fact recalled (conflict visible to the model via injected system prompt); question not saved.

## 6. Doctor summary — `GET /api/summary?user=e2e-mom`

```json
{"user":"e2e-mom","mode":"local","generatedAt":"2026-09-20T22:46:55.257Z","medications":["User e2e-mom: My mom takes Metformin 500mg at 8pm after food"],"allergies":["User e2e-mom: She is allergic to ibuprofen, rash"],"routine":["User e2e-mom: Dinner 7:30pm, bedtime 10pm"],"familyAndCare":["User e2e-mom: She is allergic to ibuprofen, rash","User e2e-mom: My mom takes Metformin 500mg at 8pm after food","User e2e-mom: Dinner 7:30pm, bedtime 10pm"],"blobCount":3,"disclaimer":"Confirm with your doctor — this is not medical advice."}
```

All sections filled; `blobCount: 3`.

## 7. Memory page — `GET /memory?user=e2e-mom`

```html
<h1>DoseDaughter remembers — e2e-mom</h1><p>LOCAL DEMO — file-backed stand-in memory, not Walrus Mainnet. Real Mainnet path (Walrus Memory) runs when MEMWAL_MODE=mainnet with keys.</p><ul><li>User e2e-mom: She is allergic to ibuprofen, rash <code>LOCAL DEMO local-f82300ff296a</code></li><li>User e2e-mom: My mom takes Metformin 500mg at 8pm after food <code>LOCAL DEMO local-0b1c191cc8f1</code></li><li>User e2e-mom: Dinner 7:30pm, bedtime 10pm <code>LOCAL DEMO local-3436ef5e6054</code></li></ul><p>Confirm with your doctor — this is not medical advice.</p>
```

All three blobs shown as LOCAL DEMO (no walruscan links for local blobs).

## Fixes applied (this session, `app/src` only)

1. `memory.js` — `shouldRemember` missed routine/time facts without "at" ("Dinner 7:30pm…"
   → `savedBlob: null`) and would have saved take-questions; widened gate to bare takes/times
   (`\d:\d`, `\d(am|pm)`), routine keywords, allergy variants, plus a never-save-questions guard.
2. `localClient.js` — word-overlap recall had no stemming/synonyms ("meds"≠"takes Metformin"),
   so `recalled[]` was empty and summary/`/memory` showed 0; added synonym canonicalization +
   stemming, and scaled local distance so topical hits pass the shared 0.7 cutoff (ranking kept).
   `MAX_DISTANCE`, `recallRelevant` signature, and the mainnet path are unchanged.
3. `server.js` — `/memory` claimed "stored on Walrus Mainnet" even in local mode and linked
    `local-*` ids to walruscan; now mode-aware (LOCAL DEMO badges, no Mainnet links for local blobs).

## 8. v2 addendum — coded safety block + live /demo (captured 04:27 IST Sept 21, user `demo-day7`)

`findConflict()` (memory.js) now blocks BEFORE any LLM output; `/demo` runs LIVE recall
on `demo-day1` (empty) vs `demo-day7` instead of static HTML. Verified against fresh server:

- Allergy trap `POST /api/chat {"userId":"demo-day7","message":"Can she take ibuprofen for her headache?"}` →
  `"STOP — do not give ibuprofen. Recalled allergy: "User demo-day7: She is allergic to ibuprofen, causes rash" (blob local-7dca6520a17d). Confirm with your doctor — this is not medical advice."`
  Coded block fired with NO LLM key set — deterministic safety from memory alone.
- `GET /demo?persona=day7` → renders `LIVE recall` with real per-namespace counts.
- `npm test` → **17 passed, 0 failed at v2 capture** (added 4 findConflict cases; 37 at the row 22 checkpoint — current suite 134: 78 core + 56 wallet).

## 9. v3 — REAL LLM reply from recall (captured 04:31 IST Sept 21, user `llm-mom`)

Owner's OpenRouter key used in-process only (never printed/stored). Model
`inclusionai/ling-3.0-flash-vl:free` (free, non-OpenAI/Anthropic → Beyond-Big-Two eligible).
Same 3 local facts taught; `POST /api/chat {"userId":"llm-mom","message":"What meds does mom take?"}`:

> "Based on what you told me, your mom takes: **Metformin 500mg** — taken at 8pm, after food.
> I also remember that she's **allergic to ibuprofen** (it causes her a severe rash),
> so that's worth keeping in mind if any new medication is ever suggested."

`recalled: 3`. The model cites BOTH the med and the allergy from injected recall —
personalization impossible on Day 1. Allergy trap on the same user still resolves to the
deterministic STOP block citing the blob. Full loop (teach → recall → generate → guard)
proven with a real model.
