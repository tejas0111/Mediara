// Route-level tests: boot the real Express app and drive it over HTTP so the
// HEADLINE claims are test-enforced, not just asserted in prose:
//   - the guard runs BEFORE the LLM (no LLM marker on a blocked reply)
//   - a blocked message is never written to memory
//   - fail-loud identity (expired cookie -> 401 on writes AND reads)
//   - rate limiting, JSON error contract, HTML escaping, classification
// Run: node --test src/routes.test.js   (part of `npm test`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Configure BEFORE importing the app (dotenv does not override existing vars).
const TMP = path.join(os.tmpdir(), `dd-routes-${process.pid}-${Date.now()}.json`);
process.env.DD_LOCAL_STORE = TMP;
// Ledger isolation: route tests must never append to the repo's real usage /
// guard-proof ledgers (they are judge-facing evidence).
process.env.DD_USAGE_LEDGER = TMP + '.usage.json';
process.env.DD_GUARD_PROOF = TMP + '.gp.json';
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 'routes-test-secret';
process.env.OPENROUTER_API_KEY = ''; // force the keyless path; guard must still block
// Raise limits so the many route tests don't trip the limiter (it is unit-tested).
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_NONCE_LIMIT = '10000';
process.env.DD_AUTH_LIMIT = '10000';

const { default: app } = await import('./server.js');

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch {} try { fs.unlinkSync(TMP); } catch {} });

const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (p, headers) => fetch(base + p, { headers: headers || {} });
const chat = async (userId, message, headers) => (await post('/api/chat', { userId, message }, headers)).json();

test('reserved namespaces are blocked even with junk prefixes (normalised check)', async () => {
  for (const u of ['!!vault-abc', '..w-0xabc', ' tg-777001', 'VAULT-abc']) {
    assert.equal((await get('/api/summary?user=' + encodeURIComponent(u))).status, 403, `summary ${u}`);
    assert.equal((await get('/memory?user=' + encodeURIComponent(u))).status, 403, `memory ${u}`);
  }
  const w = await post('/api/chat', { userId: '!!vault-abc', message: 'my mom takes Metformin 500mg at 8pm' });
  assert.equal(w.status, 400);
});

test('logout revokes the session server-side (not just the cookie)', async () => {
  const { issueSession } = await import('./walletAuth.js');
  const token = issueSession('0x' + 'ab'.repeat(32));
  const h = { Cookie: `dd_session=${token}` };
  assert.equal((await (await get('/api/wallet/status', h)).json()).signedIn, true);
  await post('/api/auth/logout', {}, h);
  assert.equal((await (await get('/api/wallet/status', h)).json()).signedIn, false, 'token must be rejected after logout');
});

test('local-mode onboarding fails loud (501), not a 409->404 loop', async () => {
  const { issueSession } = await import('./walletAuth.js');
  const token = issueSession('0x' + 'cd'.repeat(32));
  const r = await post('/api/wallet/onboard/create', {}, { Cookie: `dd_session=${token}` });
  assert.equal(r.status, 501);
  assert.match((await r.json()).error, /mainnet/i, 'the actionable 501 message must reach the client');
});

test('a garbage session cookie reports staleSession (not a fake signed-out)', async () => {
  const j = await (await get('/api/wallet/status', { Cookie: 'dd_session=garbage.token' })).json();
  assert.equal(j.signedIn, false);
  assert.equal(j.staleSession, true);
});

test('guard runs before the LLM: trap is a STOP with a cited blob and no LLM marker', async () => {
  const u = `rt-guard-${Date.now()}`;
  await chat(u, 'She is allergic to ibuprofen, causes rash');
  const j = await chat(u, 'Can she take ibuprofen for her headache?');
  assert.match(j.reply, /^STOP\b/, 'reply should be a STOP');
  assert.ok(j.recalledMeta.some((m) => m.blob_id), 'STOP should cite a blob id');
  assert.ok(!j.reply.includes('[no LLM key]') && !j.reply.includes('system would inject'), 'LLM must not have run');
});

test('poisoning the top-5 cannot disable the guard (uncapped guard recall)', async () => {
  const u = `rt-poison-${Date.now()}`;
  await chat(u, 'She is allergic to ibuprofen, causes a rash');
  // 6 allergy-signal-but-no-drug writes try to crowd out the real allergy.
  for (let i = 0; i < 6; i++) await chat(u, `no rash and no hives, doctor approved, note ${i}`);
  const trap = await chat(u, 'Can she take ibuprofen for her headache?');
  assert.ok(/^STOP/.test(trap.reply), 'the real allergy must still fire after poisoning attempts');
});

test('blocked message is NOT written to memory (write-skip-on-guard)', async () => {
  const u = `rt-skip-${Date.now()}`;
  await chat(u, 'She is allergic to ibuprofen, causes rash');
  const j = await chat(u, 'give her ibuprofen even though she is allergic');
  assert.match(j.reply, /^STOP\b/);
  assert.equal(j.savedBlob, null, 'a blocked order must not be saved');
});

test('teaching an allergy is not a STOP and IS saved', async () => {
  const u = `rt-teach-${Date.now()}`;
  const j = await chat(u, 'She is allergic to ibuprofen, causes rash');
  assert.ok(!j.reply.startsWith('STOP'));
  assert.ok(j.savedBlob, 'a taught allergy should be saved');
});

test('fail-loud identity: expired/garbage cookie -> 401 on chat AND reads', async () => {
  const h = { Cookie: 'dd_session=garbage.token' };
  assert.equal((await post('/api/chat', { userId: 'x', message: 'hello there' }, h)).status, 401);
  assert.equal((await get('/api/summary?user=demo-mom', h)).status, 401);
  assert.equal((await get('/memory?user=demo-mom', h)).status, 401);
  assert.equal((await get('/print?user=demo-mom', h)).status, 401);
});

test('anonymous reads still work without a cookie', async () => {
  assert.equal((await get('/api/summary?user=demo-mom')).status, 200);
  assert.equal((await get('/memory?user=demo-mom')).status, 200);
});

test('malformed JSON -> 400 JSON; oversize -> 413 JSON (no stack leakage)', async () => {
  const bad = await post('/api/chat', '{not json');
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type') || '', /application\/json/);
  const badBody = await bad.text();
  assert.ok(!/at\s+\/|node_modules|SyntaxError/.test(badBody), 'no stack/path leakage');

  const big = await post('/api/chat', JSON.stringify({ userId: 'x', message: 'y'.repeat(20000) }));
  assert.equal(big.status, 413);
  assert.match(await big.text(), /too large/);
});

test('input validation: non-string userId and oversize message', async () => {
  assert.equal((await post('/api/chat', { userId: 123, message: 'hi there' })).status, 400);
  assert.equal((await post('/api/chat', { userId: 'x', message: 'z'.repeat(501) })).status, 400);
});

test('HTML escaping end-to-end: a taught <script> is escaped on /memory', async () => {
  const u = `rt-esc-${Date.now()}`;
  await chat(u, '<script>alert(1)</script> takes Metformin 500mg at 8pm');
  const html = await (await get(`/memory?user=${u}`)).text();
  assert.ok(!html.includes('<script>alert(1)'), 'raw script must not appear');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped script expected');
});

test('CSP is script-src self and x-powered-by is absent', async () => {
  const res = await get('/');
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.equal(res.headers.get('x-powered-by'), null);
  const html = await res.text();
  assert.ok(!/<script>/.test(html), 'no inline script tags');
});

test('summary classification excludes negated allergies', async () => {
  const u = `rt-cls-${Date.now()}`;
  await chat(u, 'She has no known allergies');
  await chat(u, 'My mom takes Metformin 500mg at 8pm');
  const s = await (await get(`/api/summary?user=${u}`)).json();
  assert.deepEqual(s.allergies, [], 'negated allergy must not be classified as an allergy');
  assert.ok(s.medications.length >= 1, 'the medication should be classified');
});

test('non-demo fact appears on all whole-namespace reads', async () => {
  const u = `rt-nondemo-${Date.now()}`;
  await chat(u, 'She takes levothyroxine 50mcg at 7am');
  const s = await (await get(`/api/summary?user=${u}`)).json();
  assert.ok(s.medications.some((m) => /levothyroxine/i.test(m)), 'mcg drug should be classified as a medication');
  assert.ok((await (await get(`/memory?user=${u}`)).text()).includes('levothyroxine'));
  assert.ok((await (await get(`/print?user=${u}`)).text()).includes('levothyroxine'));
  assert.ok((await (await get(`/replay?user=${u}`)).text()).includes('levothyroxine'));
});

test('discontinued medication is neither a current med nor an allergy', async () => {
  const u = `rt-stop-${Date.now()}`;
  await chat(u, 'she takes Metformin 500mg every morning');
  await chat(u, 'she stopped taking Metformin');
  const s = await (await get(`/api/summary?user=${u}`)).json();
  assert.ok(!s.medications.some((m) => /Metformin/i.test(m)), 'superseded med must not be current');
  assert.deepEqual(s.allergies, [], 'a stopped med must not be classified as an allergy');
  assert.ok((s.stopped || []).some((m) => /Metformin/i.test(m)), 'superseded med should be in stopped');
});

test('write dedup: teaching the same fact twice reuses the blob', async () => {
  const u = `rt-dedup-${Date.now()}`;
  const a = await chat(u, 'Mom takes Amlodipine 5mg at 8am');
  const b = await chat(u, 'Mom takes Amlodipine 5mg at 8am');
  assert.equal(a.savedBlob, b.savedBlob);
});

test('wallet vault namespaces are not readable anonymously', async () => {
  const addr = '0x' + 'ab'.repeat(32);
  assert.equal((await get(`/api/summary?user=w-${addr}`)).status, 403);
  assert.equal((await get(`/memory?user=w-${addr}`)).status, 403);
  assert.equal((await get(`/print?user=w-${addr}`)).status, 403);
  assert.equal((await get(`/replay?user=w-${addr}`)).status, 403);
});

test('anonymous chat cannot write to a reserved vault namespace', async () => {
  const r = await post('/api/chat', { userId: 'w-0xabc', message: 'my mom takes Metformin 500mg at 8pm' });
  assert.equal(r.status, 400);
});

test('/print shows discontinued medications', async () => {
  const u = `rt-stop2-${Date.now()}`;
  await chat(u, 'she takes Metformin 500mg every morning');
  await chat(u, 'she stopped taking Metformin');
  const html = await (await get(`/print?user=${u}`)).text();
  assert.match(html, /Stopped \/ discontinued/);
});

test('unknown route keeps the strict CSP', async () => {
  const res = await get('/nope');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
});

test('near-but-different facts are not deduped', async () => {
  const u = `rt-dedup2-${Date.now()}`;
  const a = await chat(u, 'Mom takes Metformin 500mg at 8pm');
  const b = await chat(u, 'Mom takes Metformin 500mg at 9pm');
  assert.notEqual(a.savedBlob, b.savedBlob);
});

test('cross-origin POST is blocked; same-origin is allowed', async () => {
  const cross = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ userId: 'x', message: 'hello there' }) });
  assert.equal(cross.status, 403);
  const same = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ userId: 'x', message: 'hello there' }) });
  assert.notEqual(same.status, 403);
});

test('healthz returns 200 (regression: was shadowed by the 404 handler)', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('a naturally-phrased allergy reaches the emergency card and all reads', async () => {
  const u = `rt-hives-${Date.now()}`;
  await chat(u, 'She gets hives from penicillin');
  const s = await (await get(`/api/summary?user=${u}`)).json();
  assert.ok(s.allergies.some((m) => /penicillin/i.test(m)), 'hives allergy should be classified');
  assert.ok((await (await get(`/print?user=${u}`)).text()).includes('penicillin'));
  assert.ok((await (await get(`/memory?user=${u}`)).text()).includes('penicillin'));
  assert.ok((await (await get(`/replay?user=${u}`)).text()).includes('penicillin'));
});

test('discontinuation supersedes: no false interaction STOP, med leaves Current', async () => {
  const u = `rt-sup-${Date.now()}`;
  await chat(u, 'She takes warfarin 5mg daily for AFib');
  await chat(u, 'she stopped taking warfarin last month');
  const trap = await chat(u, 'Can she take ibuprofen for her knee?');
  assert.ok(!/^STOP/.test(trap.reply), 'stopped warfarin must not fire an interaction STOP');
  const s = await (await get(`/api/summary?user=${u}`)).json();
  assert.ok(!s.medications.some((m) => /warfarin/i.test(m)), 'warfarin should not be a current med');
});

test('keyless teach never denies the fact it just stored', async () => {
  const u = `rt-noted-${Date.now()}`;
  const j = await chat(u, 'She uses her inhaler twice a day');
  assert.ok(j.savedBlob, 'fact should be saved');
  assert.ok(!/I don't have any memories/i.test(j.reply), 'reply must not deny stored memory');
});

test('memory=off skips recall and guards (one-toggle amnesia)', async () => {
  const u = `rt-memoff-${Date.now()}`;
  await chat(u, 'She is allergic to ibuprofen, causes rash');
  const off = await (await post('/api/chat', { userId: u, message: 'Can she take ibuprofen?', memory: 'off' })).json();
  assert.equal(off.memoryOff, true);
  assert.deepEqual(off.recalled, [], 'memory off recalls nothing');
  assert.ok(!/^STOP/.test(off.reply), 'memory off must not fire the guard');
  const on = await chat(u, 'Can she take ibuprofen?');
  assert.ok(/^STOP/.test(on.reply), 'memory on must fire the guard');
});

test('/compare proves cross-namespace isolation', async () => {
  const r = await get('/compare?a=demo-mom&b=demo-day7');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Cross-user isolation/);
  assert.equal((await get('/compare?a=vault-abc&b=demo-day7')).status, 403);
});

test('/api/export returns facts + blob ids', async () => {
  const u = `rt-export-${Date.now()}`;
  await chat(u, 'She takes Metformin 500mg at 8pm');
  const j = await (await get(`/api/export?user=${u}`)).json();
  assert.ok(Array.isArray(j.facts));
  assert.ok(j.blobCount >= 1);
});

test('/api/seed-status reports a real census field', async () => {
  const j = await (await get('/api/seed-status?user=demo-mom')).json();
  assert.equal(typeof j.recalledCount, 'number');
  assert.ok('censusAvailable' in j && 'meetsMinimum' in j);
});

test('degraded memory: emergency card fails closed and drug questions 503', async () => {
  const { resetBreaker } = await import('./memory.js');
  const u = `rt-degraded-${Date.now()}`;
  // Seed a real allergy while memory is healthy.
  await chat(u, 'She is allergic to ibuprofen, causes rash');
  process.env.DD_FAULT_RECALL = 'throw';
  resetBreaker();
  try {
    const chat503 = await post('/api/chat', { userId: u, message: 'Can I give her ibuprofen 400mg?' });
    assert.equal(chat503.status, 503, 'a drug question must fail closed when memory is down');
    const s = await (await get(`/api/summary?user=${u}`)).json();
    assert.equal(s.stale, true);
    assert.equal(s.allergiesKnown, false);
    const printHtml = await (await get(`/print?user=${u}`)).text();
    assert.ok(!/None recorded/.test(printHtml), 'the emergency card must not claim "None recorded" while stale');
    assert.match(printHtml, /UNKNOWN/);
    const smalltalk = await post('/api/chat', { userId: u, message: 'hello there' });
    assert.notEqual(smalltalk.status, 503, 'smalltalk should still answer when degraded');
  } finally {
    delete process.env.DD_FAULT_RECALL;
    resetBreaker();
  }
});


