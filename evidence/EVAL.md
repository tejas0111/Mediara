# RED-TEAM RUN — memory guard eval

Generated: 2026-10-07T20:04:15.648Z  ·  mode: local (no LLM, no network)

**30/30 checks passed, 0 failed.**

- **guard**: 24/24
- **recall**: 4/4
- **A/B**: 2/2

| group | check | result |
|---|---|---|
| guard | ibuprofen allergy blocks ibuprofen | ✅ |
| guard | ibuprofen allergy blocks Advil | ✅ |
| guard | ibuprofen allergy blocks Aleve (class) | ✅ |
| guard | ibuprofen allergy blocks Excedrin (class) | ✅ |
| guard | ibuprofen allergy does NOT block Tylenol | ✅ |
| guard | class question "an NSAID" blocks | ✅ |
| guard | penicillin allergy blocks penicillin | ✅ |
| guard | penicillin allergy blocks amoxicillin (class) | ✅ |
| guard | sulfa allergy blocks Bactrim (brand) | ✅ |
| guard | hives-from-ibuprofen fact blocks | ✅ |
| guard | mixed negation blocks only the real allergy | ✅ |
| guard | mixed negation does NOT block penicillin | ✅ |
| guard | compound fact does NOT cross-block metformin | ✅ |
| guard | "ibuprofen is fine" does NOT block | ✅ |
| guard | teaching an allergy does NOT fire | ✅ |
| guard | imperative bypass DOES fire | ✅ |
| guard | STOP never reports a symptom word | ✅ |
| guard | warfarin + ibuprofen -> interaction STOP | ✅ |
| guard | stopped warfarin does NOT interact | ✅ |
| guard | paracetamol does NOT interact with warfarin | ✅ |
| guard | nitrate + sildenafil -> interaction | ✅ |
| guard | statin + clarithromycin -> interaction | ✅ |
| guard | write gate saves an allergy | ✅ |
| guard | write gate skips a question | ✅ |
| recall | meds query returns the Metformin fact | ✅ |
| recall | allergy query returns the ibuprofen fact | ✅ |
| recall | routine query returns the dinner fact | ✅ |
| recall | unrelated chit-chat returns no med fact | ✅ |
| A/B | memory changed the outcome on 12/12 adverse probes | ✅ |
| A/B | no false-positive blocks on 5 safe probes | ✅ |

_Re-run: `npm run eval` (from `app/`)._
