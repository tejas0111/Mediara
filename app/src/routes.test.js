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
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 'routes-test-secret';
process.env.OPENROUTER_API_KEY = ''; // force the keyless path; guard must still block

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

test('guard runs before the LLM: trap is a STOP with a cited blob and no LLM marker', async () => {
  const u = `rt-guard-${Date.now()}`;
  await chat(u, 'She is allergic to ibuprofen, causes rash');
  const j = await chat(u, 'Can she take ibuprofen for her headache?');
  assert.match(j.reply, /^STOP\b/, 'reply should be a STOP');
  assert.ok(j.recalledMeta.some((m) => m.blob_id), 'STOP should cite a blob id');
  assert.ok(!j.reply.includes('[no LLM key]') && !j.reply.includes('system would inject'), 'LLM must not have run');
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
  assert.ok(s.medications.some((m) => /Metformin/i.test(m)));
  assert.deepEqual(s.allergies, [], 'a stopped med must not be classified as an allergy');
  assert.ok((s.stopped || []).some((m) => /stopped taking/i.test(m)));
});

test('write dedup: teaching the same fact twice reuses the blob', async () => {
  const u = `rt-dedup-${Date.now()}`;
  const a = await chat(u, 'Mom takes Amlodipine 5mg at 8am');
  const b = await chat(u, 'Mom takes Amlodipine 5mg at 8am');
  assert.equal(a.savedBlob, b.savedBlob);
});

test('rate limiting: repeated chat requests eventually 429', async () => {
  const u = `rt-rl-${Date.now()}`;
  let got429 = false;
  for (let i = 0; i < 40; i++) {
    const r = await post('/api/chat', { userId: u, message: `i take med${i} at 8pm` });
    if (r.status === 429) { got429 = true; assert.ok(r.headers.get('retry-after')); break; }
  }
  assert.ok(got429, 'expected a 429 within 40 requests');
});
