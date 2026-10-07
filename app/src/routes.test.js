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
process.env.DD_DAY_LIMIT_ANON = '10000';
process.env.DD_DAY_LIMIT_WALLET = '10000';
// Registry isolation: vault-scope tests must never read/write the repo's real
// wallet registry (judge-facing state). Temp file only.
process.env.DD_REGISTRY_PATH = TMP + '.registry.json';

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

test('explicit save commands persist (no noted-down lie)', async () => {
  const u = `rt-explicit-${Date.now()}`;
  const j = await chat(u, 'store that i have migraines');
  assert.ok(j.savedBlob, 'an explicit store command must be saved');
  assert.ok(!/not saved/i.test(j.reply), 'reply must not disclaim a save that happened');
});

test('signed-in vault owners still reach the public demo by name', async () => {
  // A valid session whose wallet has NO vault row: old code 409'd here
  // (vault branch hijacked the explicit demo request); the banner + signed-in
  // demo views ask for demo-mom by name and must get the shared demo.
  const { issueSession } = await import('./walletAuth.js');
  const addr = '0x' + 'cd'.repeat(32);
  const h = { Cookie: `dd_session=${issueSession(addr)}` };
  const r = await get('/api/dashboard?user=demo-mom', h);
  assert.equal(r.status, 200, 'explicit public-demo request bypasses the vault branch');
  const j = await r.json();
  assert.equal(j.demo.userId, 'demo-mom', 'serves the shared demo namespace');
  assert.equal(j.personal.budget.cap, 10, 'demo cap applies, not the wallet cap');
});

test('demo chat stays shared for signed-in vault owners (no vault hijack)', async () => {
  // Regression: a signed-in owner chatting in demo-mom read their OWN (often
  // empty) vault instead of premade memory. Demo turns always use the shared
  // channel now, and nobody writes into the shared demo.
  const { issueSession } = await import('./walletAuth.js');
  const addr = '0x' + 'ce'.repeat(32);
  const h = { Cookie: `dd_session=${issueSession(addr)}`, 'X-Device-Id': `dev-demohijack-${Date.now()}` };
  const r = await post('/api/chat', { userId: 'demo-mom', message: 'What do you remember about her?' }, h);
  assert.equal(r.status, 200, 'demo turn answers on the shared channel, never 409');
  const j = await r.json();
  assert.equal(j.identity, 'shared-anon', 'demo turns never take the wallet identity');
  assert.equal(j.memoryScope, 'user-demo-mom', 'demo turns read the shared demo namespace');
  assert.equal(j.savedBlob, null, 'demo turns never write into the shared demo');
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
  // Local stand-in has no namespace listing: must say so honestly instead of
  // reporting a cross-namespace blobCount of 0 (the old code summed every
  // namespace with the wrong count field, so meetsMinimum lied).
  assert.equal(j.censusAvailable, false, 'local mode has no census — must not fake one');
  assert.ok(!('blobCount' in j) || j.blobCount === null || typeof j.blobCount === 'number');
});

test('/api/nudge caps unauthenticated fan-out at 5 users', async () => {
  const users = Array.from({ length: 6 }, (_, i) => `rt-nudge-${Date.now()}-${i}`);
  const r = await post('/api/nudge', { users, hour: 8 });
  assert.equal(r.status, 413, 'oversized users[] must be refused');
});

test('/api/nudge normalises before the reserved check (junk prefixes cannot slip past)', async () => {
  const r = await post('/api/nudge', { users: ['!!vault-abc', '..w-0xabc'], hour: 8 });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).users, [], 'reserved namespaces resolve to no targets');
});

test('terminal error handler never echoes un-vetted 4xx text', async () => {
  const r = await post('/api/chat', { userId: 'x', message: 12345 });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'message must be 1-500 chars' });
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



test('/api/chat exposes a real reasoning trace (recall -> guards -> write)', async () => {
  const u = `rt-think-${Date.now()}`;
  const t = await chat(u, 'She is allergic to ibuprofen, causes rash');
  const labels = (t.thinking || []).map((s) => s.label);
  assert.ok(labels.includes('Recall') && labels.includes('Memory write'), 'teach turn traces recall + write');
  assert.ok((t.thinking || []).some((s) => /blob local-/.test(s.detail)), 'teach trace cites the saved blob');
  const b = await chat(u, 'Can she take ibuprofen?');
  const bl = (b.thinking || []).map((s) => s.label);
  assert.deepEqual(bl, ['Recall', 'Allergy guard', 'Interaction guard', 'Answer', 'Memory write'], 'blocked turn traces the full pipeline');
  assert.ok((b.thinking || []).some((s) => s.label === 'Allergy guard' && /MATCH/.test(s.detail)), 'guard step names the match');
});

test('/api/models lists free-only models with a safe default', async () => {
  const j = await (await get('/api/models')).json();
  assert.equal(j.freeOnly, true);
  assert.ok(Array.isArray(j.models) && j.models.length >= 10, 'usable free list even keyless');
  assert.ok(j.models.every((m) => !m.id.startsWith('openai/') && !m.id.startsWith('anthropic/')), 'beyond big two');
  assert.ok(j.models.some((m) => m.id === j.default), 'default is in the list');
});

test('/api/chat rejects non-free models, accepts listed ones', async () => {
  const bad = await post('/api/chat', { userId: 'rt-mdl', message: 'hello', model: 'openai/gpt-5' });
  assert.equal(bad.status, 400);
  const good = await post('/api/chat', { userId: `rt-mdl-${Date.now()}`, message: 'She takes Metformin 500mg at 8pm', model: 'google/gemma-4-31b-it:free' });
  assert.equal(good.status, 200);
  const j = await good.json();
  assert.ok((j.thinking || []).some((s) => s.label === 'Memory write'), 'trace intact with model override');
});

test('daily budget gate caps anonymous turns with a login prompt', async () => {
  const u = `rt-demolimit-${Date.now()}`;
  // Per-guest budget: a fresh device id isolates this test from every other
  // request in the process (all share one IP and the 'anon' fallback key).
  const devH = { 'X-Device-Id': `dev-${Date.now()}` };
  process.env.DD_DAY_LIMIT_ANON = '3';
  try {
    for (let i = 0; i < 3; i++) {
      const r = await post('/api/chat', { userId: u, message: `hello number ${i}` }, devH);
      assert.equal(r.status, 200, `turn ${i + 1} allowed`);
    }
    const r = await post('/api/chat', { userId: u, message: 'one more please' }, devH);
    assert.equal(r.status, 429, '4th anonymous turn refused');
    const j = await r.json();
    assert.equal(j.loginRequired, true, 'prompt flags login');
    assert.equal(j.demoUser, 'demo-mom', 'prompt points at the premade demo');
    assert.match(j.resetsAt, /^\d{4}-\d{2}-\d{2}$/, 'reset day is explicit');
    // A different browser (device) gets its own budget — same IP, same user.
    const other = await post('/api/chat', { userId: u, message: 'other browser' }, { 'X-Device-Id': `dev-other-${Date.now()}` });
    assert.equal(other.status, 200, 'a second device has its own guest budget');
  } finally {
    process.env.DD_DAY_LIMIT_ANON = '10000';
  }
});

test('shared demo namespaces are read-only for anonymous writers', async () => {
  const r = await post('/api/chat', { userId: 'demo-mom', message: 'She takes calcium at 9am' });
  assert.equal(r.status, 200, 'reads still answer');
  const j = await r.json();
  assert.equal(j.savedBlob, null, 'anonymous demo write refused');
  assert.ok((j.thinking || []).some((s) => s.label === 'Memory write' && /read-only/i.test(s.detail)), 'trace says read-only');
  assert.ok(typeof j.reply === 'string' && j.reply.length > 0, 'read path still answers');
});

test('demo teaches redirect to personal Chat (never silently dropped)', async () => {
  const j = await chat('demo-mom', 'i have adhd');
  assert.equal(j.savedBlob, null, 'demo never writes');
  assert.ok(/read-only/i.test(j.reply) && /personal Chat/.test(j.reply), 'reply redirects the teach, exactly once');
  assert.equal((j.reply.match(/read-only/gi) || []).length, 1, 'no double suffix (redirect XOR lie-guard)');
});

test('degraded memory: recap questions answer honestly instead of 503', async () => {
  const { resetBreaker } = await import('./memory.js');
  const u = `rt-recapdeg-${Date.now()}`;
  process.env.DD_FAULT_RECALL = 'throw';
  resetBreaker();
  try {
    const r = await post('/api/chat', { userId: u, message: 'What do you remember about her?' });
    assert.equal(r.status, 200, 'recap is not a medication question');
    const j = await r.json();
    assert.match(j.reply, /temporarily unreachable/i);
    assert.ok(!(j.thinking || []).some((s) => /no FACTS|0 recalled facts above/i.test(s.detail) && s.label === 'Answer'), 'never pretends memory is empty');
  } finally {
    delete process.env.DD_FAULT_RECALL;
    resetBreaker();
  }
});

test('demo namespaces cap at DD_DAY_LIMIT_DEMO even with high DD_DAY_LIMIT_ANON', async () => {
  process.env.DD_DAY_LIMIT_DEMO = '1';
  try {
    let got429 = null;
    for (let i = 0; i < 3; i++) {
      const r = await post('/api/chat', { userId: 'demo-mom', message: `hello number ${i}` });
      if (r.status === 429) { got429 = await r.json(); break; }
      assert.equal(r.status, 200);
    }
    assert.ok(got429, 'demo-mom must hit the demo day-cap');
    assert.equal(got429.loginRequired, true, 'prompt flags login');
    assert.equal(got429.demoUser, 'demo-mom', 'prompt points at the premade demo');
    assert.match(got429.resetsAt, /^\d{4}-\d{2}-\d{2}$/, 'reset day is explicit');
    // Normal namespaces still use the (high) ANON cap — the split is demo-only.
    const ok = await post('/api/chat', { userId: `rt-nondemo-${Date.now()}`, message: 'hello there' });
    assert.equal(ok.status, 200);
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
});

test('poisoned cached client recovers once on 401, never loops', async () => {
  const { __cachedClientForTest: cc } = await import('./server.js');
  let makes = 0;
  const flaky = () => {
    makes++;
    const n = makes;
    return { recall: async () => { if (n === 1) throw new Error('401 Unauthorized'); return { results: [{ text: 'ok', distance: 0.1 }] }; } };
  };
  const r = await cc('t-flaky', flaky).recall({ query: 'x' });
  assert.equal(r.results[0].text, 'ok', 'one fresh handshake recovers the read');
  assert.equal(makes, 2, 'exactly one recovery attempt');
  const bad = () => ({ recall: async () => { throw new Error('401 nope'); } });
  await assert.rejects(() => cc('t-bad', bad).recall({}), /401/, 'persistent 401 still surfaces');
  let plainMakes = 0;
  const plain = () => { plainMakes++; return { recall: async () => { throw new Error('boom 500'); } }; };
  await assert.rejects(() => cc('t-plain', plain).recall({}), /boom/, 'non-auth errors propagate');
  assert.equal(plainMakes, 1, 'non-auth errors never trigger a rebuild');
});

test('/api/usage markdown never leaks other-user blob texts (no shadow rows)', async () => {
  await chat('user-a', 'She takes calcium at 9am');
  const md = await (await get(`/api/usage?format=md`)).text();
  assert.ok(!/calcium/i.test(md), 'no other-user health text in markdown');
  // NOTE (G3-FIX B): `user-` prefixes strip during normalisation, so this
  // teach lands in the canonical `a` row — which the fixed JSON USERS list
  // (demo-mom/user-a/user-b) does not track. No shadow `user-a` row may be
  // fabricated for it. The explicit `[redacted]` marker mechanism is covered
  // at unit level (stats.test.js) and end-to-end on SQLite (db.test.js).
  const j = await (await get('/api/usage')).json();
  assert.equal(j.users.find((u) => u.userId === 'user-a').memories, 0, 'no shadow usage row fabricated for the prefixed id');
});

// ------------------------------------------------- G3-FIX wave ---
// Case-variant demo bypass (guard poisoning), `user-` shadow namespaces,
// guest-memory readout, B-state dashboard, empty-userId validation. Each test
// is a hunter/judge repro locked in as a route test.

test('G3-FIX A: case-variant demo ids are read-only (no guard poisoning)', async () => {
  const drug = `zarithromycin-${Date.now()}`;
  const r = await post('/api/chat', { userId: 'DEMO-MOM', message: `She is allergic to ${drug}, causes hives` });
  assert.equal(r.status, 200, 'reads still answer');
  const j = await r.json();
  assert.equal(j.savedBlob, null, 'case-variant demo write refused (read-only like demo-mom)');
  assert.ok(/read-only/i.test(j.reply) && /personal Chat/.test(j.reply), 'teach redirects, never silently writes');
  // No shadow write: the real shared demo namespace must not hold the plant.
  const s = await (await get('/api/summary?user=demo-mom')).json();
  assert.ok(!JSON.stringify(s).toLowerCase().includes(drug.toLowerCase()), 'planted allergy must not land in the shared demo namespace');
  const trap = await chat('demo-mom', `Can she take ${drug} for her infection?`);
  assert.ok(!/^STOP\b/.test(trap.reply), 'planted allergy must not fire a STOP on the real demo');
});

test('G3-FIX A: case-variant demo ids get the demo cap (chat + dashboard)', async () => {
  process.env.DD_DAY_LIMIT_DEMO = '7';
  try {
    const r = await post('/api/chat', { userId: 'Demo-Mom', message: 'hello there friend' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.budget.cap, 7, 'case-variant demo chats under the demo cap, not the anon cap');
    const d = await (await get('/api/dashboard?user=DEMO-MOM')).json();
    assert.equal(d.personal.budget.cap, 7, 'dashboard shows the demo cap for case-variant demo');
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
});

test('G3-FIX B: user- prefixed ids reach the real namespace (no writable shadow)', async () => {
  // Reserved shapes stay reserved with the prefix on.
  assert.equal((await post('/api/chat', { userId: 'user-vault-abc', message: 'She takes Metformin 500mg at 8pm' })).status, 400, 'chat user-vault-abc reserved');
  assert.equal((await post('/api/chat', { userId: 'user-tg-777', message: 'hello there friend' })).status, 400, 'chat user-tg-777 reserved');
  assert.equal((await get('/api/summary?user=' + encodeURIComponent('user-vault-abc'))).status, 403, 'summary user-vault-abc forbidden');
  assert.equal((await get('/api/summary?user=' + encodeURIComponent('user-w-0xabc'))).status, 403, 'summary user-w-0xabc forbidden');
  assert.equal((await get('/memory?user=' + encodeURIComponent('user-vault-abc'))).status, 403, 'memory user-vault-abc forbidden');
  assert.equal((await get('/print?user=' + encodeURIComponent('user-vault-abc'))).status, 403, 'print user-vault-abc forbidden');
  assert.equal((await get('/api/dashboard?user=' + encodeURIComponent('user-vault-abc'))).status, 403, 'dashboard user-vault-abc forbidden');
  // Bare and prefixed forms share one namespace: teach bare, read prefixed.
  const u = `g3fix-bare-${Date.now()}`;
  const taught = await chat(u, 'She takes g3fixmed 5mg at 9pm every night');
  assert.ok(taught.savedBlob, 'bare teach persists');
  const s = await (await get('/api/summary?user=' + encodeURIComponent('user-' + u))).json();
  assert.ok(JSON.stringify(s).toLowerCase().includes('g3fixmed'), 'user- prefixed read reaches the same namespace');
  // user-demo-mom IS demo-mom: read-only with the demo cap, never an empty shadow.
  const w = await post('/api/chat', { userId: 'user-demo-mom', message: 'She takes calcium at 9am' });
  assert.equal(w.status, 200);
  assert.equal((await w.json()).savedBlob, null, 'user-demo-mom never writes');
  const d = await (await get('/api/dashboard?user=user-demo-mom')).json();
  assert.equal(d.user, 'demo-mom', 'prefixed demo resolves to the canonical demo id');
  assert.equal(d.personal.budget.cap, 10, 'prefixed demo shows the demo cap, not the anon cap');
});

test('G3-FIX C: guest dashboard personal memories reflect the namespace facts', async () => {
  const u = `g3fix-guest-${Date.now()}`;
  const taught = await chat(u, 'She takes Metformin 500mg at 8pm every night');
  assert.ok(taught.savedBlob, 'guest teach persists');
  const d = await (await get('/api/dashboard?user=' + encodeURIComponent(u))).json();
  assert.ok((d.personal.memories || 0) >= 1, 'dashboard personal memories reflect the namespace facts for the requested user');
  // /api/usage + stats attribution unchanged by the readout union: no new
  // rows, no moved rows, and the taught fact text leaks nowhere.
  const usage = await (await get('/api/usage')).json();
  assert.equal(usage.users.length, 3, 'tracked usage rows unchanged (fixed JSON list)');
  assert.ok(!JSON.stringify(usage).toLowerCase().includes('metformin'), 'taught fact text leaks nowhere in usage JSON');
  const md = await (await get('/api/usage?format=md')).text();
  assert.ok(!/metformin/i.test(md), 'taught fact text leaks nowhere in usage markdown');
});

test('G3-FIX D: B-state dashboard serves demo readiness + vault-not-onboarded (chat still 409)', async () => {
  const { issueSession } = await import('./walletAuth.js');
  const addr = '0x' + 'b7'.repeat(32); // signed in, no registry row = no vault
  const h = { Cookie: `dd_session=${issueSession(addr)}` };
  const u = `g3fix-b-${Date.now()}`;
  const r = await get('/api/dashboard?user=' + encodeURIComponent(u), h);
  assert.equal(r.status, 200, 'B-state dashboard serves per the matrix, never 409');
  const d = await r.json();
  assert.equal(d.vault.signedIn, true, 'vault reports signed in');
  assert.equal(d.vault.onboarded, false, 'vault reports not onboarded');
  assert.ok(d.demo && typeof d.demo.ready === 'boolean' && typeof d.demo.blobCount === 'number', 'demo readiness present');
  assert.equal(d.personal.budget.cap, Number(process.env.DD_DAY_LIMIT_ANON), 'personal budget under the anon cap');
  const c = await post('/api/chat', { userId: u, message: 'hello there friend' }, h);
  assert.equal(c.status, 409, 'B-state personal chat still 409s (never shared fallback)');
});

test('G3-FIX E: empty userId is 400 validation (missing still defaults)', async () => {
  assert.equal((await post('/api/chat', { userId: '', message: 'hello there friend' })).status, 400, 'empty userId rejected');
  assert.equal((await post('/api/chat', { userId: '   ', message: 'hello there friend' })).status, 400, 'whitespace userId rejected');
  const missing = await post('/api/chat', { message: 'hello there friend' });
  assert.equal(missing.status, 200, 'missing userId still defaults (existing contract)');
});

// ------------------------------------------------- SPEC §4 matrix ---
// Vault-scope cells: a real session + a temp-registry vault row (local-mode
// stand-in, so scope/budget/identity assertions hold without chain reads).

test('SPEC §3.3: vault owner chatting as the session address gets the vault (never demo scope)', async () => {
  const { issueSession } = await import('./walletAuth.js');
  const { upsertUser } = await import('./userRegistry.js');
  const addr = '0x' + 'f1'.repeat(32);
  upsertUser({ address: addr, accountId: 'obj-MATRIX-1', delegatePrivateKey: '11'.repeat(32), delegatePublicKey: '22'.repeat(64), delegateAddress: '0x' + '33'.repeat(32), pendingPhase: null, pendingTxBytes: null });
  const h = { Cookie: `dd_session=${issueSession(addr)}` };
  // The full 66-char Sui address must be accepted as userId (the client sends
  // the session address for untouched-default personal chat).
  const r = await post('/api/chat', { userId: addr, message: 'She takes calcium at 9am' }, h);
  assert.equal(r.status, 200, 'a session-address userId must not be rejected as too long');
  const j = await r.json();
  assert.equal(j.identity, 'wallet-owner', 'vault identity, not shared-anon');
  assert.match(j.memoryScope, /^user-vault-/, 'vault namespace, never the demo namespace');
  assert.equal(j.budget.cap, Number(process.env.DD_DAY_LIMIT_WALLET), 'wallet budget, not demo/guest budget');
  assert.ok(j.savedBlob, 'personal vault teaches persist');
  assert.ok(!/sign in/i.test(j.reply), 'no sign-in nag while signed in');
});

test('SPEC §4/B: signed-in without a vault gets 409 on personal chat (never shared fallback)', async () => {
  const { issueSession } = await import('./walletAuth.js');
  const addr = '0x' + 'f2'.repeat(32); // no registry row
  const h = { Cookie: `dd_session=${issueSession(addr)}` };
  const r = await post('/api/chat', { userId: addr, message: 'hello there friend' }, h);
  assert.equal(r.status, 409, 'unlinked vault fails loud, never silently shared');
  const j = await r.json();
  assert.ok(!('memoryScope' in j) || !String(j.memoryScope || '').startsWith('user-demo-'), 'no demo scope leaked');
});

test('SPEC §4/C: vault dashboard shows vault numbers + wallet budget; explicit demo stays demo', async () => {
  const { issueSession } = await import('./walletAuth.js');
  const { upsertUser } = await import('./userRegistry.js');
  const addr = '0x' + 'f3'.repeat(32);
  upsertUser({ address: addr, accountId: 'obj-MATRIX-3', delegatePrivateKey: '44'.repeat(32), delegatePublicKey: '55'.repeat(64), delegateAddress: '0x' + '66'.repeat(32), pendingPhase: null, pendingTxBytes: null });
  const h = { Cookie: `dd_session=${issueSession(addr)}` };
  const v = await (await get('/api/dashboard', h)).json();
  assert.match(v.user, /^vault-/, 'default dashboard is the vault, not demo-mom');
  assert.equal(v.personal.budget.cap, Number(process.env.DD_DAY_LIMIT_WALLET), 'vault wallet budget');
  assert.equal(v.vault.signedIn, true);
  assert.equal(v.vault.onboarded, true);
  const d = await (await get('/api/dashboard?user=demo-mom', h)).json();
  assert.equal(d.user, 'demo-mom', 'explicit demo request bypasses the vault');
  assert.equal(d.personal.budget.cap, 10, 'banner/demo source is the demo cap, never the wallet cap');
});

test('SPEC §4/C+D: vault memory/replay/print default to vault, honor explicit demo, 401 when expired', async () => {
  const { issueSession } = await import('./walletAuth.js');
  const { upsertUser } = await import('./userRegistry.js');
  const addr = '0x' + 'f4'.repeat(32);
  upsertUser({ address: addr, accountId: 'obj-MATRIX-4', delegatePrivateKey: '77'.repeat(32), delegatePublicKey: '88'.repeat(64), delegateAddress: '0x' + '99'.repeat(32), pendingPhase: null, pendingTxBytes: null });
  const h = { Cookie: `dd_session=${issueSession(addr)}` };
  const x = { Cookie: 'dd_session=garbage.token' };
  assert.match((await (await get('/api/summary', h)).json()).user, /^vault-/, 'summary defaults to vault');
  assert.equal((await (await get('/api/summary?user=demo-mom', h)).json()).user, 'demo-mom', 'explicit demo honored');
  assert.equal((await get('/replay', h)).status, 200, 'replay defaults to vault');
  assert.equal((await get('/replay?user=demo-mom', h)).status, 200, 'explicit demo replay served');
  assert.equal((await get('/print', h)).status, 200, 'print defaults to vault');
  assert.equal((await get('/print?user=demo-mom', h)).status, 200, 'explicit demo print served');
  assert.equal((await get('/api/dashboard', x)).status, 401, 'expired dashboard never leaks');
  assert.equal((await get('/api/summary', x)).status, 401, 'expired summary never leaks');
  assert.equal((await get('/replay', x)).status, 401, 'expired replay never leaks');
  assert.equal((await get('/print', x)).status, 401, 'expired print never leaks');
});

// ------------------------------------------------- G3-FIX2 ---
// Nested `user-` fixpoint: normalisation resolves nested `user-` to the
// canonical id BEFORE any scope decision, so every depth maps to the same
// demo read-only + demo cap (chat + stream + dashboard) and every depth of a
// reserved shape stays reserved on all 5 read surfaces + chat/stream.

test('G3-FIX2: nested user- demo ids resolve to the canonical demo (read-only, demo cap, depths 1-4)', async () => {
  // Cap 100 (not the default 10): the shared demo budget accumulates across
  // every demo test in this file, so a small cap would 429 on prior spend.
  // 100 stays distinct from the anon cap (10000) — routing proof either way.
  process.env.DD_DAY_LIMIT_DEMO = '100';
  try {
    const ids = [
      'user-demo-mom',
      'user-user-demo-mom',
      'user-user-user-demo-mom',
      'user-user-user-user-demo-mom',
      'USER-USER-DEMO-MOM',
      'User-User-User-Demo-Mom',
      'uSeR-UsEr-uSeR-uSeR-dEmO-mOm',
      'user-user-demo-day7',
      'USER-USER-DEMO-DAY1',
    ];
    for (const id of ids) {
      const r = await post('/api/chat', { userId: id, message: 'She takes calcium at 9am' });
      assert.equal(r.status, 200, `chat ${id} answers`);
      const j = await r.json();
      assert.equal(j.savedBlob, null, `chat ${id} never writes (read-only)`);
      assert.ok(/read-only/i.test(j.reply), `chat ${id} redirects instead of vanishing`);
      assert.equal(j.budget.cap, 100, `chat ${id} under the demo cap, not the anon cap`);
      assert.match(j.memoryScope, /^user-demo-/, `chat ${id} reads the canonical shared demo namespace`);
      const d = await (await get('/api/dashboard?user=' + encodeURIComponent(id))).json();
      assert.equal(d.personal.budget.cap, 100, `dashboard ${id} shows the demo cap`);
    }
    const d2 = await (await get('/api/dashboard?user=user-user-demo-mom')).json();
    assert.equal(d2.user, 'demo-mom', 'nested demo resolves to the canonical demo id');
    const d3 = await (await get('/api/dashboard?user=user-user-user-user-demo-mom')).json();
    assert.equal(d3.user, 'demo-mom', 'depth-4 nested demo resolves to the canonical demo id');
    const d4 = await (await get('/api/dashboard?user=USER-USER-DEMO-DAY1')).json();
    assert.equal(String(d4.user).toLowerCase(), 'demo-day1', 'case-variant nested demo-day1 resolves canonically (label case aside, scope/cap/budget are canonical)');
    // No writable shadow: the nested plant must not land anywhere readable.
    const drug = `g3fix2shadow-${Date.now()}`;
    await post('/api/chat', { userId: 'user-user-demo-mom', message: `She is allergic to ${drug}, causes hives` });
    const s = await (await get('/api/summary?user=demo-mom')).json();
    assert.ok(!JSON.stringify(s).toLowerCase().includes(drug.toLowerCase()), 'nested teach must not plant a fact in the shared demo');
    const trap = await chat('demo-mom', `Can she take ${drug} for her infection?`);
    assert.ok(!/^STOP\b/.test(trap.reply), 'nested plant must not fire a STOP on the real demo');
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
});

test('G3-FIX2: triple-nested reserved ids stay reserved on all 5 read surfaces + chat', async () => {
  const ids = [
    'user-user-user-vault-abc',
    'User-User-User-Vault-Abc',
    'USER-USER-USER-VAULT-ABC',
    'user-user-user-w-0xabc',
    'USER-user-USER-tg-777',
    'user-user-user-user-vault-abc',
    'user-user-user-user-tg-777',
  ];
  const surfaces = [
    '/api/summary?user=',
    '/memory?user=',
    '/print?user=',
    '/replay?user=',
    '/api/dashboard?user=',
  ];
  for (const id of ids) {
    const r = await post('/api/chat', { userId: id, message: 'She takes Metformin 500mg at 8pm' });
    assert.equal(r.status, 400, `chat ${id} reserved`);
    for (const surf of surfaces) {
      const g = await get(surf + encodeURIComponent(id));
      assert.equal(g.status, 403, `${surf.split('?')[0]} ${id} forbidden`);
    }
  }
});

test('G3-FIX2 guard: legit ids, bare user-, determinism, no split-brain', async () => {
  // user-x ≡ x on the write AND read paths (one shared normaliser).
  const u = `g3fix2-legit-${Date.now()}`;
  const taught = await chat(u, 'She takes g3fix2med 5mg at 9pm every night');
  assert.ok(taught.savedBlob, 'bare teach persists');
  const pre = await chat('user-' + u, 'hello there friend');
  assert.equal(pre.memoryScope, taught.memoryScope, 'user- prefixed chat shares the bare scope');
  const deep = await chat('user-user-' + u, 'hello there friend');
  assert.equal(deep.memoryScope, taught.memoryScope, 'doubly-prefixed chat shares the bare scope (fixpoint determinism)');
  const s = await (await get('/api/summary?user=' + encodeURIComponent('user-user-' + u))).json();
  assert.ok(JSON.stringify(s).toLowerCase().includes('g3fix2med'), 'doubly-prefixed read reaches the same namespace (no split-brain)');
  // Teach nested, read bare: same row both directions.
  const v = `g3fix2-rev-${Date.now()}`;
  const t2 = await chat('user-user-' + v, 'She takes g3fix2revmed 5mg at 9pm every night');
  assert.ok(t2.savedBlob, 'nested teach persists');
  const s2 = await (await get('/api/summary?user=' + encodeURIComponent(v))).json();
  assert.ok(JSON.stringify(s2).toLowerCase().includes('g3fix2revmed'), 'bare read reaches the nested-taught row (no split-brain)');
  // Bare user- is 400 validation, never a silent default.
  assert.equal((await post('/api/chat', { userId: 'user-', message: 'hello there friend' })).status, 400, 'bare user- rejected');
  assert.equal((await post('/api/chat', { userId: 'USER-', message: 'hello there friend' })).status, 400, 'case-variant bare user- rejected');
  assert.equal((await post('/api/chat', { userId: 'user-user-', message: 'hello there friend' })).status, 400, 'nested bare user- rejected');
});

// ------------------------------------------------- G3-WAVE3 ---
// Namespace-collapsing demo writes: junk around `demo-mom` (`!`, `.`, `/`,
// space, U+0085, `user- `) is stripped by namespaceFor, so the fact lands in
// the REAL shared demo — but demoIdOf tested the raw string and missed it,
// leaving the write allowed under the guest budget (guard-poisoning
// primitive). Scope must derive from the canonical namespace, never raw.

test('G3-WAVE3: junk-prefixed demo ids are read-only with the demo cap (chat + dashboard)', async () => {
  process.env.DD_DAY_LIMIT_DEMO = '101';
  try {
    const ids = [
      'demo-mom.',
      '!demo-mom',
      'd!emo-mom',
      'user- demo-mom',
      'demo-mom ',
      'user-!demo-mom',
      '.demo-mom',
      '/demo-mom',
      ' demo-mom',
    ];
    for (const id of ids) {
      const r = await post('/api/chat', { userId: id, message: 'She takes calcium at 9am' });
      assert.equal(r.status, 200, `chat ${JSON.stringify(id)} answers`);
      const j = await r.json();
      assert.equal(j.savedBlob, null, `chat ${JSON.stringify(id)} never writes (read-only)`);
      assert.ok(/read-only/i.test(j.reply), `chat ${JSON.stringify(id)} redirects instead of vanishing`);
      assert.equal(j.budget.cap, 101, `chat ${JSON.stringify(id)} under the demo cap, not the anon cap`);
      assert.equal(j.memoryScope, 'user-demo-mom', `chat ${JSON.stringify(id)} reads the canonical shared demo namespace`);
      const d = await (await get('/api/dashboard?user=' + encodeURIComponent(id))).json();
      assert.equal(d.personal.budget.cap, 101, `dashboard ${JSON.stringify(id)} shows the demo cap`);
    }
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
});

test('G3-WAVE3: junk-prefix plant cannot poison the shared demo guard', async () => {
  // High cap: the shared demo budget accumulates across every demo test in
  // this file, so the default cap would 429 (masking the refusal under test).
  process.env.DD_DAY_LIMIT_DEMO = '1000';
  try {
  const drug = `w3poison-${Date.now()}`;
  const r = await post('/api/chat', { userId: '!demo-mom', message: `She is allergic to ${drug}, causes hives` });
  assert.equal(r.status, 200, 'plant attempt answers');
  assert.equal((await r.json()).savedBlob, null, 'junk-prefix demo write refused');
  const s = await (await get('/api/summary?user=demo-mom')).json();
  assert.ok(!JSON.stringify(s).toLowerCase().includes(drug.toLowerCase()), 'planted allergy must not land in the shared demo namespace');
  const trap = await chat('demo-mom', `Can she take ${drug} for her infection?`);
  assert.ok(!/^STOP\b/.test(trap.reply), 'planted allergy must not fire a STOP on the real demo');
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
});

test('G3-WAVE3 length gate: deep nesting resolves to demo, session flow reaches vault, huge id 400s fast', async () => {
  process.env.DD_DAY_LIMIT_DEMO = '102';
  try {
    const deep = 'user-'.repeat(12) + 'demo-mom';
    const r = await post('/api/chat', { userId: deep, message: 'She takes calcium at 9am' });
    assert.equal(r.status, 200, 'depth-12 nesting answers instead of 400');
    const j = await r.json();
    assert.equal(j.savedBlob, null, 'depth-12 nesting never writes (read-only)');
    assert.equal(j.budget.cap, 102, 'depth-12 nesting under the demo cap');
    assert.equal(j.memoryScope, 'user-demo-mom', 'depth-12 nesting reads the canonical shared demo');
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
  // 71-char `user-` + session-address flow must reach vault logic, never a
  // length 400: signed-in + onboarded owner chats as the vault.
  const { issueSession } = await import('./walletAuth.js');
  const { upsertUser } = await import('./userRegistry.js');
  const addr = '0x' + 'e7'.repeat(32);
  upsertUser({ address: addr, accountId: 'obj-W3-1', delegatePrivateKey: 'aa'.repeat(32), delegatePublicKey: 'bb'.repeat(64), delegateAddress: '0x' + 'cc'.repeat(32), pendingPhase: null, pendingTxBytes: null });
  const h = { Cookie: `dd_session=${issueSession(addr)}` };
  const prefixed = 'user-' + addr;
  assert.equal(prefixed.length, 71, 'prefixed session flow is 71 chars');
  const v = await post('/api/chat', { userId: prefixed, message: 'She takes calcium at 9am' }, h);
  assert.equal(v.status, 200, 'prefixed session address reaches vault logic, never a length 400');
  assert.equal((await v.json()).identity, 'wallet-owner', 'vault identity for the prefixed session flow');
  // 10KB id rejects (status-only: wall-clock timing asserts are flaky by design).
  const big = 'x'.repeat(10 * 1024);
  const b = await post('/api/chat', { userId: big, message: 'hello there friend' });
  assert.equal(b.status, 400, '10KB id rejected');
});
