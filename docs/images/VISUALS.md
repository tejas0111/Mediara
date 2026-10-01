# Article visuals — what goes where, and how to make more

All four images are rendered, submission-ready PNGs at 2× DPI (retina-sharp on Medium/Inkray).
Sources live in `docs/images/src/*.html` — edit the HTML, then re-render with:

```bash
cd docs/images
render() { chromium --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=$2 --screenshot="$1" "file://$PWD/src/$3"; }
render banner-dosedaughter.png 1600,800 banner.html
render stop-receipt.png        1400,760 stop-receipt.html
render before-after.png        1500,880 before-after.html
render architecture.png        1600,840 architecture.html
```

## The four assets and their jobs

| File | Placed at | Job in the article |
|---|---|---|
| `banner-dosedaughter.png` | Top (hero) | 3-second pitch: title, Walrus mainnet proof chips (13 blobs / d=0.54 / STOP guard / 236 tests), a live chat snippet with a real blob id. Makes a scrolling judge stop. |
| `before-after.png` | "Side-by-side: before/after" section | The judged criterion #2 in one glance — Day1 (0 blobs, hedges) vs Day7 (13 blobs, STOP + receipt). Bars quantify it; quote cards make it emotional. |
| `stop-receipt.png` | Allergy-trap section | The money shot as a terminal receipt: `STOP — do not give ibuprofen`, brand-name trap (Advil appears in no stored fact), walruscan verify link. Judges click things — this tells them what to click. |
| `architecture.png` | "The integration" section | The recall→guard→generate→save loop with the two Walrus nodes highlighted. Shows the pattern is disciplined, not accidental. |

## Design rules used (keep them for any new image)

1. **Dark navy + teal** palette (#081120 / #14b8a6) — matches Walrus brand energy, reads well in both Medium light/dark themes.
2. **Real data only.** Blob ids, distances, counts on the images are the verified ones from `evidence/blob-ledger.md` / `TEST-LOG.md`. If numbers change, re-render — never ship a stale claim.
3. **One idea per image**, big type, no clutter. Judges give each image ~3 seconds.
4. **Mono font for anything clickable** (blob ids, URLs) — signals "this is verifiable, go check".
5. 2× device-scale-factor for retina sharpness; PNG sizes 200–700 KB each (Medium-safe).

## Alt text (paste into Medium/Inkray image descriptions)

- banner: `DoseDaughter — caregiver chatbot that never re-asks a dose. 13 blobs on Walrus Mainnet, allergy STOP-guard citing blob ids, 236/236 tests.`
- before-after: `Day 1 vs Day 7: same question "can she take ibuprofen", same model — Day 1 hedges with 0 memories, Day 7 blocks with a blob receipt.`
- stop-receipt: `Terminal receipt: STOP — do not give ibuprofen, recalled allergy with blob _7oVBL39o…, verifiable on walruscan.com. Brand name Advil triggers via generic-name map.`
- architecture: `DoseDaughter loop: recall from Walrus Memory before generation, coded allergy guard before the LLM, write gate saves only durable facts as new blobs.`

## Future images worth making (only if time permits)

- **Receipts-page screenshot** (`/memory?user=demo-mom`) — real UI beats diagrams for trust; capture after deploy.
- **Bug-bounty trio card** — #966/#967/#968 as three cards with one-line summaries; strengthens the "we gave back" narrative in the article and feedback form.
- **7-day log sparkline** — after the real-user week, a small chart of facts-added/day. Only make it with real data.
