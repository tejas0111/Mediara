// Budget-key unification tests (SPEC §3 rule 6: ONE canonical budget key per
// identity shared by the chat enforcement path and the dashboard readout).
//
// HISTORICAL CONTEXT (pre-unification bug, fixed 2026-10-07): wallet vault
// owners used to split spend across two keys — chat turns under the truncated
// `safeUser` (48-char prefix of `0x…`) while the dashboard read
// `vault-<sha32>` — so turns, memories, and guard hits disagreed between the
// two paths. The table below records that split as the bug it was, not as
// current behavior.
//   wallet vault owner → WAS split (chat trunc vs dashboard vault-hash),
//     NOW unified on the lowercase session address everywhere;
//   guest anon → turns agree on `guest:<hash12>` both paths; memories are
//     namespace-keyed (recordMemory(safeUser)) so dashboard shows 0 →
//     intentionally UNCHANGED (namespace evidence, see report).
//   demo ids → same key both paths → already unified.
//
// Canonical rule under test: wallet turns/memories/guards key on the lowercase
// session address everywhere; pre-unification rows heal at read time (union,
// never rewrite, never drop).
// Run: node --test src/budget-keys.test.js  (part of `npm test`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- JSON/file impl app (route contract) ----
const TMP = path.join(os.tmpdir(), `dd-budgetkeys-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.DD_LOCAL_STORE = path.join(TMP, 'local-memory.json');
// Seed legacy wallet rows BEFORE the server module constructs its tracker:
// the JSON impl loads this file at construction, so pre-seeded spend must
// still enforce and display after unification (never orphaned, never reset).
const LEGACY_ADDR = '0x' + 'b7'.repeat(32);
const LEGACY_TRUNC = LEGACY_ADDR.slice(0, 48); // normalizeUser 48-char prefix
process.env.DD_USAGE_LEDGER = path.join(TMP, 'usage.json');
process.env.DD_GUARD_PROOF = path.join(TMP, 'gp.json');
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 'budgetkeys-test-secret';
process.env.OPENROUTER_API_KEY = '';
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_REGISTRY_PATH = path.join(TMP, 'registry.json');

const { UsageTracker, GuardProof } = await import('./usage.js');
// Mixed-case legacy key: same letters as MIXED_ADDR's 48-prefix, different
// case. Pre-unification rows were keyed by caller-cased safeUser, so history
// can hold any casing — the read-time union must match case-insensitively.
const MIXED_ADDR = '0x' + 'a7'.repeat(32);
const MIXED_TRUNC = '0x' + 'A7'.repeat(23);
{
  // Two historical turns + one historical memory under the OLD chat-side key.
  const seed = new UsageTracker({ persistPath: process.env.DD_USAGE_LEDGER });
  seed.touchUser(LEGACY_TRUNC, { turn: true });
  seed.touchUser(LEGACY_TRUNC, { turn: true });
  seed.recordMemory(LEGACY_TRUNC, { blobId: 'local-legacy-1', text: 'legacy take' });
  // One historical turn + memory + guard receipt under a MIXED-CASE legacy key.
  seed.touchUser(MIXED_TRUNC, { turn: true });
  seed.recordMemory(MIXED_TRUNC, { blobId: 'local-legacy-mixed', text: 'legacy mixed take' });
  const seedGuards = new GuardProof({ persistPath: process.env.DD_GUARD_PROOF });
  seedGuards.record({ userId: LEGACY_TRUNC, kind: 'conflict', substance: 'penicillin', severity: 'high', reason: 'recalled allergy', fact: 'allergic to penicillin', blobId: null, message: 'is penicillin ok?' });
  seedGuards.record({ userId: MIXED_TRUNC, kind: 'conflict', substance: 'penicillin', severity: 'high', reason: 'recalled allergy', fact: 'allergic to penicillin', blobId: null, message: 'is penicillin ok?' });
}

const { default: app } = await import('./server.js');
const { issueSession } = await import('./walletAuth.js');
const { upsertUser } = await import('./userRegistry.js');

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
const vaultHeaders = (addr) => ({ Cookie: `dd_session=${issueSession(addr)}` });
const mkVault = (addr, tag) => upsertUser({
  address: addr, accountId: `obj-BK-${tag}`,
  delegatePrivateKey: '11'.repeat(32), delegatePublicKey: '22'.repeat(64),
  delegateAddress: '0x' + '33'.repeat(32), pendingPhase: null, pendingTxBytes: null,
});

test('wallet: chat turns agree with dashboard budget (canonical key)', async () => {
  const addr = '0x' + 'c7'.repeat(32);
  mkVault(addr, 'agree');
  const h = { ...vaultHeaders(addr), 'Content-Type': 'application/json' };
  for (let i = 0; i < 2; i++) {
    const r = await post('/api/chat', { userId: addr, message: `takes calcium at 9am note ${i}` }, h);
    assert.equal(r.status, 200);
  }
  const chatJ = await (await post('/api/chat', { userId: addr, message: 'takes calcium at 9am note two' }, h)).json();
  assert.equal(chatJ.budget.used, 3, 'chat enforces on the canonical key');
  const dash = await (await get('/api/dashboard', { Cookie: h.Cookie })).json();
  assert.match(dash.user, /^vault-/, 'default dashboard is the vault');
  assert.equal(dash.personal.budget.used, chatJ.budget.used, 'dashboard meter agrees with chat enforcement');
  assert.equal(dash.personal.turns, 3, 'dashboard turns agree with chat turns');
});

test('wallet: pre-unification ledger spend is preserved, never reset', async () => {
  // LEGACY_TRUNC already holds 2 turns + 1 memory from the seed above.
  mkVault(LEGACY_ADDR, 'legacy');
  const h = { ...vaultHeaders(LEGACY_ADDR), 'Content-Type': 'application/json' };
  const chatJ = await (await post('/api/chat', { userId: LEGACY_ADDR, message: 'takes calcium at 9am fresh' }, h)).json();
  assert.equal(chatJ.budget.used, 3, 'legacy 2 turns + 1 fresh turn enforce together');
  const dash = await (await get('/api/dashboard', { Cookie: h.Cookie })).json();
  assert.equal(dash.personal.budget.used, 3, 'dashboard shows legacy + fresh spend, nothing orphaned');
  assert.ok(dash.personal.memories >= 1, 'legacy memory still attributed, never dropped');
});

test('wallet: mixed-case userId still spends on the canonical key', async () => {
  const addr = '0x' + 'd7'.repeat(32);
  mkVault(addr, 'case');
  const h = { ...vaultHeaders(addr), 'Content-Type': 'application/json' };
  // 64-char mixed-case id (passes the length gate; normalises to a
  // mixed-case safeUser that must NOT become a second budget key).
  const mixed = ('0x' + 'D7'.repeat(31)).slice(0, 64);
  const r = await post('/api/chat', { userId: mixed, message: 'takes calcium at 9am' }, h);
  assert.equal(r.status, 200);
  const dash = await (await get('/api/dashboard', { Cookie: h.Cookie })).json();
  assert.equal(dash.personal.budget.used, 1, 'mixed-case spend lands on the canonical key');
});

test('dashboard: guard ledger unions pre-unification trunc receipts (no rewrite)', async () => {
  // Seeded pre-import: one guard receipt under LEGACY_TRUNC (lowercase legacy
  // chat-side key). The dashboard must count it via the trunc union keys.
  mkVault(LEGACY_ADDR, 'legacy-guard');
  const h = { ...vaultHeaders(LEGACY_ADDR), 'Content-Type': 'application/json' };
  const dash = await (await get('/api/dashboard', { Cookie: h.Cookie })).json();
  assert.ok(dash.personal.guardHits >= 1, 'dashboard counts the legacy trunc-keyed guard receipt');
});

test('mixed-case legacy trunc rows heal on chat + dashboard (no rewrite)', async () => {
  // Seeded pre-import: one turn + memory + guard receipt under MIXED_TRUNC
  // (same letters as the canonical 48-slice, different case).
  mkVault(MIXED_ADDR, 'mixed');
  const h = { ...vaultHeaders(MIXED_ADDR), 'Content-Type': 'application/json' };
  const chatJ = await (await post('/api/chat', { userId: MIXED_ADDR, message: 'takes calcium at 9am fresh' }, h)).json();
  assert.equal(chatJ.budget.used, 2, 'chat enforces legacy mixed-case turn + fresh turn together');
  const dash = await (await get('/api/dashboard', { Cookie: h.Cookie })).json();
  assert.equal(dash.personal.budget.used, 2, 'dashboard shows legacy mixed-case + fresh spend');
  assert.ok(dash.personal.guardHits >= 1, 'dashboard counts the mixed-case guard receipt');
  assert.ok(dash.personal.memories >= 1, 'legacy mixed-case memory still attributed');
});

test('guest: turns still agree on the guest key (unchanged)', async () => {  const dev = `bk-guest-${Date.now()}`;
  const u = `bk-gu-${Date.now()}`;
  const h = { 'X-Device-Id': dev };
  await post('/api/chat', { userId: u, message: 'hello one' }, h);
  await post('/api/chat', { userId: u, message: 'hello two' }, h);
  const dash = await (await get(`/api/dashboard?user=${encodeURIComponent(u)}`, h)).json();
  assert.equal(dash.personal.budget.used, 2, 'guest dashboard agrees with guest chat turns');
});

// ---- store-level: union healing on BOTH impls ----
test('unit: union heals legacy keys without loss (JSON + SQLite stores)', async () => {
  const { __budgetKeysForTest: BK } = await import('./server.js');
  assert.ok(BK, 'server exports its budget-key helpers for test');
  const { SqliteUsage } = await import('./db.js');
  for (const [name, store] of [
    ['json', new UsageTracker({})],
    ['sqlite', new SqliteUsage({ dbPath: ':memory:' })],
  ]) {
    const canon = '0x' + 'e7'.repeat(32);
    const trunc = canon.slice(0, 48);
    const vault = 'vault-abc123';
    store.touchUser(trunc, { turn: true });
    store.touchUser(trunc, { turn: true });
    store.touchUser(canon, { turn: true });
    store.recordMemory(trunc, { blobId: 'b-legacy', text: 'old take' });
    store.recordMemory(canon, { blobId: 'b-fresh', text: 'new take' });
    const keys = [canon, trunc, vault];
    const chk = BK.unionCheck(store, keys, 200, { mode: 'daily' });
    assert.equal(chk.used, 3, `${name}: daily used unions legacy + canonical`);
    assert.equal(chk.ok, true);
    const snap = BK.unionSnapshot(store, keys, canon);
    assert.equal(snap.turns, 3, `${name}: turns union without loss`);
    assert.equal(snap.memories, 2, `${name}: memories union by blob id`);
    assert.equal(snap.userId, canon);
  }
});

// ---- store-level: mixed-case legacy heals case-insensitively, both impls ----
test('unit: union heals mixed-case legacy keys case-insensitively (both stores)', async () => {
  const { __budgetKeysForTest: BK } = await import('./server.js');
  const { SqliteUsage, SqliteGuards } = await import('./db.js');
  const { GuardProof } = await import('./usage.js');
  const canon = '0x' + 'a7'.repeat(32);
  const mixedTrunc = '0x' + 'A7'.repeat(23);
  assert.equal(mixedTrunc.toLowerCase(), canon.slice(0, 48), 'fixture: same letters, different case');
  for (const [name, store] of [
    ['json', new UsageTracker({})],
    ['sqlite', new SqliteUsage({ dbPath: ':memory:' })],
  ]) {
    store.touchUser(mixedTrunc, { turn: true });
    const chk = BK.unionCheck(store, [canon, canon.slice(0, 48)], 200, { mode: 'daily' });
    assert.equal(chk.used, 1, `${name}: mixed-case legacy turn heals into the canonical readout`);
  }
  for (const [name, gp] of [
    ['json', new GuardProof({})],
    ['sqlite', new SqliteGuards({ dbPath: ':memory:' })],
  ]) {
    gp.record({ userId: mixedTrunc, kind: 'conflict', substance: 'penicillin', severity: 'high', reason: 'r', fact: 'f', blobId: null, message: 'm' });
    assert.equal(BK.unionGuardCount(gp, [canon, canon.slice(0, 48)]), 1, `${name}: mixed-case receipt heals`);
  }
});
// ---- F1 (RED): caller-typed legacy rows heal on BOTH paths (same keyset) ----
// Pre-unification wallet turns were recorded under the caller-typed safeUser
// (not the address). Chat heals them via safeUser in its keyset; the dashboard
// must agree when given the same caller-typed id.
test('wallet: caller-typed legacy rows heal on chat AND dashboard (same keyset)', async () => {
  const dir = path.join(TMP, 'f1');
  fs.mkdirSync(dir, { recursive: true });
  const ul = path.join(dir, 'usage.json');
  const gp = path.join(dir, 'gp.json');
  const CALLER = `caller-acme-mom-${Date.now() % 100000}`;
  {
    const seed = new UsageTracker({ persistPath: ul });
    seed.touchUser(CALLER, { turn: true });
    seed.touchUser(CALLER, { turn: true });
    seed.recordMemory(CALLER, { blobId: 'local-f1-1', text: 'f1 take' });
    const sg = new GuardProof({ persistPath: gp });
    sg.record({ userId: CALLER, kind: 'conflict', substance: 'penicillin', severity: 'high', reason: 'recalled allergy', fact: 'allergic to penicillin', blobId: null, message: 'is penicillin ok?' });
  }
  const prevU = process.env.DD_USAGE_LEDGER, prevG = process.env.DD_GUARD_PROOF, prevL = process.env.DD_LOCAL_STORE;
  process.env.DD_USAGE_LEDGER = ul;
  process.env.DD_GUARD_PROOF = gp;
  process.env.DD_LOCAL_STORE = path.join(dir, 'local-memory.json');
  const { default: f1app } = await import('./server.js?f1=caller-typed');
  process.env.DD_USAGE_LEDGER = prevU;
  process.env.DD_GUARD_PROOF = prevG;
  process.env.DD_LOCAL_STORE = prevL;
  const s = f1app.listen(0);
  await new Promise((r) => s.once('listening', r));
  try {
    const b = `http://127.0.0.1:${s.address().port}`;
    const addr = '0x' + 'c1'.repeat(32);
    mkVault(addr, 'f1');
    const h = { Cookie: `dd_session=${issueSession(addr)}`, 'Content-Type': 'application/json' };
    const cj = await (await fetch(b + '/api/chat', { method: 'POST', headers: h, body: JSON.stringify({ userId: CALLER, message: 'takes calcium at 9am fresh' }) })).json();
    assert.equal(cj.budget.used, 3, 'chat enforces legacy caller-typed turns + fresh turn together');
    const dj = await (await fetch(b + `/api/dashboard?user=${encodeURIComponent(CALLER)}`, { headers: { Cookie: h.Cookie } })).json();
    assert.equal(dj.personal.budget.used, 3, 'dashboard shows the same caller-typed spend as chat (same keyset)');
    assert.equal(dj.personal.turns, 3, 'dashboard turns agree with chat turns');
    assert.ok(dj.personal.memories >= 1, 'caller-typed memory still attributed');
    assert.ok(dj.personal.guardHits >= 1, 'dashboard counts the caller-typed guard receipt');
  } finally {
    try { s.close(); } catch {}
  }
});

// ---- F2 (RED): the 66->64 truncation is explicit in the union keyset ----
test('unit: 66-char canonical key carries its explicit 64-slice in the union keyset (both stores)', async () => {
  const { __budgetKeysForTest: BK } = await import('./server.js');
  const { SqliteUsage } = await import('./db.js');
  const canon = '0x' + 'e7'.repeat(32); // 66 chars
  assert.equal(canon.length, 66);
  const keys = BK.walletKeySet({ canonical: canon, safeUser: canon.slice(0, 48), vaultId: 'vault-abc123' });
  assert.ok(keys.includes(canon.slice(0, 64)), 'keyset carries the explicit store-level 64-slice');
  for (const [name, store] of [
    ['json', new UsageTracker({})],
    ['sqlite', new SqliteUsage({ dbPath: ':memory:' })],
  ]) {
    store.touchUser(canon, { turn: true });
    const chk = BK.unionCheck(store, keys, 200, { mode: 'daily' });
    assert.equal(chk.used, 1, `${name}: 66-char canonical hits its own row`);
    const snap = BK.unionSnapshot(store, keys, canon);
    assert.equal(snap.turns, 1, `${name}: snapshot hits its own row`);
  }
});

// ---- M3c (RED): unionCheck reset/resetAt/resetInHrs come from the SAME key ----
test('unit: unionCheck reset/resetAt/resetInHrs come from the same key (no mixed-source snapshot)', async () => {
  const { __budgetKeysForTest: BK } = await import('./server.js');
  const triples = {
    'key-a': { ok: true, used: 1, remaining: 9, reset: '2026-01-01', resetAt: '2026-10-08T00:00:00.000Z', resetInHrs: 5 },
    'key-b': { ok: true, used: 2, remaining: 8, reset: '2026-02-02', resetAt: '2026-10-07T00:00:00.000Z', resetInHrs: 3 },
  };
  const stub = { checkDay: (k) => triples[k] || { ok: true, used: 0, remaining: 10, reset: '2026-03-03', resetAt: null, resetInHrs: null } };
  const out = BK.unionCheck(stub, ['key-a', 'key-b'], 10);
  assert.equal(out.used, 3);
  assert.deepEqual(
    [out.reset, out.resetAt, out.resetInHrs],
    ['2026-02-02', '2026-10-07T00:00:00.000Z', 3],
    'all three fields come from the min-resetAt key',
  );
});

// ---- M5: union resolution reads each store row once, keeps case variants ----
test('unit: union resolution dedupes store-equivalent keys, keeps case variants', async () => {
  const { __budgetKeysForTest: BK } = await import('./server.js');
  const canon = '0x' + 'f7'.repeat(32); // 66 chars
  const mixed48 = '0x' + 'F7'.repeat(23); // same letters as the 48-slice, other case
  // Transparent store holding the 64-prefix row plus a mixed-case 48-row.
  const stored = [canon.slice(0, 64), mixed48];
  const out = BK.resolveUnionKeys([canon, canon.slice(0, 64), canon.slice(0, 48)], stored);
  const n64 = out.filter((k) => String(k).slice(0, 64) === canon.slice(0, 64));
  assert.equal(n64.length, 1, 'one read per store row, never two');
  assert.ok(out.includes(mixed48), 'mixed-case stored variant still covered');
  // Opaque impls (storedIds null): exact + lowercase, nothing dropped.
  assert.deepEqual(BK.resolveUnionKeys(['AbC'], null), ['AbC', 'abc']);
});

// ---- M3a (RED): reserved ids fail fast with 400 even on an exhausted budget ----
test('reserved ids fail fast: 400 even with an exhausted budget (never 429)', async () => {
  const dev = `m3a-dev-${Date.now()}`;
  const h = { 'X-Device-Id': dev, 'Content-Type': 'application/json' };
  const u = `m3a-u-${Date.now()}`;
  for (let i = 0; i < 20; i++) {
    const r = await post('/api/chat', { userId: u, message: `hello number ${i}` }, h);
    assert.equal(r.status, 200, `warmup turn ${i} spends guest budget`);
  }
  const bad = await post('/api/chat', { userId: 'w-0xabc', message: 'my mom takes Metformin 500mg at 8pm' }, h);
  assert.equal(bad.status, 400, 'reserved id fails fast with 400, not 429, on an exhausted budget');
});
// ---- route-level parity on the SQLite impl ----
test('wallet: chat/dashboard agree on the SQLite store too', async () => {
  const sqliteDir = path.join(TMP, 'sqlite');
  fs.mkdirSync(sqliteDir, { recursive: true });
  const sqliteDb = path.join(sqliteDir, 'dosedughter.db');
  // Seed one legacy turn directly in SQLite, then boot a second app instance
  // bound to that DB file (fresh module state via query suffix).
  const { createStores } = await import('./db.js');
  const seedDb = createStores({ dbPath: sqliteDb });
  const legacyAddr = '0x' + 'f7'.repeat(32);
  seedDb.usage.touchUser(legacyAddr.slice(0, 48), { turn: true });
  seedDb.db.close();
  delete process.env.DD_USAGE_LEDGER;
  delete process.env.DD_GUARD_PROOF;
  process.env.DD_DB_PATH = sqliteDb;
  const { default: sqliteApp } = await import('./server.js?store=sqlite');
  const s2 = sqliteApp.listen(0);
  await new Promise((r) => s2.once('listening', r));
  try {
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    const addr = legacyAddr;
    mkVault(addr, 'sqlite');
    const h = { Cookie: `dd_session=${issueSession(addr)}`, 'Content-Type': 'application/json' };
    const cj = await (await fetch(b2 + '/api/chat', { method: 'POST', headers: h, body: JSON.stringify({ userId: addr, message: 'takes calcium at 9am' }) })).json();
    assert.equal(cj.budget.used, 2, 'sqlite: legacy turn + fresh turn enforce together');
    const dj = await (await fetch(b2 + '/api/dashboard', { headers: { Cookie: h.Cookie } })).json();
    assert.equal(dj.personal.budget.used, 2, 'sqlite: dashboard agrees with chat');
    assert.equal(dj.personal.turns, 2);
  } finally {
    try { s2.close(); } catch {}
  }
});
