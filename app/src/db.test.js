// SQLite-store tests (offline). This file is the ONLY suite that boots the
// server WITHOUT DD_USAGE_LEDGER/DD_GUARD_PROOF, so it exercises the SQLite
// path (DD_DB_PATH); routes.test.js / stats.test.js keep the JSON path.
// Run: node --test src/db.test.js  (part of `npm test`)
// Covers: rolling-window budget persist+rollover, guard record+verify, snapshot counts,
// /api/usage redaction + /api/dashboard on the SQLite store, and the demo/normal
// day-cap split at its default (10 vs DD_DAY_LIMIT_ANON).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Configure BEFORE importing the app (dotenv does not override existing vars).
// NOTE: DD_USAGE_LEDGER / DD_GUARD_PROOF are deliberately UNSET → SQLite store.
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-sqlite-'));
process.env.DD_DB_PATH = path.join(TMPDIR, 'dosedughter.db');
process.env.DD_LOCAL_STORE = path.join(TMPDIR, 'local-memory.json');
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 'sqlite-test-secret';
process.env.OPENROUTER_API_KEY = ''; // keyless path (guards still run)
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_DAY_LIMIT_ANON = '10000'; // high: demo namespaces must still cap at 5

const { SqliteUsage, SqliteGuards, createStores } = await import('./db.js');
const { default: app } = await import('./server.js');

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  try { server.close(); } catch {}
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
});

const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
const get = (p, headers) => fetch(base + p, { headers: headers || {} });
const chat = async (userId, message, headers) => (await post('/api/chat', { userId, message }, headers)).json();
// Fresh device per test = one browser: anonymous budgets are per-guest
// (sha256(ip|deviceId)), so tests that assert counts must not share the
// process-wide 'anon' fallback key with every other request.
const devH = () => ({ 'X-Device-Id': `dbdev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });

// ---- unit: day-budget persist + rollover (dayOverride avoids faking the clock) ----
test('SQLite usage: day-budget persists across reopen and rolls over on a new day', () => {
  const dbPath = path.join(TMPDIR, 'budget.db');
  const t1 = new SqliteUsage({ dbPath });
  t1.touchUser('u1', { turn: true });
  t1.touchUser('u1', { turn: true });
  assert.equal(t1.checkDay('u1', 20).used, 2);
  const t2 = new SqliteUsage({ dbPath }); // reopen = server restart
  assert.equal(t2.checkDay('u1', 20).used, 2, 'day count survives a reopen');
  assert.equal(t2.checkDay('u1', 2).ok, false, 'cap enforced');
  // checkDay/noteDay round-trip on an explicit other day (fresh user, so the
  // real-today bucket is untouched — noteDay sets the current day bucket,
  // same overwrite semantics as the JSON UsageTracker).
  t2.noteDay('u2', '2000-01-01');
  assert.equal(t2.checkDay('u2', 20, '2000-01-01').used, 1, 'noteDay/checkDay round-trip');
  assert.equal(t2.checkDay('u2', 20, '2000-01-02').used, 0, 'a fresh day starts at zero (rollover)');
});

// ---- unit: guard record + verify ----
test('SQLite guards: record links the chain and verify passes', () => {
  const g = new SqliteGuards({ dbPath: path.join(TMPDIR, 'guards.db') });
  const e1 = g.record({ userId: 'd', kind: 'conflict', substance: 'ibuprofen', severity: 'high', reason: 'recalled allergy', fact: 'allergic', blobId: 'local-x', message: 'q' });
  const e2 = g.record({ userId: 'd', kind: 'interaction', substance: 'x', withSubstance: 'y', severity: 'low', reason: 'r', fact: 'f', blobId: null, message: 'q2' });
  assert.equal(e2.prev, e1.hash, 'entry 2 carries entry 1 hash');
  assert.equal(g.verify().ok, true);
  assert.equal(g.countByUser('d'), 2, 'guardHits counting works');
  assert.equal(g.countByUser('nobody'), 0);
});

// ---- unit: snapshot counts ----
test('SQLite usage: snapshot counts turns + memories', () => {
  const { usage } = createStores({ dbPath: ':memory:' });
  usage.touchUser('a', { turn: true });
  usage.recordMemory('a', { blobId: 'local-1', text: 'fact one' });
  usage.recordMemory('a', { blobId: 'local-2', text: 'fact two' });
  const s = usage.snapshot('a');
  assert.equal(s.turns, 1);
  assert.equal(s.memories, 2);
  assert.equal(s.blobs.length, 2);
  const zero = usage.snapshot('ghost');
  assert.equal(zero.turns, 0);
  assert.equal(zero.memories, 0);
  assert.deepEqual(zero.blobs, []);
});

// ---- routes on the SQLite store ----
test('SQLite path: /api/usage redacts blob texts for anonymous callers', async () => {
  await chat('user-a', 'User-a takes Metformin 500mg at 8pm');
  const j = await (await get('/api/usage')).json();
  assert.ok(j.requirement, 'requirement stays public');
  const me = j.users.find((u) => u.userId === 'user-a');
  assert.ok(me && me.memories >= 1, 'counts stay public');
  assert.ok(me.blobs[0].blobId, 'blob ids stay public');
  for (const b of me.blobs) assert.equal(b.text, null, 'text redacted for anon');
});

test('SQLite path: demo namespaces hit the 10/rolling-24h cap even with high DD_DAY_LIMIT_ANON', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await post('/api/chat', { userId: 'demo-mom', message: `hello number ${i}` });
    assert.equal(r.status, 200, `demo turn ${i + 1} allowed`);
  }
  const r = await post('/api/chat', { userId: 'demo-mom', message: 'one more please' });
  assert.equal(r.status, 429, '11th demo turn refused at the default demo cap of 10');
  const j = await r.json();
  assert.equal(j.loginRequired, true);
  assert.equal(j.demoUser, 'demo-mom');
  assert.equal(j.remaining, 0);
  assert.ok(j.resetAt && !Number.isNaN(Date.parse(j.resetAt)), 'resetAt is an ISO date');
  assert.ok(typeof j.resetInHrs === 'number' && j.resetInHrs >= 1, 'human resetInHrs present');
  // A normal namespace still enjoys the high ANON cap.
  const ok = await post('/api/chat', { userId: `db-nondemo-${Date.now()}`, message: 'hello there' });
  assert.equal(ok.status, 200);
});

test('SQLite path: /api/dashboard returns the documented shape', async () => {
  const u = `db-dash-${Date.now()}`;
  const h = devH();
  await chat(u, 'She is allergic to ibuprofen, causes rash', h);
  await chat(u, 'Can she take ibuprofen for her headache?', h); // fires the guard
  const j = await (await get(`/api/dashboard?user=${encodeURIComponent(u)}`, h)).json();
  assert.equal(j.user, u);
  assert.equal(j.mode, 'local');
  assert.equal(j.demo.userId, 'demo-mom');
  assert.equal(typeof j.demo.ready, 'boolean', 'ready is a boolean (false on an empty TMP store)');
  assert.equal(typeof j.demo.blobCount, 'number');
  assert.ok(j.personal.memories >= 0 && j.personal.turns >= 1, 'personal turns counted');
  assert.ok(j.personal.guardHits >= 1, 'guardHits counts this user ledger entries');
  assert.equal(typeof j.personal.stale, 'boolean');
  assert.ok(j.personal.budget && typeof j.personal.budget.used === 'number' && typeof j.personal.budget.cap === 'number');
  assert.deepEqual(j.vault, { signedIn: false, onboarded: false });
});

test('SQLite path: /api/dashboard for an unknown user is honest zeros', async () => {
  const j = await (await get('/api/dashboard?user=db-ghost-nobody', devH())).json();
  assert.equal(j.personal.memories, 0);
  assert.equal(j.personal.turns, 0);
  assert.equal(j.personal.guardHits, 0);
  assert.equal(j.personal.budget.used, 0);
});
