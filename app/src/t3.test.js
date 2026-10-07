// T3 lose-list P0s (red-green, no network):
//   1. LLM 402-dead: max_tokens bound + free-first chain order (unit, no network)
//   2. Landing pills from the same live source as the dashboard + "—" unknown
//   3. 60s namespace-keyed census cache, mainnet-only (local/test never cached)
//   4. DD_READ/DD_CHAT env overrides apply per-request; read/chat limiters device-keyed
// Run: node --test src/t3.test.js   (part of `npm test`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Configure BEFORE importing the app (dotenv does not override existing vars).
const TMP = path.join(os.tmpdir(), `dd-t3-${process.pid}-${Date.now()}.json`);
process.env.DD_LOCAL_STORE = TMP;
process.env.DD_USAGE_LEDGER = TMP + '.usage.json';
process.env.DD_GUARD_PROOF = TMP + '.gp.json';
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 't3-test-secret';
process.env.OPENROUTER_API_KEY = ''; // keyless path; no network anywhere below
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_NONCE_LIMIT = '10000';
process.env.DD_AUTH_LIMIT = '10000';
process.env.DD_DAY_LIMIT_ANON = '10000';
process.env.DD_DAY_LIMIT_WALLET = '10000';
process.env.DD_REGISTRY_PATH = TMP + '.registry.json';

const { default: app, __llmForTest, __censusForTest } = await import('./server.js');
const { deviceKey } = await import('./rateLimit.js');
const { landingPage } = await import('./page.js');

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  try { server.close(); } catch {}
  for (const f of [TMP, TMP + '.usage.json', TMP + '.gp.json', TMP + '.registry.json']) {
    try { fs.unlinkSync(f); } catch {}
  }
});

const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
const get = (p, headers) => fetch(base + p, { headers: headers || {} });
const FREE_SHAPE = (m) => /:free$/i.test(m) || /^openrouter\/free$/i.test(m);

// ---- 1. LLM 402-dead ----
test('unit: LLM token bound fits the affordable budget (no 402 on the free key)', async () => {
  assert.equal(__llmForTest.LLM_MAX_TOKENS, 200, 'max_tokens pinned to the affordable bound');
});

test('unit: freeModelChain is free-first even with a paid LLM_MODEL (paid never at 0)', async () => {
  const prev = process.env.LLM_MODEL;
  try {
    process.env.LLM_MODEL = 'google/gemini-2.5-flash'; // paid: no :free suffix (prod value)
    const chain = __llmForTest.freeModelChain(undefined);
    assert.ok(chain.length > 0, 'chain is non-empty');
    assert.ok(FREE_SHAPE(chain[0]), `position 0 must be free, got ${chain[0]}`);
    process.env.LLM_MODEL = 'google/gemma-4-31b-it:free';
    assert.equal(__llmForTest.freeModelChain(undefined)[0], 'google/gemma-4-31b-it:free', 'a free configured model keeps position 0');
    delete process.env.LLM_MODEL;
    assert.ok(FREE_SHAPE(__llmForTest.freeModelChain(undefined)[0]), 'unset LLM_MODEL falls back to a free default at 0');
  } finally {
    if (prev === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = prev;
  }
});

// ---- 2. Landing pills ----
test('unit: landingPage signature stable: unknown renders em-dash, known renders numbers', async () => {
  const unknown = landingPage({ mode: 'local', demoBlobs: null, guardCount: null });
  assert.ok(unknown.includes('— demo memories live') && unknown.includes('— guard stops on record'), 'unknown pills show an em-dash');
  assert.ok(!unknown.includes('0 demo memories') && !unknown.includes('0 guard stops'), 'unknown must never print 0');
  const known = landingPage({ mode: 'mainnet', demoBlobs: 13, guardCount: 5 });
  assert.ok(known.includes('13 demo memories live') && known.includes('5 guard stops on record'), 'known counts still print');
  const zero = landingPage({ mode: 'local', demoBlobs: 0, guardCount: 0 });
  assert.ok(zero.includes('0 demo memories live'), 'a genuinely-known zero stays numeric, not a dash');
});

test('GET / on a fresh ledger shows the honest unknown guard pill (never a 0 refute)', async () => {
  const html = await (await get('/')).text();
  assert.ok(html.includes('—'), 'fresh-ledger landing must show an em-dash pill');
  assert.ok(!html.includes('0 guard stops on record'), 'empty ledger is unknown, not "0 stops"');
  assert.ok(!html.includes('NaN'), 'no NaN leaks into pills');
});

// ---- 3. Census TTL cache ----
test('unit: census cache bypassed when not cacheable (local/test behavior)', async () => {
  let runs = 0;
  const loader = async () => { runs++; return { totalBlobs: 7 }; };
  assert.equal((await __censusForTest.cachedCensus('ns-a', loader, false)).totalBlobs, 7, 'loader value passes through');
  assert.equal((await __censusForTest.cachedCensus('ns-a', loader, false)).totalBlobs, 7);
  assert.equal((await __censusForTest.cachedCensus('ns-a', loader, false)).totalBlobs, 7);
  assert.equal(runs, 3, 'every call runs the loader when not cacheable');
  assert.equal(__censusForTest.censusCache.size, 0, 'nothing cached in local/test mode');
});

test('census cache: 60s TTL keyed by namespace (mainnet path)', async () => {
  assert.equal(__censusForTest.CENSUS_TTL_MS, 60_000, 'small 60s TTL');
  __censusForTest.censusCache.clear();
  let runs = 0;
  const loader = async () => { runs++; return { totalBlobs: runs }; };
  assert.equal((await __censusForTest.cachedCensus('ns-x', loader, true)).totalBlobs, 1);
  assert.equal((await __censusForTest.cachedCensus('ns-x', loader, true)).totalBlobs, 1, 'second hit served from cache');
  assert.equal(runs, 1);
  assert.equal((await __censusForTest.cachedCensus('ns-y', loader, true)).totalBlobs, 2, 'keyed by namespace');
  const hit = __censusForTest.censusCache.get('ns-x');
  hit.at = Date.now() - 61_000; // expire the entry without waiting
  assert.equal((await __censusForTest.cachedCensus('ns-x', loader, true)).totalBlobs, 3, 'stale entry re-runs the loader');
  __censusForTest.censusCache.clear();
});

test('local dashboard + landing hits never populate the census cache', async () => {
  __censusForTest.censusCache.clear();
  assert.equal((await get('/api/dashboard?user=demo-mom')).status, 200);
  assert.equal((await get('/')).status, 200);
  assert.equal(__censusForTest.censusCache.size, 0, 'no census caching outside mainnet');
});

// ---- 4. Limiter env overrides + device keying ----
test('deviceKey isolates devices on one NAT IP', async () => {
  const a = deviceKey({ ip: '1.2.3.4', headers: { 'x-device-id': 'device-AAA-111' } });
  const b = deviceKey({ ip: '1.2.3.4', headers: { 'x-device-id': 'device-BBB-222' } });
  const c = deviceKey({ ip: '1.2.3.4', headers: {} });
  const d = deviceKey({ ip: '1.2.3.4', headers: {} });
  const e = deviceKey({ ip: '5.6.7.8', headers: { 'x-device-id': 'device-AAA-111' } });
  assert.notEqual(a, b, 'two browsers on one NAT IP get different buckets');
  assert.equal(c, d, 'missing device id is a stable fallback, not a bypass');
  assert.notEqual(a, e, 'same device on different IPs differs');
});

test('DD_READ_LIMIT override takes effect end-to-end and is device-keyed', async () => {
  process.env.DD_READ_LIMIT = '2';
  try {
    const h1 = { 'X-Device-Id': `t3-r1-${Date.now()}` };
    assert.equal((await get('/api/summary?user=demo-mom', h1)).status, 200);
    assert.equal((await get('/api/summary?user=demo-mom', h1)).status, 200);
    assert.equal((await get('/api/summary?user=demo-mom', h1)).status, 429, 'override must gate the 3rd read');
    const h2 = { 'X-Device-Id': `t3-r2-${Date.now()}` };
    assert.equal((await get('/api/summary?user=demo-mom', h2)).status, 200, 'a second device on the same IP keeps its own read budget');
  } finally {
    process.env.DD_READ_LIMIT = '10000';
  }
});

test('DD_CHAT_LIMIT override takes effect end-to-end', async () => {
  process.env.DD_CHAT_LIMIT = '2';
  try {
    const u = `t3-chat-${Date.now()}`;
    const h = { 'X-Device-Id': `t3-c-${Date.now()}` };
    assert.equal((await post('/api/chat', { userId: u, message: 'hello there' }, h)).status, 200);
    assert.equal((await post('/api/chat', { userId: u, message: 'hello again' }, h)).status, 200);
    assert.equal((await post('/api/chat', { userId: u, message: 'one more' }, h)).status, 429, 'override must gate the 3rd turn');
  } finally {
    process.env.DD_CHAT_LIMIT = '10000';
  }
});
