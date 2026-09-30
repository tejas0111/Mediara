// Offline self-test: pure functions only, NO MemWal network calls (per user order).
// Run: node src/selftest.js (needs node >=20)
import { namespaceFor, truncateFact, buildSystemPrompt, shouldRemember, findConflict, recallRelevant, rememberBulkAndWait, MAX_DISTANCE } from './memory.js';
import { overlap, createLocalClient } from './localClient.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok - ${name}`); } else { fail++; console.log(`FAIL - ${name}`); } };

ok(namespaceFor('demo-mom') === 'user-demo-mom', 'namespace basic');
ok(namespaceFor('  Priya S! ') === 'user-priyas', 'namespace sanitizes');
ok(namespaceFor('') === 'user-anon', 'namespace empty -> anon');
const long = 'x'.repeat(600);
ok(Buffer.from(truncateFact(long), 'utf8').length <= 500, 'truncate <=500 bytes');
ok(truncateFact('short') === 'short', 'truncate passthrough');
const sysEmpty = buildSystemPrompt([]);
ok(sysEmpty.includes('No prior memories'), 'empty recall prompts onboarding');
ok(sysEmpty.includes('not medical advice'), 'disclaimer present (empty)');
const sysFull = buildSystemPrompt([{ text: 'takes Metformin 8pm', blob_id: 'abc', distance: 0.2 }]);
ok(sysFull.includes('Metformin') && sysFull.includes('not medical advice'), 'recall injected + disclaimer');
ok(MAX_DISTANCE === 0.7, 'distance threshold 0.7');
ok(shouldRemember('I take Metformin at 8pm') === true, 'write gate saves med fact');
ok(shouldRemember('allergic to ibuprofen') === true, 'write gate saves allergy');
ok(shouldRemember('what is the weather?') === false, 'write gate skips chit-chat');
ok(shouldRemember('x'.repeat(501)) === false, 'write gate skips >500 chars');
const allergyMem = [{ text: 'User demo: allergic to ibuprofen — rash', blob_id: 'local-abc123', distance: 0.2 }];
const c1 = findConflict('Can she take ibuprofen for headache?', allergyMem);
ok(c1 && c1.substance === 'ibuprofen' && c1.blob_id === 'local-abc123', 'conflict blocks ibuprofen + cites blob');
ok(findConflict('What meds does mom take?', allergyMem) === null, 'no conflict on meds question');
ok(findConflict('Can she take ibuprofen?', [{ text: 'takes Metformin 8pm', distance: 0.1 }]) === null, 'no conflict without allergy fact');
// Brand-name coverage: "Advil" must block against an ibuprofen allergy (canonicalized).
const brandHit = findConflict('Can she take Advil for her headache?', allergyMem);
ok(brandHit && brandHit.substance === 'ibuprofen' && brandHit.blob_id === 'local-abc123', 'conflict maps brand Advil → ibuprofen');
ok(!(findConflict('Can she take Tylenol?', allergyMem)) || findConflict('Can she take Tylenol?', allergyMem).substance !== 'ibuprofen', 'different brand does not falsely match ibuprofen allergy');
ok(findConflict('', allergyMem) === null, 'no conflict on empty');
// Teaching/stating an allergy must NOT trigger the STOP guard (only questions do).
ok(findConflict('She is allergic to ibuprofen, causes rash', allergyMem) === null, 'regression: teaching an allergy is not a conflict');
ok(findConflict('avoid ibuprofen', allergyMem) === null, 'regression: "avoid X" statement is not a conflict');
ok(findConflict('Should I avoid giving her ibuprofen?', allergyMem) !== null, 'regression: question containing "avoid" still blocks');

const lc = createLocalClient({ namespace: 'user-selftest' });
const bulk = await rememberBulkAndWait(lc, ['Selftest fact one 8pm', 'Selftest fact two allergy test']);
ok(bulk.length === 2 && bulk.every((b) => b.blob_id && b.blob_id.startsWith('local-')), 'bulk fallback writes 2 local blobs');

// --- Regression: fuzz-found breaks (local only, no network) ---
const emojiCut = truncateFact('😀'.repeat(200));
ok(!emojiCut.includes('�') && Buffer.from(emojiCut, 'utf8').length <= 500, 'regression: emoji cut has no U+FFFD and fits 500B');
const cjkCut = truncateFact('日本語'.repeat(200));
ok(!cjkCut.includes('�') && Buffer.from(cjkCut, 'utf8').length <= 500, 'regression: CJK cut has no U+FFFD and fits 500B');
ok(truncateFact(null) === '' && truncateFact(123) === '123', 'regression: truncate coerces non-string');
ok(namespaceFor(null) === 'user-anon' && namespaceFor(undefined) === 'user-anon', 'regression: namespace null/undefined -> anon');
ok(namespaceFor('x'.repeat(200)).length <= 53, 'regression: namespace 200-char id bounded');
ok(shouldRemember(12345) === false && shouldRemember({}) === false, 'regression: shouldRemember non-string false, no throw');
const pluralHit = findConflict('Can she take ibuprofen?', [{ text: 'allergic to ibuprofens', blob_id: 'b1' }]);
ok(pluralHit && pluralHit.substance === 'ibuprofen', 'regression: conflict matches plural substring');
ok(findConflict('take ibuprofen?', 'allergic to ibuprofen') === null, 'regression: conflict ignores non-array recalled');
ok(findConflict('take ibuprofen?', [null, {}]) === null, 'regression: conflict skips null/empty entries');
const ovEmpty = overlap('', 'hello');
ok(ovEmpty && ovEmpty.score === 0 && ovEmpty.hit === 0, 'regression: overlap empty returns zero object');
ok(overlap(null, null).score === 0, 'regression: overlap null scores 0');
const fakeClient = { recall: async ({ limit }) => ({ results: Array.from({ length: 5 }, (_, i) => ({ text: 't' + i, distance: 0.1, blob_id: 'b' + i })).slice(0, limit) }) };
ok((await recallRelevant(fakeClient, 'q', 0)).length === 0, 'regression: recallRelevant limit 0 -> []');
ok((await recallRelevant(fakeClient, 'q', 100)).length === 5, 'regression: recallRelevant limit 100 passes through');
ok((await recallRelevant(fakeClient, 'q', -1)).length === 0, 'regression: recallRelevant negative limit -> []');

// Recall-level dedup: MemWal has no server-side dedup — duplicate texts must not crowd the prompt.
{
  const dupClient = { recall: async () => ({ results: [
    { text: 'takes Metformin 500mg at 8pm', distance: 0.2, blob_id: 'a1' },
    { text: 'Takes Metformin 500mg at 8pm ', distance: 0.25, blob_id: 'a2' },
    { text: 'allergic to ibuprofen', distance: 0.3, blob_id: 'a3' },
  ] }) };
  const dd = await recallRelevant(dupClient, 'meds', 5);
  ok(dd.length === 2, 'regression: recallRelevant dedups same-text (case/space-insensitive)');
  ok(dd[0].blob_id === 'a1', 'regression: dedup keeps best-ranked blob');
}

// Local stand-in: rapid sequential remembers + ordering + dedup + limit clamp.
{
  const tns = 'selftest-reg-' + Date.now();
  const lc = createLocalClient({ namespace: tns });
  for (let i = 0; i < 10; i++) await lc.remember(`takes Med${i} at 8pm daily routine`);
  const r5 = await lc.recall({ query: 'what meds does mom take', limit: 5 });
  ok(r5.results.length === 5, 'regression: local 10 rapid remembers, recall honors limit 5');
  const rall = await lc.recall({ query: 'what meds does mom take', limit: 20 });
  ok(rall.results.length === 10, 'regression: local recall returns all 10 in rank order');
  await lc.remember('same allergy text');
  await lc.remember('same allergy text');
  const rd = await lc.recall({ query: 'same allergy text', limit: 20 });
  ok(rd.results.filter((x) => x.text === 'same allergy text').length === 1, 'regression: local dedups same-text-twice');
  ok((await lc.recall({ query: 'meds', limit: -1 })).results.length === 0, 'regression: local negative limit -> []');
  ok((await lc.remember(null)).job_id.startsWith('job-local-'), 'regression: local remember coerces null');
  try {
    const store = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.local-memory.json');
    const db = JSON.parse(fs.readFileSync(store, 'utf8'));
    delete db.namespaces[tns];
    fs.writeFileSync(store, JSON.stringify(db, null, 2));
  } catch { /* best-effort cleanup */ }
}

// --- Regression: substance-aware conflict safety net (audit H3) ---
{
  const ibuAllergy = [{ text: 'User demo: allergic to ibuprofen — rash', blob_id: 'b-ibu', distance: 0.2 }];
  const cAleve = findConflict('Can she take Aleve?', ibuAllergy);
  ok(cAleve && (cAleve.substance === 'naproxen' || cAleve.class === 'nsaid') && cAleve.blob_id === 'b-ibu',
    'regression: ibuprofen allergy blocks Aleve (same NSAID class)');
  const cExcedrin = findConflict('Can she take Excedrin?', ibuAllergy);
  ok(cExcedrin && (cExcedrin.substance === 'aspirin' || cExcedrin.class === 'nsaid'),
    'regression: ibuprofen allergy blocks Excedrin (aspirin-class NSAID)');
  const cTylenol = findConflict('Can she take Tylenol?', ibuAllergy);
  ok(cTylenol === null, 'regression: ibuprofen allergy does NOT block Tylenol (separate class)');
  const negAllergy = [{ text: 'She is NOT allergic to ibuprofen', blob_id: 'b-neg', distance: 0.1 }];
  ok(findConflict('Can she take ibuprofen?', negAllergy) === null, 'regression: negated allergy does not block');
  ok(findConflict('Can she take ibuprofen?', [{ text: 'no known allergy', blob_id: 'b-neg2' }]) === null,
    'regression: "no known allergy" does not block');
  const descAllergy = [{ text: 'User demo: allergic to ibuprofen, causes a rash and swelling', blob_id: 'b-desc', distance: 0.2 }];
  const cd = findConflict('Can she take ibuprofen?', descAllergy);
  ok(cd && cd.substance === 'ibuprofen' && cd.substance !== 'rash' && cd.substance !== 'swelling',
    'regression: findConflict substance is a drug, never a symptom word');
  // Advil must still map to ibuprofen and cite the source blob.
  const cAdvil = findConflict('Can she take Advil?', ibuAllergy);
  ok(cAdvil && cAdvil.substance === 'ibuprofen' && cAdvil.blob_id === 'b-ibu', 'regression: Advil -> ibuprofen block');
}

// --- Regression: write gate catches natural allergy phrasing (audit H1) ---
ok(shouldRemember('no ibuprofen, gives her a rash') === true, 'regression: write gate saves "no ibuprofen, gives her a rash"');
ok(shouldRemember('avoid ibuprofen') === true, 'regression: write gate saves "avoid ibuprofen"');
ok(shouldRemember('ibuprofen makes her sick') === true, 'regression: write gate saves "ibuprofen makes her sick"');
ok(shouldRemember('she cannot have aspirin') === true, 'regression: write gate saves "she cannot have aspirin"');
ok(shouldRemember('she cannot take aspirin') === true, 'regression: write gate saves "she cannot take aspirin"');
ok(shouldRemember('intolerant to naproxen') === true, 'regression: write gate saves intolerance');
ok(shouldRemember('she had a reaction to ibuprofen') === true, 'regression: write gate saves reaction');
ok(shouldRemember('she stopped taking aspirin') === true, 'regression: write gate saves "stopped taking"');
ok(shouldRemember('switched from ibuprofen to paracetamol') === true, 'regression: write gate saves "switched from"');
ok(shouldRemember('I will call you at 5') === false, 'regression: write gate skips "I will call you at 5"');
ok(shouldRemember('dinner was nice') === false, 'regression: write gate skips "dinner was nice"');
ok(shouldRemember('what is the weather?') === false, 'regression: write gate skips weather question');
ok(shouldRemember('dinner at 6pm every day') === true, 'regression: write gate still saves real routine');

// --- Regression: recallRelevant guarantees allergy facts are considered (audit H3) ---
{
  const safetyClient = {
    recall: async ({ query }) => {
      if (/allerg/i.test(query)) {
        return { results: [{ text: 'allergic to ibuprofen', distance: 0.9, blob_id: 'safe-1' }] };
      }
      return { results: [
        { text: 'takes Metformin 8pm', distance: 0.1, blob_id: 'm1' },
        { text: 'takes Amlodipine 9pm', distance: 0.11, blob_id: 'm2' },
        { text: 'dinner at 6pm', distance: 0.12, blob_id: 'm3' },
        { text: 'daughter Priya visits', distance: 0.13, blob_id: 'm4' },
        { text: 'walks every morning', distance: 0.14, blob_id: 'm5' },
      ] };
    },
  };
  const rr = await recallRelevant(safetyClient, 'what should I cook for dinner', 5);
  ok(rr.some((r) => /allergic to ibuprofen/i.test(r.text)),
    'regression: recallRelevant surfaces allergy fact even when message query omits it');
  ok(rr.length === 5, 'regression: recallRelevant keeps limit while forcing the safety fact in');
  // Normal (non-allergy) results still obey the 0.7 distance filter.
  const farClient = { recall: async () => ({ results: [{ text: 'takes Metformin 8pm', distance: 0.95, blob_id: 'x1' }] }) };
  ok((await recallRelevant(farClient, 'meds', 5)).length === 0, 'regression: recallRelevant still filters normal results >= 0.7');
}

// --- Regression: local client atomic + serialized writes (audit M7) ---
{
  const tns = 'selftest-atomic-' + Date.now();
  const lc = createLocalClient({ namespace: tns });
  await Promise.all(Array.from({ length: 25 }, (_, i) => lc.remember(`atomic fact ${i} takes med at 8pm`)));
  const all = await lc.recall({ query: 'atomic fact takes med', limit: 50 });
  ok(all.results.filter((r) => r.text.startsWith('atomic fact')).length === 25,
    'regression: local concurrent writes all persisted (atomic + serialized)');
  let valid = true;
  try { JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.local-memory.json'), 'utf8')); }
  catch { valid = false; }
  ok(valid, 'regression: local store is valid JSON after concurrent writes');
  try {
    const store = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.local-memory.json');
    const db = JSON.parse(fs.readFileSync(store, 'utf8'));
    delete db.namespaces[tns];
    fs.writeFileSync(store, JSON.stringify(db, null, 2));
  } catch { /* best-effort cleanup */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
