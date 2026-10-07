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

const { UsageTracker } = await import('./usage.js');
const { SqliteUsage, createStores } = await import('./db.js');
const { default: app } = await import('./server.js');

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

test('JSON: stored turn list is capped (last 50)', () => {
  let t = 1_700_000_000_000;
  const u = new UsageTracker({ now: () => t });
  for (let i = 0; i < 60; i++) { u.noteDay('hog'); t += 1000; }
  const rec = u.users.get('hog');
  assert.ok(rec.window.length <= 50, `window capped, got ${rec.window.length}`);
  assert.equal(u.checkDay('hog', 1000).used, rec.window.length);
});

test('JSON: wallet channel stays on the UTC-day bucket', () => {
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

test('SQLite: staggered expiry + wallet UTC-day bucket untouched', () => {
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
  // wallet daily bucket: legacy positional override still works
  usage.noteDay('w1', '2026-01-01');
  assert.equal(usage.checkDay('w1', 200, '2026-01-01').used, 1);
  assert.equal(usage.checkDay('w1', 200, '2026-01-02').used, 0);
});

test('SQLite: turn list capped at 50 rows per key', () => {
  const { usage } = createStores({ dbPath: ':memory:' });
  let t = 1_700_000_000_000;
  for (let i = 0; i < 60; i++) { usage.noteDay('hog', { now: t }); t += 1000; }
  const n = usage.db.prepare('SELECT COUNT(*) AS c FROM turns WHERE userId = ?').get('hog').c;
  assert.ok(n <= 50, `turns capped, got ${n}`);
});

// ================= route-level: budget contract =================
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
  const h = { 'X-Device-Id': `win-${Date.now()}` };
  const r = await post('/api/chat', { userId: `win-u-${Date.now()}`, message: 'She takes Metformin 500mg at 8pm' }, h);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.budget, 'budget present on success');
  assert.equal(j.budget.cap, 4, 'anon cap from env');
  assert.equal(j.budget.used, 1);
  assert.equal(j.budget.remaining, 3);
  assert.ok(j.budget.resetAt, 'resetAt ISO present once a turn is spent');
  assert.ok(!Number.isNaN(Date.parse(j.budget.resetAt)), 'resetAt parses as a date');
});

test('route: anon 429 carries remaining:0 + resetAt + resetInHrs', async () => {
  const h = { 'X-Device-Id': `win429-${Date.now()}` };
  const u = `win429-u-${Date.now()}`;
  for (let i = 0; i < 4; i++) assert.equal((await post('/api/chat', { userId: u, message: `hello number ${i}` }, h)).status, 200);
  const r = await post('/api/chat', { userId: u, message: 'one more please' }, h);
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.equal(j.remaining, 0);
  assert.ok(j.resetAt && !Number.isNaN(Date.parse(j.resetAt)), 'resetAt is an ISO date');
  assert.ok(typeof j.resetInHrs === 'number' && j.resetInHrs >= 1 && j.resetInHrs <= 24, `resetInHrs sane, got ${j.resetInHrs}`);
  assert.equal(j.loginRequired, true);
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
  const h = { 'X-Device-Id': `windash-${Date.now()}` };
  const u = `windash-u-${Date.now()}`;
  await post('/api/chat', { userId: u, message: 'She takes Metformin 500mg at 8pm' }, h);
  const j = await (await get(`/api/dashboard?user=${encodeURIComponent(u)}`, h)).json();
  const b = j.personal.budget;
  assert.equal(b.cap, 4);
  assert.equal(b.used, 1);
  assert.equal(b.remaining, 3);
  assert.ok(b.resetAt && !Number.isNaN(Date.parse(b.resetAt)));
});
