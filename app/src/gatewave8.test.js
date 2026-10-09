// Final-gate leftovers — hunter/judge repros locked as route tests (TDD red-first).
//   FG1. /compare + /api/nudge bypass the credential-shaped guard (looser
//        reimplementations; anon victim-address reads served). Both route
//        through the SAME shared guard as the other surfaces.
//   FG2. Device rotation defeats guest budget + chat rate limit (no IP backstop
//        despite the comment claiming one). IP-keyed secondary limiter on
//        POST /api/chat (+stream).
//   FG3. Vault-count display honesty: dashboard vault `memories` is
//        recall-capped at 25 while /api/usage shows the true count —
//        `memoriesCapped` flag when the recall hit its ceiling.
//   FG4. Guard fallback cap: vaultGuardCount list-filter fallback swallowed
//        errors to silent 0 over unbounded lists — capped scan + `stale` bit.
// Run: node --test src/gatewave8.test.js   (part of `npm test`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `dd-gatewave8-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.DD_LOCAL_STORE = path.join(TMP, 'local-memory.json');
process.env.DD_USAGE_LEDGER = path.join(TMP, 'usage.json');
process.env.DD_GUARD_PROOF = path.join(TMP, 'gp.json');
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 'gatewave8-test-secret';
process.env.OPENROUTER_API_KEY = '';
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_DAY_LIMIT_ANON = '10000';
process.env.DD_DAY_LIMIT_WALLET = '10000';
process.env.DD_DAY_LIMIT_DEMO = '10000';
process.env.DD_CHAT_IP_LIMIT = '10000';
process.env.DD_REGISTRY_PATH = path.join(TMP, 'registry.json');

const { default: app, __budgetKeysForTest: BK } = await import('./server.js');
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
const mkVault = (addr, tag) => upsertUser({
  address: addr, accountId: `obj-GW8-${tag}`,
  delegatePrivateKey: '11'.repeat(32), delegatePublicKey: '22'.repeat(64),
  delegateAddress: '0x' + '33'.repeat(32), pendingPhase: null, pendingTxBytes: null,
});
const sessH = (addr) => ({ Cookie: `dd_session=${issueSession(addr)}` });
const garbageH = { Cookie: 'dd_session=garbage.token' };
// Deterministic counter ids (no Date.now() — parallel-stable, no collisions).
let gw8n = 0;
const gw8id = (p) => `${p}-${++gw8n}`;
let gw8dev = 0;
const gw8devH = () => ({ 'X-Device-Id': `gw8dev-${++gw8dev}` });

// NOTE: the FG2 test MUST stay first in this file: it asserts exact IP-bucket
// counts from a pristine 60s window (every chat/stream POST in this process
// shares one loopback-IP bucket, allowed or denied).
// ---------------- FG2: IP-keyed secondary chat limiter (rotation backstop) ----------------
test('FG2: rotation storm capped by the shared IP limiter; stream consumes + gated in the same bucket', async () => {
  // Login gate (SPEC §4/A): the storm runs on the always-open demo namespace
  // (every POST still consumes the IP bucket — allowed or denied — so the
  // limiter math is identical; the high demo cap keeps budget out of it).
  const drain = async (p, body, h) => {
    const r = await post(p, body, h);
    const t = await r.text().catch(() => '');
    return { status: r.status, text: t };
  };
  process.env.DD_CHAT_IP_LIMIT = '5';
  try {
    // Phase A — rotation storm: a fresh device every turn.
    const st = [], tx = [];
    for (let i = 0; i < 7; i++) {
      const r = await drain('/api/chat', { userId: 'demo-mom', message: 'hello there' }, gw8devH());
      st.push(r.status); tx.push(r.text);
    }
    assert.deepEqual(st.slice(0, 5), [200, 200, 200, 200, 200], 'five rotations pass under the IP limit');
    assert.deepEqual(st.slice(5), [429, 429], 'further rotations refused despite fresh devices');
    assert.match(tx[5], /Too many requests/, 'the refusal is the rate limiter, not budget');
    // A stream attempt is gated by the same chat-filled bucket (8th count).
    assert.equal((await drain('/api/chat/stream', { userId: 'demo-mom', message: 'hello stream' }, gw8devH())).status, 429, 'stream gated by the chat-filled IP bucket');
    // Phase B — streams CONSUME from the same bucket: 8 counts used, limit 12
    // leaves exactly 4 slots; [stream, stream, chat, chat, chat, chat] 429s on
    // the 5th ONLY if both stream slots counted (else all six pass).
    process.env.DD_CHAT_IP_LIMIT = '12';
    const seq = [];
    seq.push((await drain('/api/chat/stream', { userId: 'demo-mom', message: 'hello stream' }, gw8devH())).status);
    seq.push((await drain('/api/chat/stream', { userId: 'demo-mom', message: 'hello again stream' }, gw8devH())).status);
    for (let i = 0; i < 4; i++) seq.push((await drain('/api/chat', { userId: 'demo-mom', message: 'hello there' }, gw8devH())).status);
    assert.deepEqual(seq, [200, 200, 200, 200, 429, 429], 'streams consume the shared IP budget and are gated by it');
  } finally {
    process.env.DD_CHAT_IP_LIMIT = '10000';
  }
  // Control: with a generous IP limit a fresh single device chats normally.
  assert.equal((await drain('/api/chat', { userId: 'demo-mom', message: 'hello there' }, gw8devH())).status, 200, 'single-device behavior unchanged by the backstop');
});

// ---------------- FG1: /compare through the shared credential guard ----------------
test('FG1-compare: anon /compare naming a victim address is 400, never served', async () => {
  const victim = '0x' + 'e1'.repeat(32);
  // The old anon trunc-prefix plant vector is closed by the login gate (401).
  const plant = await post('/api/chat', { userId: victim.slice(0, 48), message: 'She takes cmpplant 5mg at 9pm every night' });
  assert.equal(plant.status, 401, 'anon shadow-namespace write closed by the login gate');
  const r = await get(`/compare?a=${victim}&b=demo-day7`);
  assert.equal(r.status, 400, 'anon victim-address compare refused, never served');
  const j = await r.json();
  assert.match(j.error, /sign in/i, 'error names the recovery (sign in)');
  assert.equal(j.loginRequired, true, 'sign-in action flag present');
});

test('FG1-compare: B-state viewer naming a victim address (a or b) is 400', async () => {
  const viewer = '0x' + 'e2'.repeat(32); // signed in, no vault
  const h = sessH(viewer);
  const victim = '0x' + 'e3'.repeat(32);
  assert.equal((await get(`/compare?a=${victim}&b=demo-day7`, h)).status, 400, 'victim in a refused');
  assert.equal((await get(`/compare?a=demo-mom&b=${victim}`, h)).status, 400, 'victim in b refused');
  assert.equal((await get(`/compare?a=user-${victim}&b=demo-day7`, h)).status, 400, 'user- prefix does not dodge');
});

test('FG1-compare: B-state self (own credential-shaped id) is 409, C-state self passes', async () => {
  const addr = '0x' + 'e4'.repeat(32); // signed in, no vault
  const h = sessH(addr);
  assert.equal((await get(`/compare?a=${addr}&b=demo-day7`, h)).status, 409, 'B-state self compare fails closed like reads');
  const owner = '0x' + 'e5'.repeat(32);
  mkVault(owner, 'cmp-self-ok');
  assert.equal((await get(`/compare?a=${owner}&b=demo-day7`, sessH(owner))).status, 200, 'C-state self compare follows the vault path, never refused');
});

test('FG1-compare: ordinary ids + expired order preserved (200 / 401 / 0X carve-out)', async () => {
  assert.equal((await get('/compare?a=demo-mom&b=demo-day7')).status, 200, 'anonymous ordinary compare still renders');
  const victim = '0x' + 'e6'.repeat(32);
  assert.equal((await get(`/compare?a=${victim}&b=demo-day7`, garbageH)).status, 401, 'expired + credential stays 401 (order preserved)');
  const upper = '0X' + 'e7'.repeat(32);
  const cu = await get(`/compare?a=${upper}&b=demo-day7`);
  assert.equal(cu.status, 400, '0X-prefix hits the unified length bound on compare too — never a hashed serve');
  assert.ok(!('loginRequired' in (await cu.json())), 'length refusal carries no credential sign-in flag');
});

// ---------------- FG1: /api/nudge through the shared credential guard ----------------
test('FG1-nudge: anon /api/nudge targeting a victim address is 400, never served', async () => {
  const victim = '0x' + 'f1'.repeat(32);
  const r = await post('/api/nudge', { users: [victim], hour: 8 });
  assert.equal(r.status, 400, 'anon victim-address nudge refused, never served');
  const j = await r.json();
  assert.match(j.error, /sign in/i, 'error names the recovery (sign in)');
  assert.equal(j.loginRequired, true, 'sign-in action flag present');
});

test('FG1-nudge: B-state viewer targeting a victim (or prefixed) address is 400; mixed batches refused', async () => {
  const viewer = '0x' + 'f2'.repeat(32); // signed in, no vault
  const h = sessH(viewer);
  const victim = '0x' + 'f3'.repeat(32);
  assert.equal((await post('/api/nudge', { users: [victim], hour: 8 }, h)).status, 400, 'B-state non-self victim refused');
  assert.equal((await post('/api/nudge', { users: ['user-' + victim], hour: 8 }, h)).status, 400, 'prefix does not dodge');
  assert.equal((await post('/api/nudge', { users: [gw8id('gw8-plain'), victim], hour: 8 }, h)).status, 400, 'one credential-shaped target refuses the batch');
});

test('FG1-nudge: B-state self (own credential-shaped id) is 409; ordinary + reserved behavior unchanged', async () => {
  const addr = '0x' + 'f4'.repeat(32); // signed in, no vault
  const h = sessH(addr);
  assert.equal((await post('/api/nudge', { users: [addr], hour: 8 }, h)).status, 409, 'B-state self nudge fails closed, never served');
  const r = await post('/api/nudge', { users: [gw8id('gw8-ok')], hour: 8 });
  assert.equal(r.status, 200, 'anonymous ordinary nudge still answers');
  const res = await post('/api/nudge', { users: ['!!vault-abc', '..w-0xabc'], hour: 8 });
  assert.equal(res.status, 200, 'reserved filtering unchanged');
  assert.deepEqual((await res.json()).users, [], 'reserved namespaces still resolve to no targets');
});

// ---------------- FG3: vault-count display honesty (memoriesCapped) ----------------
test('FG3: vault dashboard flags memoriesCapped when recall hits its 25-fact ceiling', async () => {
  const addr = '0x' + 'c1'.repeat(32);
  mkVault(addr, 'cap-big');
  const h = sessH(addr);
  for (let i = 0; i < 30; i++) {
    const t = await post('/api/chat', { userId: addr, message: `She takes capmed${String(i).padStart(2, '0')} 5mg at 9pm every night` }, h);
    assert.equal(t.status, 200, `teach ${i} stored`);
  }
  const d = await (await get('/api/dashboard', h)).json();
  assert.equal(d.personal.memories, 25, 'vault display shows the recall ceiling');
  assert.equal(d.personal.memoriesCapped, true, 'capped flag set — never a silent understatement');
});

test('FG3: small vaults and guest views report memoriesCapped:false (field always present)', async () => {
  const addr = '0x' + 'c2'.repeat(32);
  mkVault(addr, 'cap-small');
  const h = sessH(addr);
  await post('/api/chat', { userId: addr, message: 'She takes tinymed 5mg at 9pm every night' }, h);
  const d = await (await get('/api/dashboard', h)).json();
  assert.ok(d.personal.memories < 25, 'small vault under the ceiling');
  assert.equal(d.personal.memoriesCapped, false, 'no cap hit, flag false');
  const g = await (await get('/api/dashboard?user=' + gw8id('gw8-guestcap'))).json();
  assert.equal(g.personal.memoriesCapped, false, 'guest readout carries the field too (additive, false)');
});

// ---------------- FG4: vaultGuardCount fallback cap + honesty bit ----------------
test('FG4-unit: vaultGuardCount surfaces stale instead of a silent 0 on failure', async () => {
  const broken = { list() { throw new Error('ledger down'); } };
  const r = BK.vaultGuardCount(broken, 'user-vault-x');
  assert.equal(r.count, 0, 'count stays 0');
  assert.equal(r.stale, true, 'failure is labelled stale, never a silent 0');
});

test('FG4-unit: vaultGuardCount counts exactly on small ledgers, flags full-page scans', async () => {
  const CAP = BK.GUARD_SCAN_CAP || 5000;
  const small = { list() { return [{ ns: 'user-vault-a' }, { ns: 'user-other' }, { ns: 'user-vault-a' }]; } };
  const r = BK.vaultGuardCount(small, 'user-vault-a');
  assert.equal(r.count, 2, 'exact count on a small ledger');
  assert.equal(r.stale, false, 'small scan is exact, not stale');
  const full = { list() { return Array.from({ length: CAP }, () => ({ ns: 'user-vault-a' })); } };
  const f = BK.vaultGuardCount(full, 'user-vault-a');
  assert.equal(f.count, CAP, 'full page counted');
  assert.equal(f.stale, true, 'a full page may hide older receipts — labelled stale');
});

test('FG4-route: dashboard carries guardStale:false with a numeric guardHits (additive)', async () => {
  const addr = '0x' + 'c9'.repeat(32);
  mkVault(addr, 'guardstale');
  await post('/api/chat', { userId: addr, message: 'She takes gsmed 5mg at 9pm every night' }, sessH(addr));
  const u = gw8id('gw8-guardstale');
  const j = await (await get('/api/dashboard?user=' + u)).json();
  assert.equal(typeof j.personal.guardHits, 'number', 'guardHits stays numeric');
  assert.equal(j.personal.guardStale, false, 'healthy ledger is not stale');
});
