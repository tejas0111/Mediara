// Rolling 24h sliding-window budget tests (both store impls) + route-level
// budget contract (success budget body, 429 body, dashboard budget).
// Run: node --test src/window.test.js  (part of `npm test`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- route server env: BEFORE importing the app ----
const TMP = path.join(os.tmpdir(), `dd-window-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.DD_LOCAL_STORE = path.join(TMP, 'local-memory.json');
process.env.DD_USAGE_LEDGER = path.join(TMP, 'usage.json');
process.env.DD_GUARD_PROOF = path.join(TMP, 'gp.json');
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 'window-test-secret';
process.env.OPENROUTER_API_KEY = '';
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_DAY_LIMIT_ANON = '4';
process.env.DD_DAY_LIMIT_DEMO = '2';
process.env.DD_DAY_LIMIT_WALLET = '10000';
process.env.SESSION_SECRET = 'window-test-secret';
process.env.DD_REGISTRY_PATH = path.join(TMP, 'registry.json');

const { UsageTracker } = await import('./usage.js');
const { SqliteUsage, createStores, WINDOW_KEEP_MAX: DB_KEEP_MAX } = await import('./db.js');
const { default: app } = await import('./server.js');
const { issueSession } = await import('./walletAuth.js');
const { upsertUser } = await import('./userRegistry.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ================= unit: JSON UsageTracker rolling window =================
test('JSON: rolling window caps demo/anon turns and expires after 24h', () => {
  let t = 1_700_000_000_000;
  const u = new UsageTracker({ now: () => t });
  const key = 'guest:abc123';
  for (let i = 0; i < 4; i++) {
    const c = u.checkDay(key, 4);
    assert.equal(c.ok, true, `turn ${i + 1} allowed`);
    u.noteDay(key);
  }
  const full = u.checkDay(key, 4);
  assert.equal(full.ok, false);
  assert.equal(full.used, 4);
  assert.equal(full.remaining, 0);
  assert.ok(full.resetAt, 'resetAt is an ISO string when the window is non-empty');
  assert.equal(full.resetAt, new Date(t + DAY).toISOString(), 'oldest turn expires exactly 24h after it happened');
  assert.equal(full.resetInHrs, 24);
  // 23h later the first turn is still inside the window.
  t += 23 * HOUR;
  assert.equal(u.checkDay(key, 4).ok, false);
  // 24h+1ms after the first turn it drops out — one slot frees.
  t += HOUR + 1;
  const after = u.checkDay(key, 4);
  assert.equal(after.ok, true, 'expiry frees a slot');
  assert.equal(after.used, 0, 'all four turns were at t0, all expired together');
  assert.equal(after.resetAt, null, 'empty window has no resetAt');
});

test('JSON: staggered turns expire one by one (oldest-first resetAt)', () => {
  let t = 1_700_000_000_000;
  const u = new UsageTracker({ now: () => t });
  u.noteDay('k');
  t += 2 * HOUR;
  u.noteDay('k');
  const c = u.checkDay('k', 2);
  assert.equal(c.ok, false);
  assert.equal(c.resetAt, new Date(1_700_000_000_000 + DAY).toISOString(), 'resetAt tracks the OLDEST in-window turn');
  t = 1_700_000_000_000 + DAY + 1; // first turn expired, second still live
  const c2 = u.checkDay('k', 2);
  assert.equal(c2.ok, true);
  assert.equal(c2.used, 1);
  assert.equal(c2.resetAt, new Date(1_700_000_000_000 + 2 * HOUR + DAY).toISOString());
});

test('JSON: write path (cap unknown) keeps up to the safety bound; checkDay prunes to max(50, cap) — the old exact-50 boundary WAS the bug (any cap above 50 pinned used at 50, fail-open)', () => {
  let t = 1_700_000_000_000;
  const u = new UsageTracker({ now: () => t });
  for (let i = 0; i < 60; i++) { u.noteDay('hog'); t += 1000; }
  const rec = u.users.get('hog');
  assert.ok(rec.window.length <= UsageTracker.WINDOW_KEEP_MAX, `write path bounded, got ${rec.window.length}`);
  assert.equal(rec.window.length, 60, 'all 60 live turns kept when the cap is unknown at write time');
  // A cap above the old 50-boundary now actually fires instead of pinning at 50.
  const c60 = u.checkDay('hog', 60);
  assert.equal(c60.used, 60, 'prune-to-cap exactness at cap 60');
  assert.equal(c60.ok, false, 'cap 60 enforces at exactly 60');
  // Small caps still keep the 50-row floor.
  const c40 = u.checkDay('hog', 40);
  assert.equal(c40.used, 50, 'floor: keep stays 50 when cap < 50');
  assert.equal(c40.ok, false);
});

test('JSON: write-path safety bound evicts oldest-first (unbounded growth impossible)', () => {
  const MAX = UsageTracker.WINDOW_KEEP_MAX;
  const t0 = 1_700_000_000_000;
  let t = t0 + (MAX + 100) * 1000;
  const u = new UsageTracker({ now: () => t });
  const seed = Array.from({ length: MAX + 100 }, (_, i) => t0 + i * 1000);
  u.users.set('big', { firstSeen: new Date().toISOString(), lastSeen: null, turns: 0, memories: new Map(), window: [...seed] });
  u.noteDay('big');
  const w = u.users.get('big').window;
  assert.equal(w.length, MAX, `write path capped at the safety bound, got ${w.length}`);
  assert.equal(w[0], seed[101], 'oldest evicted first under the safety bound');
  assert.equal(w[w.length - 1], t, 'newest turn kept');
});

test('JSON: legacy UTC-day bucket still works as a store capability (no live channel uses it)', () => {
  const u = new UsageTracker({});
  u.noteDay('w1', { mode: 'daily', day: '2026-01-01' });
  u.noteDay('w1', { mode: 'daily', day: '2026-01-01' });
  assert.equal(u.checkDay('w1', 200, { mode: 'daily', day: '2026-01-01' }).used, 2);
  assert.equal(u.checkDay('w1', 200, { mode: 'daily', day: '2026-01-02' }).used, 0, 'UTC day rollover resets the wallet bucket');
  // legacy positional dayOverride keeps working
  assert.equal(u.checkDay('w1', 200, '2026-01-01').used, 2);
});

// ================= unit: SQLite rolling window =================
test('SQLite: rolling window caps, expires, and persists across reopen', () => {
  const dbPath = path.join(TMP, 'window.db');
  let t = 1_700_000_000_000;
  const now = () => t;
  const s1 = new SqliteUsage({ dbPath, now });
  for (let i = 0; i < 4; i++) {
    assert.equal(s1.checkDay('g1', 4).ok, true);
    s1.noteDay('g1');
  }
  const full = s1.checkDay('g1', 4);
  assert.equal(full.ok, false);
  assert.equal(full.used, 4);
  assert.equal(full.resetAt, new Date(t + DAY).toISOString());
  const s2 = new SqliteUsage({ dbPath, now }); // reopen = server restart
  assert.equal(s2.checkDay('g1', 4).ok, false, 'window survives a reopen');
  t += DAY + 1;
  const after = s2.checkDay('g1', 4);
  assert.equal(after.ok, true);
  assert.equal(after.used, 0);
  assert.equal(after.resetAt, null);
});

test('SQLite: staggered expiry + legacy UTC-day bucket capability untouched', () => {
  const { usage } = createStores({ dbPath: ':memory:' });
  let t = 1_700_000_000_000;
  usage.noteDay('k', { now: t });
  usage.noteDay('k', { now: t + 2 * HOUR });
  const c = usage.checkDay('k', 2, { now: t + 2 * HOUR });
  assert.equal(c.ok, false);
  assert.equal(c.resetAt, new Date(t + DAY).toISOString());
  const c2 = usage.checkDay('k', 2, { now: t + DAY + 1 });
  assert.equal(c2.ok, true);
  assert.equal(c2.used, 1);
  // legacy UTC-day bucket capability: legacy positional override still works
  usage.noteDay('w1', '2026-01-01');
  assert.equal(usage.checkDay('w1', 200, '2026-01-01').used, 1);
  assert.equal(usage.checkDay('w1', 200, '2026-01-02').used, 0);
});

test('SQLite: write path (cap unknown) keeps up to the safety bound; checkDay prunes to max(50, cap) — the old exact-50 boundary WAS the bug (any cap above 50 pinned used at 50, fail-open)', () => {
  const { usage } = createStores({ dbPath: ':memory:' });
  let t = 1_700_000_000_000;
  for (let i = 0; i < 60; i++) { usage.noteDay('hog', { now: t }); t += 1000; }
  const n = usage.db.prepare('SELECT COUNT(*) AS c FROM turns WHERE userId = ?').get('hog').c;
  assert.equal(n, 60, 'all 60 live turns kept when the cap is unknown at write time');
  const c60 = usage.checkDay('hog', 60, { now: t });
  assert.equal(c60.used, 60, 'prune-to-cap exactness at cap 60');
  assert.equal(c60.ok, false, 'cap 60 enforces at exactly 60');
  const c40 = usage.checkDay('hog', 40, { now: t });
  assert.equal(c40.used, 50, 'floor: keep stays 50 when cap < 50');
  assert.equal(c40.ok, false);
});

test('SQLite: write-path safety bound evicts oldest-first (unbounded growth impossible)', () => {
  const { usage, db } = createStores({ dbPath: ':memory:' });
  const MAX = DB_KEEP_MAX;
  const t0 = 1_700_000_000_000;
  const N = MAX + 100;
  db.exec(`WITH RECURSIVE cnt(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM cnt WHERE x < ${N - 1}) INSERT INTO turns(userId, at) SELECT 'big', ${t0} + x * 1000 FROM cnt`);
  const t = t0 + N * 1000;
  usage.noteDay('big', { now: t });
  const rows = db.prepare('SELECT at FROM turns WHERE userId = ? ORDER BY at ASC').all('big').map((r) => r.at);
  assert.equal(rows.length, MAX, `write path capped at the safety bound, got ${rows.length}`);
  assert.equal(rows[0], t0 + 101 * 1000, 'oldest evicted first under the safety bound');
  assert.equal(rows[rows.length - 1], t, 'newest turn kept');
});

test('both stores: non-numeric cap fails closed to the zero bound (never an open gate), rolling + daily', () => {
  const t0 = 1_700_000_000_000;
  const stores = {
    json: () => new UsageTracker({ now: () => t0 }),
    sqlite: () => new SqliteUsage({ dbPath: ':memory:', now: () => t0 }),
  };
  for (const [name, mk] of Object.entries(stores)) {
    for (const bad of [undefined, NaN, 'abc', -1, Infinity]) {
      const empty = mk();
      const e = empty.checkDay(`closed-${String(bad)}`, bad);
      assert.equal(e.ok, false, `${name}: empty window with cap ${String(bad)} denies (fail-closed)`);
      assert.equal(e.remaining, 0, `${name}: empty window with cap ${String(bad)} has no remaining`);
      const spent = mk();
      spent.touchUser('closed-spent', { turn: true });
      const s = spent.checkDay('closed-spent', bad);
      assert.equal(s.ok, false, `${name}: spent window with cap ${String(bad)} denies (fail-closed)`);
      assert.equal(s.used, 1, `${name}: spent window still counts the turn`);
      const d = mk();
      const de = d.checkDay('closed-daily', bad, { mode: 'daily', day: '2026-01-01' });
      assert.equal(de.ok, false, `${name}: daily bucket with cap ${String(bad)} denies (fail-closed)`);
    }
  }
});

// ================= route-level: budget contract =================
// Deterministic counter ids (no Date.now() — parallel-stable, no collisions).
let winn = 0;
const winid = (p) => `${p}-${String(++winn).padStart(6, '0')}`;
let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  try { server.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
const get = (p, headers) => fetch(base + p, { headers: headers || {} });

test('route: every /api/chat success carries budget {used,cap,remaining,resetAt}', async () => {
  // Login gate (SPEC §4/A): the enforced rolling channel left open is demo —
  // demo-day1 carries the same rolling budget body (cap from env).
  const h = { 'X-Device-Id': winid('win') };
  const r = await post('/api/chat', { userId: 'demo-day1', message: 'She takes Metformin 500mg at 8pm' }, h);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.budget, 'budget present on success');
  assert.equal(j.budget.cap, 2, 'demo cap from env');
  assert.equal(j.budget.used, 1);
  assert.equal(j.budget.remaining, 1);
  assert.ok(j.budget.resetAt, 'resetAt ISO present once a turn is spent');
  assert.ok(!Number.isNaN(Date.parse(j.budget.resetAt)), 'resetAt parses as a date');
});

test('route: wallet 429 carries remaining:0 + resetAt + resetInHrs', async () => {
  // Login gate (SPEC §4/A): personal chat enforces on the wallet rolling bucket
  // (signed-in vault session); the anon rolling 429 shape is pinned on demo.
  const addr = '0x' + 'aa'.repeat(32);
  upsertUser({ address: addr, accountId: 'obj-WIN-429', delegatePrivateKey: '11'.repeat(32), delegatePublicKey: '22'.repeat(64), delegateAddress: '0x' + '33'.repeat(32), pendingPhase: null, pendingTxBytes: null });
  const h = { Cookie: `dd_session=${issueSession(addr)}` };
  process.env.DD_DAY_LIMIT_WALLET = '4';
  try {
    for (let i = 0; i < 4; i++) assert.equal((await post('/api/chat', { userId: addr, message: `hello number ${i}` }, h)).status, 200);
    const r = await post('/api/chat', { userId: addr, message: 'one more please' }, h);
    assert.equal(r.status, 429);
    const j = await r.json();
    assert.equal(j.remaining, 0);
    assert.ok(j.resetAt && !Number.isNaN(Date.parse(j.resetAt)), 'resetAt is an ISO date');
    assert.ok(typeof j.resetInHrs === 'number' && j.resetInHrs >= 1 && j.resetInHrs <= 24, `resetInHrs sane, got ${j.resetInHrs}`);
    assert.equal(j.loginRequired, false, 'signed-in wallet 429 carries no login prompt');
  } finally {
    process.env.DD_DAY_LIMIT_WALLET = '10000';
  }
});

test('route: high rolling cap (60) enforces at exactly 60 on the demo channel — regression: the old 50-row prune pinned used at 50 so this cap never fired', async () => {
  // Login gate (SPEC §4/A): the rolling-window route path left open is demo —
  // demo-day7 (unused elsewhere in this file) carries the same prune math.
  const prev = process.env.DD_DAY_LIMIT_DEMO;
  process.env.DD_DAY_LIMIT_DEMO = '60';
  try {
    const h = { 'X-Device-Id': winid('win60') };
    for (let i = 0; i < 60; i++) {
      const r = await post('/api/chat', { userId: 'demo-day7', message: `hello number ${i}` }, h);
      assert.equal(r.status, 200, `turn ${i + 1} of 60 allowed`);
      await r.text().catch(() => '');
    }
    const over = await post('/api/chat', { userId: 'demo-day7', message: 'one more please' }, h);
    assert.equal(over.status, 429, '61st turn refused under cap 60');
    const j = await over.json();
    assert.equal(j.remaining, 0);
    assert.equal(j.loginRequired, true);
    assert.ok(j.resetAt && !Number.isNaN(Date.parse(j.resetAt)), 'resetAt is an ISO date');
    assert.ok(typeof j.resetInHrs === 'number' && j.resetInHrs >= 1 && j.resetInHrs <= 24, `resetInHrs sane, got ${j.resetInHrs}`);
  } finally {
    if (prev === undefined) delete process.env.DD_DAY_LIMIT_DEMO;
    else process.env.DD_DAY_LIMIT_DEMO = prev;
  }
});

test('route: demo namespace rolls at DD_DAY_LIMIT_DEMO with the same 429 shape', async () => {
  const r1 = await post('/api/chat', { userId: 'demo-mom', message: 'What do you remember about her?' });
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.budget.cap, 2, 'demo cap from env');
  assert.equal((await post('/api/chat', { userId: 'demo-mom', message: 'What meds does she take?' })).status, 200);
  const r = await post('/api/chat', { userId: 'demo-mom', message: 'one more please' });
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.equal(j.remaining, 0);
  assert.ok(j.resetAt && !Number.isNaN(Date.parse(j.resetAt)));
  assert.ok(typeof j.resetInHrs === 'number' && j.resetInHrs >= 1);
});

test('route: /api/dashboard personal.budget has the full window fields', async () => {
  // Login gate (SPEC §4/A): dashboard budget fields read off the demo channel
  // (demo-day1: one turn above + this one = used 2 of cap 2).
  const h = { 'X-Device-Id': winid('windash') };
  await post('/api/chat', { userId: 'demo-day1', message: 'She takes Metformin 500mg at 8pm' }, h);
  const j = await (await get('/api/dashboard?user=demo-day1', h)).json();
  const b = j.personal.budget;
  assert.equal(b.cap, 2);
  assert.equal(b.used, 2);
  assert.equal(b.remaining, 0);
  assert.ok(b.resetAt && !Number.isNaN(Date.parse(b.resetAt)));
});
