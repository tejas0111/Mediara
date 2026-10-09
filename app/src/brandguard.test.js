// Regression: real-world OTC ibuprofen brands must STOP on a recalled
// ibuprofen allergy exactly like Advil (they are the same drug). Non-NSAID
// analgesics must NOT false-STOP. Pure-function, no network, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MEMWAL_MODE = 'local';
const { findConflict, findInteraction } = await import('./memory.js');

const ALLERGY = [{ text: 'User x: allergic to ibuprofen — causes rash', blob_id: 'b1' }];

test('every real ibuprofen brand STOPs on a recalled ibuprofen allergy', () => {
  // The brands a caregiver actually types. Midol/Pamprin/Combiflam were the
  // reported bypasses (real ib tablets), so each one is named here.
  const BRANDS = [
    'midol', 'pamprin', 'combiflam', 'ibugesic', 'ibugel', 'dolgesic', 'fenbid',
    'froben', 'calprofen', 'addaprin', 'genpril', 'ibu', 'mindol', 'optifen',
    'ibumetin', 'actiprofen', 'trufen', 'ibux', 'solpaflex',
    'ibu-profren', 'ibuflamar', 'ibuespasm', 'ibudolor', 'dontol', 'salpain',
    'cabinet', 'dolofort', 'ibuprofeno', 'dashoflex',
  ];
  for (const b of BRANDS) {
    const c = findConflict(`Can she take ${b} for her cramps?`, ALLERGY);
    assert.ok(c, `${b} must STOP on a recalled ibuprofen allergy`);
    assert.equal(c.substance, 'ibuprofen', `${b} resolves to ibuprofen`);
  }
});

test('non-NSAID analgesics never false-STOP on an ibuprofen allergy', () => {
  for (const b of ['tylenol', 'panadol', 'mapap', 'paracetamol', 'tempra', 'calpol']) {
    assert.equal(findConflict(`Can she take ${b}?`, ALLERGY), null, `${b} must not STOP`);
  }
});

test('obfuscated new brands still STOP (fold + typo tolerance)', () => {
  for (const shape of ['Midol', 'MIDOL', 'm i d o l', 'midоl' /* cyrillic o */, 'midoi']) {
    assert.ok(findConflict(`can she have ${shape}?`, ALLERGY), `${shape} must STOP`);
  }
});

test('interaction guard sees new brands as ibuprofen (warfarin clash)', () => {
  const facts = [{ text: 'User x: takes Warfarin 5mg at night', blob_id: 'b2' }];
  const i = findInteraction('Can she take midol with her warfarin?', facts);
  assert.ok(i && /warfarin/i.test(i.withSubstance || 'warfarin'), 'midol must clash with warfarin');
});
