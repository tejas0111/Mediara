# Blob ledger (append-only) — proof of ≥10 Mainnet blobs

Agent ID (MEMWAL_ACCOUNT_ID): 0x8c66ca90cc9b282f028df78dee53a89416db780dae0bc9879f605324bdbbb783
Namespace pattern: `user-<id>` (e.g. `user-demo-mom`)
Ledger rule: every `rememberAndWait` result is appended here with its walruscan link, so the agent ID and blob count can be verified publicly.

Status: **13 demo-persona memory facts live on Mainnet** (12 seeded Sept 21 + 1 taught live in chat); this ledger records **15 unique blob IDs** (13 facts + 1 verify probe + 1 manual probe copy). Every link below was either captured from a tool response or re-verified via live recall — never inferred. One wrong transcription (Metformin, caught Sept 22) was corrected after re-verification.

## 2026-09-21T12:00Z — first blobs verified on Mainnet
Agent (MEMWAL_ACCOUNT_ID): 0x8c66ca90cc9b282f028df78dee53a89416db780dae0bc9879f605324bdbbb783
Namespace: user-demo-mom (plus user-verify-probe probe)
Wallet: 0x6041ad2ec9a6a086082b8aa27d9e300adf3103c066019600efa28bb5d2d78597

Verified live (health OK → rememberAndWait OK → recall OK, distance 0.54):
- https://walruscan.com/mainnet/blob/5A280mTxCLUq3mZ7GiEPt7BSn1J4Z18ws7okx-VMkME — verify probe (user-verify-probe)
- https://walruscan.com/mainnet/blob/drJsuPZqT8XKUInCiIElzjhDkV66U2J1Tw71v37FR2U — "takes Metformin 500mg at 8pm after food"
- https://walruscan.com/mainnet/blob/JbCdbC3Hx85f5Ddg0H5bkxdjeTbHGrmWVgawEggKRyo — Metformin (manual probe copy; recall-layer dedup applied, kept best rank). ID re-verified via live recall Sept 22 — an earlier transcription of this link was wrong and is corrected here.
- https://walruscan.com/mainnet/blob/GZJ36Lu-ajlMwjPYlkYVhy5pteHEF2uZeEbEleOdaZI — "takes Amlodipine 5mg at 8am with water"
- https://walruscan.com/mainnet/blob/_7oVBL39o-pYqcQno30vZrIFHDj-ZvBJX9okIDKciMg — "allergic to ibuprofen — causes rash (told Apr 2)" ← cited by live STOP-block

Relayer note: bulk rememberBulkAndWait returned 202 but 0 indexed (rate limit); sequential
paced seeder (10.5s spacing, idempotency keys, resumable) is the working path. Remaining
9 facts seeding in background under relayer congestion (504 job waits, seal-encrypt 500s —
all retried, zero data loss; idempotency keys make re-runs safe).

## 2026-09-21T12:33:07.191Z — seed demo-mom (sequential idempotent seeder)
namespace: user-demo-mom
agent (MEMWAL_ACCOUNT_ID): 0x8c66ca90cc9b282f028df78dee53a89416db780dae0bc9879f605324bdbbb783
blobs: 12/12
- https://walruscan.com/mainnet/blob/JbCdbC3Hx85f5Ddg0H5bkxdjeTbHGrmWVgawEggKRyo
- https://walruscan.com/mainnet/blob/GZJ36Lu-ajlMwjPYlkYVhy5pteHEF2uZeEbEleOdaZI
- https://walruscan.com/mainnet/blob/_7oVBL39o-pYqcQno30vZrIFHDj-ZvBJX9okIDKciMg
- https://walruscan.com/mainnet/blob/Yn6YeYkoajbXs2jMA1JnCQfSIgsv2yg0j-ihMQ7ETm4
- https://walruscan.com/mainnet/blob/HXrwMUUoz_WiNunT_zZlFpFdntiAM3ActXNW-FEHXVI
- https://walruscan.com/mainnet/blob/hDEkeRxQHguru8H3GQcxThSoiKe7Jo0n4vSgUePB0g8
- https://walruscan.com/mainnet/blob/wWsqagp6W0aPDhov2zNfuxRqULT-juGB9IJbbZALNs0
- https://walruscan.com/mainnet/blob/_heSWDvuwj-678Y8Xop5I9BZvNCO7fClAr0uh_Bw0hA
- https://walruscan.com/mainnet/blob/AH90tbLwvYddDfuQE76PHcJO6rDaTHUh0aUn-hehNS4
- https://walruscan.com/mainnet/blob/ZSvX8qmyTJfCrmYTpXr6IW5zLvCX_zzuVdvCF1DMt4k
- https://walruscan.com/mainnet/blob/ASjyM1NW67shUiv5mlHNtHkNulElU-QrfAuc2vHx0Gw
- https://walruscan.com/mainnet/blob/uzONelynl-FNOoACkP5NszuaV-e8TeEQ46EOIL1PtTg
recall probe: 13/20

## 2026-09-21T12:40Z — write-path proof (13th blob, live chat)
- https://walruscan.com/mainnet/blob/o1fud5QzQQPfBAPaq6RROCGqz_jzTXazXGeV8kx6hB8 — "Mom takes Calcium 600mg at 9pm with milk" (taught via POST /api/chat during mainnet E2E; id verified via recall, not assumed)
