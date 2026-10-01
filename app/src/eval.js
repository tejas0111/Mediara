// DoseDaughter — RED-TEAM RUN: a re-runnable, keyless, deterministic eval.
// `npm run eval` prints a live score for the two claims that matter:
//   1) the coded guard (allergy + drug–drug) fires on danger and stays silent
//      on safe/negated/teaching inputs — no LLM, no network;
//   2) recall actually returns a taught fact.
// Writes evidence/EVAL.md so the number is a repo artifact, not a prose claim.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findConflict, findInteraction, recallRelevant, shouldRemember } from './memory.js';
import { createLocalClient } from './localClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const rows = [];
function check(group, name, cond, detail = '') {
  if (cond) { pass++; } else { fail++; }
  rows.push({ group, name, ok: !!cond, detail });
  const mark = cond ? 'ok  ' : 'FAIL';
  console.log(`${mark} [${group}] ${name}${cond ? '' : '   <- ' + detail}`);
}

// ---------- 1. GUARD probes (pure functions; no LLM, no network) ----------
const mem = (texts) => texts.map((t, i) => ({ text: t, blob_id: `blob-${i}`, distance: 0.2 }));
const allergy = mem(['She is allergic to ibuprofen, causes rash (told Apr 2)']);
const penicillin = mem(['She is allergic to penicillin, anaphylaxis']);
const sulfa = mem(['allergic to sulfa drugs, rash']);
const warfarin = mem(['she takes warfarin 5mg daily for AFib']);
const stoppedWarf = mem(['she stopped taking warfarin in 2019']);
const nitrate = mem(['takes nitroglycerin for angina']);
const statin = mem(['takes atorvastatin 20mg at night']);

const G = (name, fn, expect) => {
  const got = fn();
  check('guard', name, got === expect, `expected ${expect}, got ${got}`);
};
G('ibuprofen allergy blocks ibuprofen', () => !!findConflict('Can she take ibuprofen?', allergy), true);
G('ibuprofen allergy blocks Advil', () => !!findConflict('Can she take Advil?', allergy), true);
G('ibuprofen allergy blocks Aleve (class)', () => !!findConflict('Can she take Aleve?', allergy), true);
G('ibuprofen allergy blocks Excedrin (class)', () => !!findConflict('Can she take Excedrin?', allergy), true);
G('ibuprofen allergy does NOT block Tylenol', () => !!findConflict('Can she take Tylenol?', allergy), false);
G('class question "an NSAID" blocks', () => !!findConflict('Can she take an NSAID for pain?', allergy), true);
G('penicillin allergy blocks penicillin', () => !!findConflict('Can she take penicillin?', penicillin), true);
G('penicillin allergy blocks amoxicillin (class)', () => !!findConflict('Can she take amoxicillin?', penicillin), true);
G('sulfa allergy blocks Bactrim (brand)', () => !!findConflict('Can she take Bactrim?', sulfa), true);
G('hives-from-ibuprofen fact blocks', () => !!findConflict('Can she take ibuprofen?', mem(['she gets hives from ibuprofen'])), true);
G('mixed negation blocks only the real allergy', () => !!findConflict('Can she take ibuprofen?', mem(['not allergic to penicillin but allergic to ibuprofen'])), true);
G('mixed negation does NOT block penicillin', () => !!findConflict('Can she take penicillin?', mem(['not allergic to penicillin but allergic to ibuprofen'])), false);
G('compound fact does NOT cross-block metformin', () => !!findConflict('Can she take Metformin?', mem(['allergic to penicillin; takes Metformin 500mg at 8pm'])), false);
G('"ibuprofen is fine" does NOT block', () => !!findConflict('Can she take ibuprofen?', mem(['allergic to penicillin; ibuprofen is fine'])), false);
G('teaching an allergy does NOT fire', () => !!findConflict('She is allergic to ibuprofen, causes rash', allergy), false);
G('imperative bypass DOES fire', () => !!findConflict('give her ibuprofen even though she is allergic', allergy), true);
G('STOP never reports a symptom word', () => { const c = findConflict('Can she take ibuprofen?', mem(['allergic to ibuprofen, rash'])); return c && !/rash|hives|swelling/i.test(c.substance); }, true);
G('warfarin + ibuprofen -> interaction STOP', () => { const i = findInteraction('Can she take ibuprofen?', warfarin); return !!i && i.severity === 'high'; }, true);
G('stopped warfarin does NOT interact', () => !!findInteraction('Can she take ibuprofen?', stoppedWarf), false);
G('paracetamol does NOT interact with warfarin', () => !!findInteraction('Can she take paracetamol?', warfarin), false);
G('nitrate + sildenafil -> interaction', () => !!findInteraction('Is sildenafil safe?', nitrate), true);
G('statin + clarithromycin -> interaction', () => !!findInteraction('Can she take clarithromycin?', statin), true);
G('write gate saves an allergy', () => shouldRemember('She is allergic to ibuprofen'), true);
G('write gate skips a question', () => shouldRemember('What meds does mom take?'), false);

// ---------- 2. RECALL probes (local stand-in; offline) ----------
const ns = 'eval-' + Date.now();
const lc = createLocalClient({ namespace: ns });
await lc.remember('Mom takes Metformin 500mg at 8pm after food');
await lc.remember('She is allergic to ibuprofen, causes rash');
await lc.remember('Dinner at 7:30pm, bedtime 10pm');
async function recallHit(query, needle) {
  const r = await recallRelevant(lc, query, 5);
  return r.some((x) => String(x.text).toLowerCase().includes(needle));
}
check('recall', 'meds query returns the Metformin fact', await recallHit('What meds does mom take?', 'metformin'));
check('recall', 'allergy query returns the ibuprofen fact', await recallHit('What is she allergic to?', 'ibuprofen'));
check('recall', 'routine query returns the dinner fact', await recallHit('What time is dinner?', 'dinner'));
check('recall', 'unrelated chit-chat returns no med fact', !(await recallHit('What is the weather today?', 'metformin')));

// cleanup local store
try {
  const store = path.join(__dirname, '..', '.local-memory.json');
  const db = JSON.parse(fs.readFileSync(store, 'utf8'));
  if (db.namespaces) delete db.namespaces[ns];
  const tmp = store + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, store);
} catch { /* best-effort */ }

// ---------- report ----------
const total = pass + fail;
console.log(`\nRED-TEAM RUN — ${pass}/${total} passed, ${fail} failed`);
const groups = [...new Set(rows.map((r) => r.group))];
const lines = [
  '# RED-TEAM RUN — memory guard eval',
  '',
  `Generated: ${new Date().toISOString()}  ·  mode: local (no LLM, no network)`,
  '',
  `**${pass}/${total} checks passed, ${fail} failed.**`,
  '',
  ...groups.map((g) => {
    const gr = rows.filter((r) => r.group === g);
    const gp = gr.filter((r) => r.ok).length;
    return `- **${g}**: ${gp}/${gr.length}`;
  }),
  '',
  '| group | check | result |',
  '|---|---|---|',
  ...rows.map((r) => `| ${r.group} | ${r.name} | ${r.ok ? '✅' : '❌ ' + r.detail} |`),
  '',
  '_Re-run: `npm run eval` (from `app/`)._',
  '',
];
try { fs.writeFileSync(path.join(__dirname, '..', '..', 'evidence', 'EVAL.md'), lines.join('\n')); } catch { /* best-effort */ }
process.exit(fail ? 1 : 0);
