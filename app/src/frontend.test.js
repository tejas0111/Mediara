// Frontend honesty smoke: static guards for the user-visible client + print/replay.
// No DOM runner needed — these assert the shipped files keep the honesty fixes:
// blob receipts printable, replay facts hidden from AT until played, day labels
// proportional (not fictional), no innerHTML-user-data, single esc definition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('print keeps blob receipts visible (the whole point of /print)', () => {
  assert.ok(!/@media print\{[^}]*\.blobid\{display:none/.test(css), 'print stylesheet must not hide .blobid');
  assert.ok(/\.blobid\{display:inline/.test(css), 'print stylesheet shows blob ids on paper');
});

test('replay facts are hidden from assistive tech until played', () => {
  assert.ok(page.includes('aria-hidden="true"'), 'server-rendered replay items carry aria-hidden');
  assert.ok(js.includes("setAttribute('aria-hidden'") && js.includes("removeAttribute('aria-hidden')"), 'client toggles aria-hidden on play');
  assert.ok(css.includes('.replay-facts li:not(.show){visibility:hidden}'), 'hidden facts are visibility:hidden, not opacity-only');
});

test('replay day labels are proportional, not a fictional fixed array', () => {
  assert.ok(!js.includes('var days = [1, 7, 14,'), 'fictional fixed day array is gone');
  assert.ok(js.includes('dayFor'), 'proportional dayFor(idx, total) mapping exists');
  assert.ok(!page.includes('Day 87 \\u2014 STOP') && !page.includes('Day 87 — STOP'), 'hardcoded Day-87 STOP caption is gone');
});

test('client never injects user data via innerHTML', () => {
  const hits = [...js.matchAll(/innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(hits.every((h) => h === "''" || h === '""'), `innerHTML only clears, never renders data: ${JSON.stringify(hits)}`);
  assert.ok(js.includes('textContent') && js.includes('createTextNode'), 'client renders via textContent/createTextNode');
});

test('single HTML-escape definition (no esc drift)', () => {
  assert.ok(page.includes('export const esc'), 'page.js exports the single esc');
  assert.ok(server.includes("ledgerPage, esc } from './page.js'") || server.includes(", esc } from './page.js'"), 'server imports esc from page.js');
  assert.equal((server.match(/const esc = \(s\) =>/g) || []).length, 0, 'server has no duplicate esc definition');
});
