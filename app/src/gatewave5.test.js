// GATE WAVE 5 fixes — hunter repros locked as route tests (TDD red-first).
//   1. vault-dashboard pollution via attacker-writable address ids (anon chat as
//      a victim 0x{64} address → 400; vault evidence vault-grounded, fail-closed)
//   2. B-state (signed-in, no vault) non-self reads serve the requested ns,
//      never 409 (chat-409 untouched); B-state SELF credential-shaped reads
//      409 fail-closed (wave-7: shadow-plant self-serve fix)
//   3. expired-session (garbage dd_session) → 401 on /api/usage, /api/nudge,
//      /compare (no cookie → unchanged 200)
// Run: node --test src/gatewave5.test.js   (part of `npm test`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `dd-gatewave5-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.DD_LOCAL_STORE = path.join(TMP, 'local-memory.json');
process.env.DD_USAGE_LEDGER = path.join(TMP, 'usage.json');
process.env.DD_GUARD_PROOF = path.join(TMP, 'gp.json');
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 'gatewave5-test-secret';
process.env.OPENROUTER_API_KEY = '';
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_DAY_LIMIT_ANON = '10000';
process.env.DD_DAY_LIMIT_WALLET = '10000';
process.env.DD_REGISTRY_PATH = path.join(TMP, 'registry.json');

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
const mkVault = (addr, tag) => upsertUser({
  address: addr, accountId: `obj-GW5-${tag}`,
  delegatePrivateKey: '11'.repeat(32), delegatePublicKey: '22'.repeat(64),
  delegateAddress: '0x' + '33'.repeat(32), pendingPhase: null, pendingTxBytes: null,
});
const sessH = (addr) => ({ Cookie: `dd_session=${issueSession(addr)}` });
const garbageH = { Cookie: 'dd_session=garbage.token' };
// Deterministic counter suffixes (no Date.now() — parallel-stable, no collisions).
let gw5n = 0;
const gw5id = (p) => `${p}-${++gw5n}`;

// ---------------- Fix 1a: anon credential-shaped ids → 400 ----------------
test('GW5-1a: anonymous chat as a victim 0x{64} address is 400 with a sign-in action', async () => {
  const victim = '0x' + 'a1'.repeat(32);
  const r = await post('/api/chat', { userId: victim, message: 'She takes attackermed 5mg at 9pm every night' });
  assert.equal(r.status, 400, 'anon credential-shaped userId refused, never served');
  const j = await r.json();
  assert.match(j.error, /sign in/i, 'error names the recovery (sign in)');
  assert.equal(j.loginRequired, true, 'sign-in action flag present');
});

test('GW5-1a: user- prefixed credential-shaped id is 400 anonymously too', async () => {
  const victim = '0x' + 'a2'.repeat(32);
  const r = await post('/api/chat', { userId: 'user-' + victim, message: 'She takes attacker plant at 9pm' });
  assert.equal(r.status, 400, 'prefix does not dodge the credential-shaped guard');
});

test('GW5-1a: owner chatting as the session address WITH a session still reaches the vault', async () => {
  const addr = '0x' + 'a3'.repeat(32);
  mkVault(addr, 'owner-ok');
  const r = await post('/api/chat', { userId: addr, message: 'She takes calcium at 9am' }, sessH(addr));
  assert.equal(r.status, 200, 'signed-in owners always arrive with a session — unaffected');
  assert.equal((await r.json()).identity, 'wallet-owner');
});

test('GW5-1a: anon reads of a credential-shaped id are 400 (no public serving under the victim address)', async () => {
  const victim = '0x' + 'a4'.repeat(32);
  assert.equal((await get('/api/summary?user=' + victim)).status, 400);
  assert.equal((await get('/api/export?user=' + victim)).status, 400);
  assert.equal((await get('/memory?user=' + victim)).status, 400);
  assert.equal((await get('/api/dashboard?user=' + victim)).status, 400);
});

test('GW5-1a: expired + credential-shaped still 401 (fail-closed order preserved)', async () => {
  const victim = '0x' + 'a5'.repeat(32);
  assert.equal((await post('/api/chat', { userId: victim, message: 'hello there friend' }, garbageH)).status, 401);
  assert.equal((await get('/api/summary?user=' + victim, garbageH)).status, 401);
});

// ---------------- Fix 1b: vault evidence vault-grounded ----------------
test('GW5-1b: pollution attempt leaves the victim vault dashboard unchanged', async () => {
  const victim = '0x' + 'b1'.repeat(32);
  mkVault(victim, 'victim');
  const h = sessH(victim);
  // Owner teaches one real vault fact first (owner numbers must survive).
  const taught = await post('/api/chat', { userId: victim, message: 'She takes vaultmed 5mg at 9pm every night' }, h);
  assert.equal(taught.status, 200);
  const before = await (await get('/api/dashboard', h)).json();
  assert.match(before.user, /^vault-/);
  assert.ok(before.personal.memories >= 1, 'owner vault fact visible before the attack');
  // Attacker tries the exact-address write (blocked 400) and the trunc-prefix
  // write (now 401 via the personal-chat login gate — the anon shadow-write
  // vector is closed; vault views stay vault-grounded either way).
  const trunc48 = victim.slice(0, 48);
  const blocked = await post('/api/chat', { userId: victim, message: 'She takes attackerplant 5mg at 9pm every night' });
  assert.equal(blocked.status, 400, 'exact-address plant refused');
  const shadow = await post('/api/chat', { userId: trunc48, message: 'She takes shadowplant 5mg at 9pm every night' });
  assert.equal(shadow.status, 401, 'anon shadow-namespace write closed by the login gate');
  // Attacker fires a guard in the shadow namespace (forgeable receipt attempt) — also gated.
  assert.equal((await post('/api/chat', { userId: trunc48, message: 'She is allergic to shadowdrug, causes hives' })).status, 401);
  assert.equal((await post('/api/chat', { userId: trunc48, message: 'Can she take shadowdrug for her headache?' })).status, 401);
  const after = await (await get('/api/dashboard', h)).json();
  assert.equal(after.personal.memories, before.personal.memories, 'vault memories unchanged by the plant');
  assert.equal(after.personal.guardHits, before.personal.guardHits, 'vault guardHits unchanged by the forged receipt');
  assert.equal(after.personal.turns, before.personal.turns, 'vault turns unchanged by the plant');
  assert.ok(!JSON.stringify(after).toLowerCase().includes('shadowplant'), 'plant text nowhere in the vault dashboard');
});

test('GW5-1b: a guard fired INSIDE the vault counts (namespaced receipts, fail-closed legacy)', async () => {
  const addr = '0x' + 'b2'.repeat(32);
  mkVault(addr, 'guardns');
  const h = sessH(addr);
  const before = await (await get('/api/dashboard', h)).json();
  assert.equal(before.personal.guardHits, 0, 'legacy/un-namespaced receipts stay out of the vault view');
  await post('/api/chat', { userId: addr, message: 'She is allergic to ibuprofen, causes rash' }, h);
  const trap = await post('/api/chat', { userId: addr, message: 'Can she take ibuprofen for her headache?' }, h);
  assert.match((await trap.json()).reply, /^STOP/, 'vault guard fires');
  const after = await (await get('/api/dashboard', h)).json();
  assert.ok(after.personal.guardHits >= 1, 'namespaced vault receipt counts');
});

test('GW5-1b: /api/usage attribution byte-identical (redaction + fixed rows, no leak)', async () => {
  const addr = '0x' + 'b3'.repeat(32);
  mkVault(addr, 'usage');
  const h = sessH(addr);
  const taught = await post('/api/chat', { userId: addr, message: 'She takes gw5med 5mg at 9pm every night' }, h);
  assert.equal(taught.status, 200, 'teach turn stored (the leak check below is only meaningful on a 200)');
  const j = await (await get('/api/usage')).json();
  assert.equal(j.users.length, 3, 'tracked usage rows unchanged (fixed JSON list)');
  assert.ok(!JSON.stringify(j).toLowerCase().includes('gw5med'), 'taught fact text leaks nowhere in usage JSON');
  const md = await (await get('/api/usage?format=md')).text();
  assert.ok(!/gw5med/i.test(md), 'taught fact text leaks nowhere in usage markdown');
});

// ---------------- Fix 2: B-state non-self reads serve the requested ns ----------------
const B_SURFACES = [
  '/api/summary', '/api/export', '/api/proactive', '/api/seed-status',
  '/memory', '/print', '/replay',
];
for (const surf of B_SURFACES) {
  test(`GW5-2: B-state ${surf} serves the requested ns (never 409)`, async () => {
    const addr = '0x' + 'c1'.repeat(32); // signed in, no registry row = no vault
    const h = sessH(addr);
    const u = gw5id('gw5-b');
    const r = await get(`${surf}?user=${encodeURIComponent(u)}`, h);
    assert.equal(r.status, 200, `B-state ${surf} serves per the matrix, never 409`);
  });
}

test('GW5-2: B-state reads keep fail-closed shapes (expired 401, reserved 403, chat 409 locked)', async () => {
  const addr = '0x' + 'c2'.repeat(32); // signed in, no vault
  const h = sessH(addr);
  const u = gw5id('gw5-bf');
  for (const surf of B_SURFACES) {
    assert.equal((await get(`${surf}?user=${encodeURIComponent(u)}`, garbageH)).status, 401, `expired ${surf} never leaks`);
  }
  assert.equal((await get('/api/summary?user=w-0xabc', h)).status, 403, 'B-state reserved still 403');
  const c = await post('/api/chat', { userId: u, message: 'hello there friend' }, h);
  assert.equal(c.status, 409, 'B-state personal chat still 409s (never shared fallback)');
});

// ---------------- Fix 3: expired downgrade on session-agnostic surfaces ----------------
test('GW5-3: garbage dd_session → 401 on /api/usage, /api/nudge, /compare', async () => {
  assert.equal((await get('/api/usage', garbageH)).status, 401);
  assert.equal((await post('/api/nudge', { users: [], hour: 8 }, garbageH)).status, 401);
  assert.equal((await get('/compare?a=demo-mom&b=demo-day7', garbageH)).status, 401);
});

// ---------------- Fix 4: credential-shaped guard applies with ANY session ----------------
// Hunter repro: the anon guard (`!sess && 0x{64} → 400`) was skipped entirely
// when ANY session existed, so a signed-in vaultless (B-state) viewer naming a
// victim's address was served attacker-planted shadow facts under the victim's
// label on every namespaceView read surface. The guard now applies regardless
// of session, with carve-outs: non-self credential-shaped ids → 400; the
// session's OWN address (case-insensitive) skips the 400 and follows the
// vault/409 path — owner-self WITH a vault (C-state) reads the vault as today,
// vaultless-self (B-state) 409s fail-closed on all 8 reads (wave-7 fix).
const CRED8 = [
  '/api/summary', '/api/export', '/api/proactive', '/api/seed-status',
  '/memory', '/print', '/replay', '/api/dashboard',
];

test('GW5-4: B-state viewer naming a victim address is 400 on all 8 reads (planted shadow never served)', async () => {
  const victim = '0x' + 'd1'.repeat(32);
  // The old anon trunc-prefix plant vector is closed by the login gate (401):
  // nothing writable anonymously can reach the victim's shadow namespace.
  const plant = await post('/api/chat', { userId: victim.slice(0, 48), message: 'She takes victimtrap 5mg at 9pm every night' });
  assert.equal(plant.status, 401, 'anon shadow-namespace write closed by the login gate');
  const viewer = '0x' + 'd2'.repeat(32); // signed in, no vault
  const h = sessH(viewer);
  for (const surf of CRED8) {
    const r = await get(`${surf}?user=${victim}`, h);
    assert.equal(r.status, 400, `B-state ${surf}?user=victim-address is 400, never served`);
  }
  const j = await (await get('/api/summary?user=' + victim, h)).json();
  assert.match(j.error, /sign in/i, 'error names the recovery (sign in)');
});

test('GW5-4: B-state user- prefixed / UPPERHEX victim address is 400 too', async () => {
  const viewer = '0x' + 'd2'.repeat(32); // signed in, no vault
  const h = sessH(viewer);
  const victim = '0x' + 'd6'.repeat(32);
  assert.equal((await get('/api/summary?user=user-' + victim, h)).status, 400, 'prefix does not dodge the guard with a session');
  const upperVictim = '0x' + 'D7'.repeat(32);
  assert.equal((await get('/api/summary?user=' + upperVictim, h)).status, 400, 'uppercase-hex victim is still credential-shaped');
});

test('GW5-4: owner-self (C-state) reads of the session address still reach the vault, never 400', async () => {
  const addr = '0x' + 'd3'.repeat(32);
  mkVault(addr, 'self-ok');
  const h = sessH(addr);
  const d = await get('/api/dashboard?user=' + addr, h);
  assert.equal(d.status, 200, 'owner-self dashboard follows the existing vault path');
  assert.match((await d.json()).user, /^vault-/, 'owner-self sees the vault, not a shadow');
  assert.equal((await get('/api/summary?user=' + addr, h)).status, 200, 'owner-self summary follows the existing vault path');
});

test('GW5-4: self-match is case-insensitive (uppercase-hex own address still reaches the vault)', async () => {
  const addr = '0x' + 'd5'.repeat(32);
  mkVault(addr, 'self-case');
  const h = sessH(addr);
  const r = await get('/api/summary?user=' + '0x' + 'D5'.repeat(32), h);
  assert.equal(r.status, 200, 'own address in any hex case is self, never 400');
});

test('GW5-4: B-state self (vaultless, own credential-shaped id) is 409 on all 8 reads — shadow never served', async () => {
  // Hunter repro: signed-in-no-vault reading OWN credential-shaped id was
  // guest-served from the anon-writable trunc48 shadow namespace, so a
  // third-party plant displayed as own medical memory. Fail closed like chat.
  const addr = '0x' + 'e1'.repeat(32); // signed in, no vault
  const h = sessH(addr);
  // Third-party anon plants into the trunc48 namespace are closed by the login
  // gate (401) — the shadow stays empty, so B-state self reads 409 on an empty
  // shadow, never a serve.
  const plant = await post('/api/chat', { userId: addr.slice(0, 48), message: 'She takes selfshadow 5mg at 9pm every night' });
  assert.equal(plant.status, 401, 'anon shadow-namespace write closed by the login gate');
  for (const surf of CRED8) {
    const r = await get(`${surf}?user=${addr}`, h);
    assert.equal(r.status, 409, `B-state self ${surf}?user=own-address is 409, never served`);
    const body = await r.text();
    assert.ok(!body.toLowerCase().includes('selfshadow'), `B-state self ${surf} leaks no shadow content`);
  }
  // C-state self (WITH vault) still follows the vault path — unaffected.
  const owner = '0x' + 'e2'.repeat(32);
  mkVault(owner, 'bself-owner-ok');
  const oh = sessH(owner);
  await post('/api/chat', { userId: owner, message: 'She takes ownvaultmed 5mg at 9pm every night' }, oh);
  const od = await get('/api/dashboard?user=' + owner, oh);
  assert.equal(od.status, 200, 'C-state self dashboard still reaches the vault');
  assert.match((await od.json()).user, /^vault-/);
  assert.equal((await get('/api/summary?user=' + owner, oh)).status, 200, 'C-state self summary still reaches the vault');
  // Fail-closed order preserved: anon stays 400, expired stays 401 on self reads.
  assert.equal((await get('/api/summary?user=' + addr)).status, 400, 'anon own-credential-shaped read stays 400');
  assert.equal((await get('/api/summary?user=' + addr, garbageH)).status, 401, 'expired self read stays 401');
});

test('GW5-4: 0X{64} (uppercase prefix) is accepted as non-credential-shaped — never credential-400', async () => {
  // SPEC §2 carve-out: Sui addresses use lowercase `0x`; the credential guard
  // matches lowercase-`0x` only, so `0X` + 64 hex is an ordinary id — never a
  // credential refusal (no sign-in error, no loginRequired). Length parity:
  // chat AND reads apply the normal 64-char bound (66 chars → too-long 400,
  // never a hashed-shadow serve); the carve-out is about credential shape,
  // not length.
  const upper = '0X' + 'f1'.repeat(32);
  const r = await post('/api/chat', { userId: upper, message: 'hello there friend' });
  assert.equal(r.status, 400, '0X-prefix 66-char chat fails only on the normal length bound');
  const j = await r.json();
  assert.match(j.error, /too long/i, 'length refusal, not a credential refusal');
  assert.ok(!('loginRequired' in j), 'no sign-in action flag on a non-credential refusal');
  const s = await get('/api/summary?user=' + upper);
  assert.equal(s.status, 400, '0X-prefix read hits the same length bound as chat — unified, never hashed-serve');
  const sj = await s.json();
  assert.match(sj.error, /too long/i, 'read length refusal, not a credential refusal');
  assert.ok(!('loginRequired' in sj), 'no sign-in action flag on a non-credential refusal');
  const viewer = '0x' + 'f9'.repeat(32); // B-state viewer naming a 0X id: same length bound, never credential-400
  const sv = await get('/api/summary?user=' + upper, sessH(viewer));
  assert.equal(sv.status, 400);
  assert.ok(!('loginRequired' in (await sv.json())), 'no sign-in action flag for B-state either');
});

test('GW5-2-branch: no generic B-state 409 remains — non-self reads serve on all 8 surfaces incl. dashboard', async () => {
  // Decision proof for the deleted `unlinkedAsGuest !== true` 409 branch: every
  // read surface serves a B-state non-self caller as guest (200), so no generic
  // unlinked-409 path survives. Only B-state SELF credential-shaped reads 409
  // (pinned above) and B-state chat 409s (pinned in GW5-2).
  const addr = '0x' + 'e3'.repeat(32); // signed in, no vault
  const h = sessH(addr);
  const u = gw5id('gw5-bnoself');
  for (const surf of CRED8) {
    const r = await get(`${surf}?user=${encodeURIComponent(u)}`, h);
    assert.equal(r.status, 200, `B-state non-self ${surf} serves, never 409`);
  }
});

test('GW5-3: no cookie → unchanged 200 on /api/usage, /api/nudge, /compare (redaction kept)', async () => {
  const addr = '0x' + 'e9'.repeat(32);
  mkVault(addr, 'redact');
  const h = sessH(addr);
  await post('/api/chat', { userId: addr, message: 'She takes gw5hide 5mg at 9pm every night' }, h);
  const usage = await get('/api/usage');
  assert.equal(usage.status, 200, 'anonymous usage still public (counts only)');
  const j = await usage.json();
  assert.ok(!JSON.stringify(j).toLowerCase().includes('gw5hide'), 'redaction kept for anonymous usage');
  const nudge = await post('/api/nudge', { users: [], hour: 8 });
  assert.equal(nudge.status, 200, 'anonymous nudge with no targets still answers');
  assert.deepEqual((await nudge.json()).users, []);
  const cmp = await get('/compare?a=demo-mom&b=demo-day7');
  assert.equal(cmp.status, 200, 'anonymous compare still renders');
  assert.match(await cmp.text(), /Cross-user isolation/);
});
