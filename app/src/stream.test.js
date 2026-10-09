// Streaming chat tests (T2): additive POST /api/chat/stream over HTTP on a
// scratch server, keyless path (OPENROUTER_API_KEY=''), plus unit tests for
// the server-side SSE chunk parser.
// Run: node --test src/stream.test.js   (part of `npm test`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Configure BEFORE importing the app (dotenv does not override existing vars).
const TMP = path.join(os.tmpdir(), `dd-stream-${process.pid}-${Date.now()}.json`);
process.env.DD_LOCAL_STORE = TMP;
process.env.DD_USAGE_LEDGER = TMP + '.usage.json';
process.env.DD_GUARD_PROOF = TMP + '.gp.json';
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 'stream-test-secret';
process.env.OPENROUTER_API_KEY = ''; // keyless path: memory-fallback must stream
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_NONCE_LIMIT = '10000';
process.env.DD_AUTH_LIMIT = '10000';
process.env.DD_DAY_LIMIT_ANON = '10000';
process.env.DD_DAY_LIMIT_WALLET = '10000';
process.env.DD_REGISTRY_PATH = TMP + '.registry.json';

const { default: app, __sseForTest } = await import('./server.js');
const { issueSession: issueSessionTop } = await import('./walletAuth.js');
const { upsertUser: upsertUserTop } = await import('./userRegistry.js');

// Deterministic counter ids (no Date.now() — parallel-stable, no collisions).
let stn = 0;
const stid = (p) => `${p}-${String(++stn).padStart(6, '0')}`;
let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch {} for (const f of [TMP, TMP + '.usage.json', TMP + '.gp.json', TMP + '.registry.json']) { try { fs.unlinkSync(f); } catch {} } });

const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
// Personal-chat login gate (SPEC §4/A): anonymous personal chat/stream is 401,
// so behavior tests stream through a per-label vault session (named userId
// passes through untouched; the session vault answers).
let autoVaultN = 0;
const vaultAddrFor = (label) => '0x' + crypto.createHash('sha256').update(`stream-vault:${label}`).digest('hex');
const vaultSeen = new Set();
const vh = (label, extra) => {
  const addr = vaultAddrFor(label);
  if (!vaultSeen.has(addr)) {
    vaultSeen.add(addr);
    upsertUserTop({ address: addr, accountId: `obj-ST-AUTO-${++autoVaultN}`, delegatePrivateKey: '11'.repeat(32), delegatePublicKey: '22'.repeat(64), delegateAddress: '0x' + '33'.repeat(32), pendingPhase: null, pendingTxBytes: null });
  }
  return { Cookie: `dd_session=${issueSessionTop(addr)}`, ...(extra || {}) };
};
const chat = async (userId, message, headers) => (await post('/api/chat', { userId, message }, vh(userId, headers))).json();

// Parse a collected SSE body into [{ event, data }], JSON-decoding data.
function parseEvents(text) {
  return String(text).split('\n\n').filter((s) => s.trim()).map((block) => {
    const ev = (block.match(/^event:\s*(.*)$/m) || [])[1]?.trim() || null;
    const dataStr = [...block.matchAll(/^data:\s?(.*)$/gm)].map((m) => m[1]).join('\n');
    let data = dataStr;
    try { data = JSON.parse(dataStr); } catch { /* keep raw */ }
    return { event: ev, data };
  });
}
const streamPost = async (body, headers) => {
  const r = await post('/api/chat/stream', body, headers);
  return { res: r, events: parseEvents(await r.text()) };
};
// Fixed per-browser transcript id shared across turns: fetch never stores
// cookies, so multi-turn transcript tests must pin dd_cid explicitly.
const cidH = (label, cid, extra) => {
  const h = vh(label, extra);
  return { ...h, Cookie: `${h.Cookie}; dd_cid=${cid}` };
};

test('guard STOP arrives as instant non-streamed JSON with blob citation', async () => {
  const u = stid('st-guard');
  await chat(u, 'She is allergic to ibuprofen, causes rash');
  const { res, events } = await streamPost({ userId: u, message: 'Can she take ibuprofen for her headache?' }, vh(u));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const kinds = events.map((e) => e.event);
  assert.equal(kinds[0], 'thinking', 'thinking is sent FIRST');
  assert.ok(!kinds.includes('token'), 'a safety verdict is never streamed token-by-token');
  assert.equal(kinds[kinds.length - 1], 'done');
  const done = events.find((e) => e.event === 'done').data;
  assert.match(done.reply, /^STOP\b/);
  assert.ok(/local-/.test(done.reply), 'STOP cites the blob id');
  assert.equal(done.savedBlob, null, 'a blocked order is never saved');
});

test('teaching-shaped order STOPs on stream (needs intent, blob cited, never tokenised)', async () => {
  const u = stid('st-order');
  await chat(u, 'She is allergic to naproxen, causes rash');
  const { res, events } = await streamPost({ userId: u, message: 'She avoids naproxen. She needs Advil.' }, vh(u));
  assert.equal(res.status, 200);
  const kinds = events.map((e) => e.event);
  assert.ok(!kinds.includes('token'), 'a safety verdict is never streamed token-by-token');
  const done = events.find((e) => e.event === 'done').data;
  assert.match(done.reply, /^STOP\b/, 'needs-Advil order STOPs on stream');
  assert.ok(/local-/.test(done.reply), 'STOP cites the blob id');
});

test('keyless memory-fallback streams thinking -> token+ -> done with intact budget', async () => {
  const u = stid('st-fallback');
  const { res, events } = await streamPost({ userId: u, message: 'She takes Metformin 500mg at 8pm' }, vh(u));
  assert.equal(res.status, 200);
  const kinds = events.map((e) => e.event);
  assert.equal(kinds[0], 'thinking', 'thinking is sent FIRST');
  assert.equal(kinds[kinds.length - 1], 'done');
  const tokens = events.filter((e) => e.event === 'token');
  assert.ok(tokens.length >= 1, 'fallback text arrives whole (single honest token)');
  assert.ok(tokens.every((t) => typeof t.data.t === 'string'), 'token shape is {t:"..."}');
  const done = events.find((e) => e.event === 'done').data;
  assert.equal(tokens.map((t) => t.data.t).join(''), done.reply, 'tokens reassemble to the full reply');
  assert.ok(done.savedBlob, 'the taught fact is still persisted');
  assert.ok(done.budget && typeof done.budget.used === 'number' && typeof done.budget.cap === 'number', 'budget object intact');
  assert.match(done.disclaimer, /doctor/i);
});

test('budget turn is consumed exactly once per stream (no double-charge, no free-ride)', async () => {
  const u = stid('st-once');
  const devH = { 'X-Device-Id': stid('st-once') };
  const { events } = await streamPost({ userId: u, message: 'She takes calcium at 9am' }, vh(u, devH));
  const done = events.find((e) => e.event === 'done').data;
  assert.equal(done.budget.used, 1, 'one stream turn charges exactly one turn');
  assert.equal(done.budget.remaining, done.budget.cap - 1);
});

test('429 shape preserved as an error event (wallet rolling bucket)', async () => {
  const u = stid('st-429');
  const devH = { 'X-Device-Id': stid('st-429') };
  process.env.DD_DAY_LIMIT_WALLET = '2';
  try {
    await streamPost({ userId: u, message: 'hello number 0' }, vh(u, devH));
    await streamPost({ userId: u, message: 'hello number 1' }, vh(u, devH));
    const { res, events } = await streamPost({ userId: u, message: 'one more please' }, vh(u, devH));
    assert.equal(res.status, 429, 'HTTP status preserved');
    const err = events.find((e) => e.event === 'error');
    assert.ok(err, 'an error event is emitted');
    assert.equal(err.data.loginRequired, false, 'signed-in wallet 429 carries no login prompt');
    // A wallet owner hitting THEIR OWN cap must never be told they are the
    // shared demo persona — the demoUser pointer is demo-channel-only.
    assert.equal(err.data.demoUser, null, 'wallet 429 carries no demo-user pointer');
    assert.equal(err.data.remaining, 0);
    assert.match(err.data.resetsAt, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    process.env.DD_DAY_LIMIT_WALLET = '10000';
  }
});

test('SPEC §4/A stream: anonymous personal stream is 401 as an error event (no turn, no spend)', async () => {
  const u = stid('st-gate');
  const { res, events } = await streamPost({ userId: u, message: 'hello there friend' });
  assert.equal(res.status, 401, 'anon personal stream refused with the same status as chat');
  const err = events.find((e) => e.event === 'error');
  assert.ok(err, 'an error event is emitted');
  assert.equal(err.data.loginRequired, true, 'same sign-in action shape as /api/chat');
  assert.equal(err.data.action, 'sign-in');
  assert.ok(!events.find((e) => e.event === 'done'), 'a refused stream never completes a turn');
});

test('demo read-only respected on the stream endpoint', async () => {
  const { res, events } = await streamPost({ userId: 'demo-mom', message: 'She takes calcium at 9am' });
  assert.equal(res.status, 200);
  const done = events.find((e) => e.event === 'done').data;
  assert.equal(done.savedBlob, null, 'demo never writes');
  assert.ok(/read-only/i.test(done.reply), 'teach redirects instead of vanishing');
});

test('unit: SSE chunk parser handles split lines, [DONE], malformed JSON, multi-byte intact', async () => {
  assert.ok(__sseForTest, 'parser helper is exported for tests');
  const { parseSSEBuffer } = __sseForTest;
  const tok = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  // Split line across two feeds: nothing emitted until the line completes.
  const part = tok('Hello').slice(0, 20);
  const r1 = parseSSEBuffer(part);
  assert.deepEqual(r1.tokens, []);
  assert.equal(r1.done, false);
  const r2 = parseSSEBuffer(r1.rest + tok('Hello').slice(20) + tok(' world'));
  assert.deepEqual(r2.tokens, ['Hello', ' world']);
  // [DONE] ends the stream with no token.
  const r3 = parseSSEBuffer(r2.rest + 'data: [DONE]\n\n');
  assert.equal(r3.done, true);
  assert.deepEqual(r3.tokens, []);
  // Malformed JSON is skipped, the stream continues.
  const r4 = parseSSEBuffer('data: not-json\n\n' + tok('ok'));
  assert.deepEqual(r4.tokens, ['ok']);
  assert.equal(r4.done, false);
  // Multi-byte chars survive chunking.
  const r5 = parseSSEBuffer(tok('💊 take at 8pm'));
  assert.deepEqual(r5.tokens, ['💊 take at 8pm']);
  // Comment keep-alives are ignored.
  const r6 = parseSSEBuffer(': ping\n\n' + tok('hi'));
  assert.deepEqual(r6.tokens, ['hi']);
});

test('G3-FIX2 stream: nested user- demo ids are read-only with the demo cap', async () => {
  process.env.DD_DAY_LIMIT_DEMO = '7';
  try {
    for (const id of ['user-user-demo-mom', 'user-user-user-demo-mom', 'USER-USER-DEMO-MOM']) {
      const { res, events } = await streamPost({ userId: id, message: 'She takes calcium at 9am' });
      assert.equal(res.status, 200, `stream ${id} answers`);
      const done = events.find((e) => e.event === 'done').data;
      assert.equal(done.savedBlob, null, `stream ${id} never writes`);
      assert.ok(/read-only/i.test(done.reply), `stream ${id} redirects instead of vanishing`);
      assert.equal(done.budget.cap, 7, `stream ${id} under the demo cap`);
      assert.match(done.memoryScope, /^user-demo-/, `stream ${id} reads the canonical shared demo`);
    }
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
});

test('G3-FIX2 stream: triple-nested reserved ids are error events, never turns', async () => {
  for (const id of ['user-user-user-vault-abc', 'User-User-User-Vault-Abc', 'user-user-user-tg-777']) {
    const { res, events } = await streamPost({ userId: id, message: 'hello there friend' });
    assert.equal(res.status, 400, `stream ${id} preserves the 400 status`);
    const err = events.find((e) => e.event === 'error');
    assert.ok(err, `stream ${id} emits an error event`);
    assert.ok(!events.find((e) => e.event === 'done'), `stream ${id} never completes a turn`);
  }
});

// ------------------------------------------------- G3-WAVE3 ---
// Stream parity: the stream endpoint shares the chat pipeline, so every
// namespace-collapsing demo decision holds there too.

test('G3-WAVE3 stream: junk-prefixed demo ids are read-only with the demo cap', async () => {
  process.env.DD_DAY_LIMIT_DEMO = '103';
  try {
    for (const id of ['!demo-mom', 'demo-mom.', 'user- demo-mom', '.demo-mom', '/demo-mom', 'user-!demo-mom']) {
      const { res, events } = await streamPost({ userId: id, message: 'She takes calcium at 9am' });
      assert.equal(res.status, 200, `stream ${JSON.stringify(id)} answers`);
      const done = events.find((e) => e.event === 'done').data;
      assert.equal(done.savedBlob, null, `stream ${JSON.stringify(id)} never writes`);
      assert.ok(/read-only/i.test(done.reply), `stream ${JSON.stringify(id)} redirects instead of vanishing`);
      assert.equal(done.budget.cap, 103, `stream ${JSON.stringify(id)} under the demo cap`);
      assert.equal(done.memoryScope, 'user-demo-mom', `stream ${JSON.stringify(id)} reads the canonical shared demo`);
    }
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
});

test('G3-WAVE3 stream: depth-12 nesting resolves to the canonical demo', async () => {
  process.env.DD_DAY_LIMIT_DEMO = '104';
  try {
    const deep = 'user-'.repeat(12) + 'demo-mom';
    const { res, events } = await streamPost({ userId: deep, message: 'She takes calcium at 9am' });
    assert.equal(res.status, 200, 'stream depth-12 answers instead of 400');
    const done = events.find((e) => e.event === 'done').data;
    assert.equal(done.savedBlob, null, 'stream depth-12 never writes');
    assert.equal(done.budget.cap, 104, 'stream depth-12 under the demo cap');
    assert.equal(done.memoryScope, 'user-demo-mom', 'stream depth-12 reads the canonical shared demo');
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
});

// ------------------------------------------------- PER-TOKEN PINS ---
// Owner-ordered premium feel: the NON-guard path forwards LLM tokens as they
// arrive (thinking → token* → done); guard verdicts stay instant whole
// templates; whole-at-once replies arrive as a single honest token.

// Test-only provider stub: server.js calls global fetch for OpenRouter, so an
// in-process stub controls provider chunks deterministically (no network).
const realFetch = globalThis.fetch;
let providerStub = null;
globalThis.fetch = (url, opts) => {
  if (typeof url === 'string' && url.includes('openrouter.ai') && providerStub) return providerStub(url, opts);
  return realFetch(url, opts);
};
const sseChunk = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
function fakeChunkProvider(chunks, delayMs = 20) {
  return async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        for (const c of chunks) {
          ctrl.enqueue(enc.encode(sseChunk(c)));
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }
        ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
        ctrl.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}

test('per-token live stream: thinking first, provider tokens in order, exactly one done with budget', async () => {
  const u = stid('st-live');
  const parts = ['Hello ', 'from ', 'your ', 'vault.'];
  providerStub = fakeChunkProvider(parts, 30);
  process.env.OPENROUTER_API_KEY = 'test-key-live';
  try {
    const { res, events } = await streamPost({ userId: u, message: 'hello there friend' }, vh(u));
    assert.equal(res.status, 200);
    const kinds = events.map((e) => e.event);
    assert.equal(kinds[0], 'thinking', 'thinking is sent FIRST');
    const tokens = events.filter((e) => e.event === 'token');
    assert.ok(tokens.length >= 2, `expected >=2 live tokens, got ${tokens.length}`);
    const dones = events.filter((e) => e.event === 'done');
    assert.equal(dones.length, 1, 'exactly one done');
    assert.equal(kinds[kinds.length - 1], 'done', 'done is last; no events after done');
    const done = dones[0].data;
    assert.equal(tokens.map((t) => t.data.t).join(''), done.reply, 'tokens reassemble to the full reply in order');
    assert.equal(done.reply, parts.join(''), 'live provider text forwarded as-is, never rewritten');
    assert.ok(done.budget && typeof done.budget.used === 'number' && typeof done.budget.cap === 'number', 'budget emitted exactly once, on done');
    assert.ok(!tokens.some((t) => t.data && typeof t.data === 'object' && 'budget' in t.data), 'budget never rides on tokens');
    assert.ok(Array.isArray(done.thinking) && done.thinking.length, 'done carries thinking');
  } finally {
    process.env.OPENROUTER_API_KEY = '';
    providerStub = null;
  }
});

test('CAUTION verdict stays instant: thinking + done, zero tokens', async () => {
  const u = stid('st-caution');
  await chat(u, 'She takes lithium 300mg at bedtime');
  const { res, events } = await streamPost({ userId: u, message: 'Can she take ibuprofen for pain today?' }, vh(u));
  assert.equal(res.status, 200);
  const kinds = events.map((e) => e.event);
  assert.equal(kinds[0], 'thinking', 'thinking is sent FIRST');
  assert.ok(!kinds.includes('token'), 'a CAUTION safety verdict is never streamed token-by-token');
  const dones = events.filter((e) => e.event === 'done');
  assert.equal(dones.length, 1, 'exactly one done');
  assert.match(dones[0].data.reply, /^CAUTION\b/);
});

test('error-event parity: 400/401/expired-401 bodies identical to /api/chat', async () => {
  const u400 = stid('st-par400');
  const c400 = await (await post('/api/chat', { userId: u400, message: '' }, vh(u400))).json();
  const s400 = await streamPost({ userId: u400, message: '' }, vh(u400));
  assert.equal(s400.res.status, 400);
  assert.deepEqual(s400.events.find((e) => e.event === 'error').data, c400);
  assert.ok(!s400.events.find((e) => e.event === 'done'), 'a refused stream never completes a turn');
  const u401 = stid('st-par401');
  const c401r = await post('/api/chat', { userId: u401, message: 'hello there friend' });
  assert.equal(c401r.status, 401);
  const s401 = await streamPost({ userId: u401, message: 'hello there friend' });
  assert.equal(s401.res.status, 401);
  assert.deepEqual(s401.events.find((e) => e.event === 'error').data, await c401r.json());
  const uExp = stid('st-parexp');
  const expH = { Cookie: 'dd_session=garbage.token' };
  const cExpR = await post('/api/chat', { userId: uExp, message: 'hello there friend' }, expH);
  assert.equal(cExpR.status, 401);
  const sExp = await streamPost({ userId: uExp, message: 'hello there friend' }, expH);
  assert.equal(sExp.res.status, 401);
  assert.deepEqual(sExp.events.find((e) => e.event === 'error').data, await cExpR.json());
});

test('error-event parity: 429 bodies match /api/chat (modulo clock fields)', async () => {
  const u = stid('st-par429a'), v = stid('st-par429b');
  const devA = { 'X-Device-Id': stid('st-par429a') }, devB = { 'X-Device-Id': stid('st-par429b') };
  process.env.DD_DAY_LIMIT_WALLET = '1';
  try {
    assert.equal((await post('/api/chat', { userId: u, message: 'hello number 0' }, vh(u, devA))).status, 200);
    const s429 = await streamPost({ userId: u, message: 'one more please' }, vh(u, devA));
    assert.equal(s429.res.status, 429);
    assert.equal((await streamPost({ userId: v, message: 'hello number 0' }, vh(v, devB))).res.status, 200);
    const c429r = await post('/api/chat', { userId: v, message: 'one more please' }, vh(v, devB));
    assert.equal(c429r.status, 429);
    const sErr = s429.events.find((e) => e.event === 'error').data;
    const cErr = await c429r.json();
    const strip = ({ resetAt, resetInHrs, ...rest }) => rest;
    assert.deepEqual(strip(sErr), strip(cErr));
    assert.equal(typeof sErr.resetAt, 'string');
    assert.equal(typeof cErr.resetAt, 'string');
    assert.equal(typeof sErr.resetInHrs, 'number');
  } finally {
    process.env.DD_DAY_LIMIT_WALLET = '10000';
  }
});

test('single-token fallback pin: keyless whole reply arrives as exactly one token + done', async () => {
  const u = stid('st-single');
  const { res, events } = await streamPost({ userId: u, message: 'She takes calcium 500mg at 9am with food' }, vh(u));
  assert.equal(res.status, 200);
  const kinds = events.map((e) => e.event);
  assert.equal(kinds[0], 'thinking', 'thinking is sent FIRST');
  assert.equal(kinds[kinds.length - 1], 'done');
  const tokens = events.filter((e) => e.event === 'token');
  assert.equal(tokens.length, 1, 'a whole-at-once reply is one honest token, never word-split');
  const done = events.find((e) => e.event === 'done').data;
  assert.equal(tokens[0].data.t, done.reply, 'the single token carries the full reply');
  assert.ok(done.reply.length > 24, 'reply long enough that chunking would have split it');
  assert.ok(done.savedBlob, 'the taught fact is still persisted');
});

test('non-streaming provider whole reply arrives as exactly one token + done', async () => {
  const u = stid('st-whole');
  const whole = 'Whole provider answer in one body.';
  providerStub = async () => new Response(JSON.stringify({ choices: [{ message: { content: whole } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  process.env.OPENROUTER_API_KEY = 'test-key-whole';
  try {
    const { res, events } = await streamPost({ userId: u, message: 'hello there friend' }, vh(u));
    assert.equal(res.status, 200);
    const tokens = events.filter((e) => e.event === 'token');
    assert.equal(tokens.length, 1, 'a whole-at-once provider reply is one honest token, never word-split');
    const done = events.find((e) => e.event === 'done').data;
    assert.equal(done.reply, whole, 'provider text used whole, never replaced by the memory fallback');
    assert.equal(tokens[0].data.t, whole);
  } finally {
    process.env.OPENROUTER_API_KEY = '';
    providerStub = null;
  }
});

test('charge-on-abort: disconnect after the first token still charges the turn (no free tokens), stores no partial memory', async () => {
  const u = stid('st-abort');
  const devH = { 'X-Device-Id': stid('st-abort') };
  providerStub = fakeChunkProvider(['aa ', 'bb ', 'cc ', 'dd ', 'ee '], 80);
  process.env.OPENROUTER_API_KEY = 'test-key-abort';
  try {
    const ctrl = new AbortController();
    const r = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', ...vh(u, devH) }, body: JSON.stringify({ userId: u, message: 'hello there friend' }), signal: ctrl.signal });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', sawToken = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      if (/event:\s*token/.test(buf)) { sawToken = true; break; }
      if (done) break;
    }
    assert.ok(sawToken, 'saw at least one live token before aborting');
    ctrl.abort();
    try { await reader.cancel(); } catch { /* already torn down */ }
    await new Promise((r2) => setTimeout(r2, 1500)); // let the server handler settle past the full chunk train
  } finally {
    process.env.OPENROUTER_API_KEY = '';
    providerStub = null;
  }
  const after = await chat(u, 'hello there friend', devH);
  // Charge-then-stream (at-least-once): tokens were delivered, so the aborted
  // turn was charged before the first token — only the completed turn follows.
  assert.equal(after.budget.used, 2, 'the aborted turn was charged (tokens delivered); the completed turn is the second charge');
});

// ------------------------------------------------- STREAM-TAIL PARITY PINS ---
// Reviewer/hunter findings: the streaming tail must treat every path like the
// main path — aborted turns store nothing and emit nothing further, live
// tokens always reassemble to done.reply, thinking fires exactly once, the
// upstream provider read dies with the client, and error-ends are guarded.

test('recap-abort parity: an aborted degraded recap stores nothing, emits nothing further', async () => {
  const { resetBreaker } = await import('./memory.js');
  const u = stid('st-recapabort');
  const devH = { 'X-Device-Id': stid('st-recapabort') };
  process.env.DD_FAULT_RECALL = 'throw'; // degraded recall: recap answers honestly
  resetBreaker();
  const ctrl = new AbortController();
  let clientErr = null;
  try {
    const p = fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', ...vh(u, devH) }, body: JSON.stringify({ userId: u, message: 'What do you remember about her?' }), signal: ctrl.signal })
      .then(async (r) => await r.text())
      .catch((e) => { clientErr = e; return null; });
    await new Promise((r) => setTimeout(r, 100)); // abort lands while recall is still failing
    ctrl.abort();
    await p;
    await new Promise((r) => setTimeout(r, 3000)); // let the server handler settle past the recap branch
  } finally {
    delete process.env.DD_FAULT_RECALL;
    resetBreaker();
  }
  assert.equal(clientErr?.name, 'AbortError', 'the abort landed mid-flight (server had not finished yet)');
  const after = await chat(u, 'hello there friend', devH);
  assert.equal(after.budget.used, 1, 'the aborted recap touched no budget; only the completed turn counts');
});

test('rewrite parity: token concatenation equals done.reply even when the lie-guard rewrite triggers', async () => {
  const u = stid('st-rewrite');
  const denial = ["I don't have ", 'any memories yet.'];
  providerStub = fakeChunkProvider(denial, 30);
  process.env.OPENROUTER_API_KEY = 'test-key-rewrite';
  try {
    const { res, events } = await streamPost({ userId: u, message: 'She takes Metformin 500mg at 8pm' }, vh(u));
    assert.equal(res.status, 200);
    const tokens = events.filter((e) => e.event === 'token');
    assert.ok(tokens.length >= 1, 'live tokens were streamed before finalization ran');
    const done = events.find((e) => e.event === 'done').data;
    assert.ok(done.savedBlob, 'the taught fact was still persisted (the rewrite trigger is present)');
    assert.equal(tokens.map((t) => t.data.t).join(''), done.reply, 'concatenated tokens equal done.reply (no-rewrite-after-stream)');
  } finally {
    process.env.OPENROUTER_API_KEY = '';
    providerStub = null;
  }
});

test('single thinking: whole-at-once paths emit thinking exactly once', async () => {
  // (i) keyless memory-fallback whole reply.
  const u1 = stid('st-1think-fb');
  const e1 = (await streamPost({ userId: u1, message: 'She takes calcium 500mg at 9am with food' }, vh(u1))).events;
  assert.equal(e1.filter((e) => e.event === 'thinking').length, 1, 'keyless fallback emits thinking once');
  assert.equal(e1.filter((e) => e.event === 'done').length, 1, 'keyless fallback still completes');
  // (ii) demo-redirect whole reply (fallback + read-only suffix).
  process.env.DD_DAY_LIMIT_DEMO = '10000';
  try {
    const e2 = (await streamPost({ userId: 'demo-mom', message: 'She takes magnesium 250mg at 8pm with food' })).events;
    assert.equal(e2.filter((e) => e.event === 'thinking').length, 1, 'demo redirect emits thinking once');
    assert.equal(e2.filter((e) => e.event === 'done').length, 1, 'demo redirect still completes');
  } finally {
    delete process.env.DD_DAY_LIMIT_DEMO;
  }
  // (iii) non-streaming provider whole body.
  const u3 = stid('st-1think-whole');
  const whole = 'Whole provider answer in one body, long enough that it matters.';
  providerStub = async () => new Response(JSON.stringify({ choices: [{ message: { content: whole } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  process.env.OPENROUTER_API_KEY = 'test-key-1think';
  try {
    const e3 = (await streamPost({ userId: u3, message: 'hello there friend' }, vh(u3))).events;
    assert.equal(e3.filter((e) => e.event === 'thinking').length, 1, 'whole-at-once provider body emits thinking once');
    assert.equal(e3.filter((e) => e.event === 'done').length, 1, 'whole-at-once provider body still completes');
  } finally {
    process.env.OPENROUTER_API_KEY = '';
    providerStub = null;
  }
});

test('abort propagation: a client disconnect aborts the upstream provider read', async () => {
  const u = stid('st-abortup');
  const devH = { 'X-Device-Id': stid('st-abortup') };
  const TOTAL = 20;
  let served = 0, providerAborted = false;
  providerStub = async (url, opts) => {
    const signal = opts?.signal;
    signal?.addEventListener('abort', () => { providerAborted = true; });
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        for (let i = 0; i < TOTAL; i++) {
          if (signal?.aborted) break;
          try { ctrl.enqueue(enc.encode(sseChunk(`tok${i} `))); } catch { break; }
          served++;
          await new Promise((r) => setTimeout(r, 100));
        }
        try { ctrl.enqueue(enc.encode('data: [DONE]\n\n')); } catch { /* client gone */ }
        try { ctrl.close(); } catch { /* client gone */ }
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  process.env.OPENROUTER_API_KEY = 'test-key-abortup';
  try {
    const ctrl = new AbortController();
    const r = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', ...vh(u, devH) }, body: JSON.stringify({ userId: u, message: 'hello there friend' }), signal: ctrl.signal });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', sawToken = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      if (/event:\s*token/.test(buf)) { sawToken = true; break; }
      if (done) break;
    }
    assert.ok(sawToken, 'saw at least one live token before aborting');
    ctrl.abort();
    try { await reader.cancel(); } catch { /* already torn down */ }
    await new Promise((r2) => setTimeout(r2, 1200)); // the full train is 2s; early stop must show by now
    assert.equal(providerAborted, true, 'the upstream provider request was aborted on client disconnect');
    assert.ok(served < TOTAL, `the provider stopped early (served ${served}/${TOTAL})`);
  } finally {
    process.env.OPENROUTER_API_KEY = '';
    providerStub = null;
  }
});

test('guarded error-end: sendStreamError never double-ends and never throws on a dead socket', async () => {
  assert.ok(__sseForTest && __sseForTest.sendStreamError, 'sendStreamError is exported for tests');
  const { sendStreamError } = __sseForTest;
  const mkRes = (over = {}) => {
    const r = {
      headersSent: false, writes: [], ended: 0,
      writeHead(s) { r.status = s; r.headersSent = true; },
      write(s) { r.writes.push(String(s)); return true; },
      flush() {},
      end() { r.ended++; if (r.throwOnEnd) throw new Error('socket dead'); },
      ...over,
    };
    return r;
  };
  const ok = mkRes();
  sendStreamError(ok, 400, { error: 'bad' });
  assert.equal(ok.ended, 1, 'healthy socket gets exactly one end');
  assert.ok(ok.writes.join('').includes('"error"'), 'healthy socket gets the error event');
  const ended = mkRes({ writableEnded: true, throwOnEnd: true });
  sendStreamError(ended, 400, { error: 'bad' });
  assert.equal(ended.ended, 0, 'an already-ended socket is never ended again');
  const dead = mkRes({ destroyed: true, throwOnEnd: true });
  sendStreamError(dead, 400, { error: 'bad' });
  assert.equal(dead.ended, 0, 'a destroyed socket is never ended');
});

// ------------------------------------------------- CHARGE-THEN-STREAM PINS ---
// The turn is charged BEFORE the first token is emitted (at-least-once
// economics): ledger failure is a pure `error` with zero tokens (never
// thinking→token→error), a turn that streams ≥1 token stays charged even when
// the client aborts mid-stream, and an abort before the first byte stays
// uncharged and leaves no transcript trace.

test('charge-then-stream: ledger failure yields an error event with zero tokens', async () => {
  const u = stid('st-ledgerfail');
  process.env.DD_FAULT_LEDGER = 'throw';
  try {
    const { res, events } = await streamPost({ userId: u, message: 'hello there friend' }, vh(u));
    assert.equal(res.status, 500, 'ledger failure keeps the 500 status on the stream endpoint');
    const kinds = events.map((e) => e.event);
    assert.ok(!kinds.includes('token'), 'zero tokens are sent when the charge fails');
    assert.ok(!kinds.includes('done'), 'no turn completes when the charge fails');
    const err = events.find((e) => e.event === 'error');
    assert.ok(err, 'a single error event is emitted');
    assert.equal(err.data.error, 'Internal error');
  } finally {
    delete process.env.DD_FAULT_LEDGER;
  }
});

test('abort-transcript-clean: a turn aborted mid-stream shapes no later turn', async () => {
  const u = stid('st-txclean');
  const H = cidH(u, `txclean-${String(++stn).padStart(6, '0')}`);
  const MARK = 'quux-yellow-42';
  providerStub = fakeChunkProvider(['aa ', 'bb ', 'cc ', 'dd ', 'ee '], 80);
  process.env.OPENROUTER_API_KEY = 'test-key-txclean';
  try {
    const ctrl = new AbortController();
    const r = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ userId: u, message: `hello there friend ${MARK}` }), signal: ctrl.signal });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', sawToken = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      if (/event:\s*token/.test(buf)) { sawToken = true; break; }
      if (done) break;
    }
    assert.ok(sawToken, 'saw at least one live token before aborting');
    ctrl.abort();
    try { await reader.cancel(); } catch { /* already torn down */ }
    await new Promise((r2) => setTimeout(r2, 1200)); // let the server tail settle (no transcript, no done)
    // Second turn on the same transcript id captures the provider-seen history.
    let seen = null;
    providerStub = async (url, opts) => {
      try { seen = JSON.parse(opts.body).messages; } catch { seen = null; }
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(c2) {
          c2.enqueue(enc.encode(sseChunk('fine ')));
          c2.enqueue(enc.encode('data: [DONE]\n\n'));
          c2.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const s2 = await streamPost({ userId: u, message: 'hello there friend' }, H);
    assert.equal(s2.res.status, 200);
    assert.ok(s2.events.find((e) => e.event === 'done'), 'the second turn completes');
    assert.ok(seen, 'the provider saw the second turn');
    assert.ok(!JSON.stringify(seen).includes(MARK), 'the aborted turn left no transcript trace in the next turn');
  } finally {
    process.env.OPENROUTER_API_KEY = '';
    providerStub = null;
  }
});

test('pre-first-token abort stays uncharged and clean (abort during slowed recall)', async () => {
  const u = stid('st-preabort');
  const H = cidH(u, `preabort-${String(++stn).padStart(6, '0')}`);
  const MARK = 'zigzag-marker-77';
  process.env.DD_FAULT_RECALL = 'slow'; // recall resolves well after the abort below
  const ctrl = new AbortController();
  let clientErr = null;
  try {
    const p = fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ userId: u, message: `hello there friend ${MARK}` }), signal: ctrl.signal })
      .then(async (r) => await r.text())
      .catch((e) => { clientErr = e; return null; });
    await new Promise((r) => setTimeout(r, 200)); // abort lands mid-recall, before thinking/tokens
    ctrl.abort();
    await p;
  } finally {
    delete process.env.DD_FAULT_RECALL;
  }
  assert.equal(clientErr?.name, 'AbortError', 'the abort landed mid-flight (server had not finished yet)');
  await new Promise((r) => setTimeout(r, 2200)); // let the slowed recall resolve + the dead tail settle
  let seen = null;
  providerStub = async (url, opts) => {
    try { seen = JSON.parse(opts.body).messages; } catch { seen = null; }
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c2) {
        c2.enqueue(enc.encode(sseChunk('fine ')));
        c2.enqueue(enc.encode('data: [DONE]\n\n'));
        c2.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  process.env.OPENROUTER_API_KEY = 'test-key-preabort';
  try {
    const s2 = await streamPost({ userId: u, message: 'hello there friend' }, H);
    assert.equal(s2.res.status, 200);
    const done = s2.events.find((e) => e.event === 'done').data;
    assert.equal(done.budget.used, 1, 'the pre-token abort charged nothing; only the completed turn counts');
    assert.ok(seen && !JSON.stringify(seen).includes(MARK), 'the pre-token abort left no transcript trace');
  } finally {
    process.env.OPENROUTER_API_KEY = '';
    providerStub = null;
  }
});
