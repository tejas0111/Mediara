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
process.env.DD_REGISTRY_PATH = path.join(TMPDIR, 'registry.json');

const { SqliteUsage, SqliteGuards, createStores } = await import('./db.js');
const { GuardProof } = await import('./usage.js');
const { guardBody } = await import('./guardBody.js');
const { default: app } = await import('./server.js');
const { issueSession } = await import('./walletAuth.js');
const { upsertUser } = await import('./userRegistry.js');

// Deterministic counter ids (no Date.now() — parallel-stable, no collisions).
let dbn = 0;
const dbid = (p) => `${p}-${String(++dbn).padStart(6, '0')}`;
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
const mkVault = (addr, tag) => upsertUser({
  address: addr, accountId: `obj-DB-${tag}`,
  delegatePrivateKey: '11'.repeat(32), delegatePublicKey: '22'.repeat(64),
  delegateAddress: '0x' + '33'.repeat(32), pendingPhase: null, pendingTxBytes: null,
});
const sessH = (addr) => ({ Cookie: `dd_session=${issueSession(addr)}` });
// Fresh device per test = one browser: anonymous budgets are per-guest
// (sha256(ip|deviceId)), so tests that assert counts must not share the
// process-wide 'anon' fallback key with every other request.
const devH = () => ({ 'X-Device-Id': dbid('dbdev') });

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

test('guard chain: ONE shared serialiser, JSON and SQLite hash long facts identically (slice-before-hash)', () => {
  // Reviewer-found divergence: JSON hashed the UNSLICED fact/message while
  // SQLite hashed the SLICED (500-char) form, so mixed chains could never
  // verify identically. Both record() paths must slice BEFORE hashing, so a
  // >500-char fact verifies on both stores with the same hash.
  const longFact = 'F'.repeat(600);
  const longMsg = 'M'.repeat(600);
  const input = { userId: 'parity-u', kind: 'conflict', substance: 'x', severity: 'high', reason: 'r', fact: longFact, blobId: null, message: longMsg, ns: 'user-ns1', prev: '' };
  const body1 = guardBody({ ...input, fact: String(input.fact).slice(0, 500), message: String(input.message).slice(0, 500) });
  assert.ok(body1.includes('F'.repeat(10)) && !body1.includes('F'.repeat(501)), 'shared body carries the sliced fact, never the full 600');
  const j = new GuardProof({});
  const je = j.record({ userId: 'parity-u', kind: 'conflict', substance: 'x', severity: 'high', reason: 'r', fact: longFact, blobId: null, message: longMsg, ns: 'user-ns1' });
  assert.equal(j.verify().ok, true, 'JSON ledger verifies its own long-fact receipt');
  const s = new SqliteGuards({ dbPath: ':memory:' });
  const se = s.record({ userId: 'parity-u', kind: 'conflict', substance: 'x', severity: 'high', reason: 'r', fact: longFact, blobId: null, message: longMsg, ns: 'user-ns1' });
  assert.equal(s.verify().ok, true, 'SQLite ledger verifies its own long-fact receipt');
  assert.equal(je.hash, se.hash, 'same long input → same hash on both stores (mixed chains verify identically)');
  assert.equal(je.fact.length, 500, 'stored fact sliced to 500');
  // Short bodies stay byte-identical (no migration risk for existing rows).
  const shortIn = { userId: 'u', kind: 'conflict', substance: 'x', withSubstance: undefined, severity: 'high', reason: 'r', fact: 'short fact', blobId: 'b', message: 'short msg', prev: '' };
  assert.equal(guardBody(shortIn), JSON.stringify({ userId: 'u', kind: 'conflict', substance: 'x', withSubstance: undefined, severity: 'high', reason: 'r', fact: 'short fact', blobId: 'b', message: 'short msg', prev: '' }));
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
  // Login gate (SPEC §4/A): the teach runs through a vault session; SQLite
  // enumerates the seen canonical row with counts public + texts redacted.
  const addr = '0x' + 'd0'.repeat(32);
  mkVault(addr, 'redact');
  await chat(addr, 'User-a takes Metformin 500mg at 8pm', sessH(addr));
  const j = await (await get('/api/usage')).json();
  assert.ok(j.requirement, 'requirement stays public');
  const me = j.users.find((u) => (u.memories || 0) >= 1);
  assert.ok(me, 'the taught row surfaces with counts public');
  assert.ok(me.blobs[0].blobId, 'blob ids stay public');
  for (const b of me.blobs) assert.equal(b.text, null, 'text redacted for anon');
  // REDACTION PIN (G2): the explicit `[redacted]` marker mechanism at HTTP
  // level — redacted for anon (marker present, fact text absent). The owner
  // half (marker absent, own text visible) is pinned at unit level
  // (stats.test.js redactUser false-branch): no HTTP session can own the
  // `a` namespace (vault ownership is vault-ns only), so it is unobservable
  // over the route by design.
  const md = await (await get('/api/usage?format=md')).text();
  assert.ok(/\[redacted/.test(md), 'redaction is explicit, not silent');
  assert.ok(!/metformin/i.test(md), 'redacted texts hidden in markdown for anon');
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
  // A normal namespace is login-gated now (401), not served under the ANON cap.
  const gated = await post('/api/chat', { userId: dbid('db-nondemo'), message: 'hello there' });
  assert.equal(gated.status, 401);
});

test('SQLite path: /api/dashboard returns the documented shape', async () => {
  // Login gate (SPEC §4/A): teaches run through a vault session; the default
  // dashboard is the session vault.
  const addr = '0x' + 'da'.repeat(32);
  mkVault(addr, 'dash');
  const h = sessH(addr);
  await chat(addr, 'She is allergic to ibuprofen, causes rash', h);
  await chat(addr, 'Can she take ibuprofen for her headache?', h); // fires the guard
  const j = await (await get('/api/dashboard', h)).json();
  assert.match(j.user, /^vault-/);
  assert.equal(j.mode, 'local');
  assert.equal(j.demo.userId, 'demo-mom');
  assert.equal(typeof j.demo.ready, 'boolean', 'ready is a boolean (false on an empty TMP store)');
  assert.equal(typeof j.demo.blobCount, 'number');
  assert.ok(j.personal.memories >= 0 && j.personal.turns >= 1, 'personal turns counted');
  assert.ok(j.personal.guardHits >= 1, 'guardHits counts this vault ledger entries');
  assert.equal(typeof j.personal.stale, 'boolean');
  assert.ok(j.personal.budget && typeof j.personal.budget.used === 'number' && typeof j.personal.budget.cap === 'number');
  assert.deepEqual(j.vault, { signedIn: true, onboarded: true });
});

test('SQLite path: /api/dashboard for an unknown user is honest zeros', async () => {
  const j = await (await get('/api/dashboard?user=db-ghost-nobody', devH())).json();
  assert.equal(j.personal.memories, 0);
  assert.equal(j.personal.turns, 0);
  assert.equal(j.personal.guardHits, 0);
  assert.equal(j.personal.budget.used, 0);
});
