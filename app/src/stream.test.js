// Streaming chat tests (T2): additive POST /api/chat/stream over HTTP on a
// scratch server, keyless path (OPENROUTER_API_KEY=''), plus unit tests for
// the server-side SSE chunk parser.
// Run: node --test src/stream.test.js   (part of `npm test`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch {} for (const f of [TMP, TMP + '.usage.json', TMP + '.gp.json', TMP + '.registry.json']) { try { fs.unlinkSync(f); } catch {} } });

const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const chat = async (userId, message, headers) => (await post('/api/chat', { userId, message }, headers)).json();

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

test('guard STOP arrives as instant non-streamed JSON with blob citation', async () => {
  const u = `st-guard-${Date.now()}`;
  await chat(u, 'She is allergic to ibuprofen, causes rash');
  const { res, events } = await streamPost({ userId: u, message: 'Can she take ibuprofen for her headache?' });
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

test('keyless memory-fallback streams thinking -> token+ -> done with intact budget', async () => {
  const u = `st-fallback-${Date.now()}`;
  const { res, events } = await streamPost({ userId: u, message: 'She takes Metformin 500mg at 8pm' });
  assert.equal(res.status, 200);
  const kinds = events.map((e) => e.event);
  assert.equal(kinds[0], 'thinking', 'thinking is sent FIRST');
  assert.equal(kinds[kinds.length - 1], 'done');
  const tokens = events.filter((e) => e.event === 'token');
  assert.ok(tokens.length >= 1, 'fallback text is chunk-streamed');
  assert.ok(tokens.every((t) => typeof t.data.t === 'string'), 'token shape is {t:"..."}');
  const done = events.find((e) => e.event === 'done').data;
  assert.equal(tokens.map((t) => t.data.t).join(''), done.reply, 'tokens reassemble to the full reply');
  assert.ok(done.savedBlob, 'the taught fact is still persisted');
  assert.ok(done.budget && typeof done.budget.used === 'number' && typeof done.budget.cap === 'number', 'budget object intact');
  assert.match(done.disclaimer, /doctor/i);
});

test('budget turn is consumed exactly once per stream (no double-charge, no free-ride)', async () => {
  const devH = { 'X-Device-Id': `st-once-${Date.now()}` };
  const u = `st-once-${Date.now()}`;
  const { events } = await streamPost({ userId: u, message: 'She takes calcium at 9am' }, devH);
  const done = events.find((e) => e.event === 'done').data;
  assert.equal(done.budget.used, 1, 'one stream turn charges exactly one turn');
  assert.equal(done.budget.remaining, done.budget.cap - 1);
});

test('429 shape preserved as an error event', async () => {
  const devH = { 'X-Device-Id': `st-429-${Date.now()}` };
  const u = `st-429-${Date.now()}`;
  process.env.DD_DAY_LIMIT_ANON = '2';
  try {
    await streamPost({ userId: u, message: 'hello number 0' }, devH);
    await streamPost({ userId: u, message: 'hello number 1' }, devH);
    const { res, events } = await streamPost({ userId: u, message: 'one more please' }, devH);
    assert.equal(res.status, 429, 'HTTP status preserved');
    const err = events.find((e) => e.event === 'error');
    assert.ok(err, 'an error event is emitted');
    assert.equal(err.data.loginRequired, true, 'same login prompt shape as /api/chat');
    assert.equal(err.data.demoUser, 'demo-mom');
    assert.equal(err.data.remaining, 0);
    assert.match(err.data.resetsAt, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    process.env.DD_DAY_LIMIT_ANON = '10000';
  }
});

test('demo read-only respected on the stream endpoint', async () => {
  const { res, events } = await streamPost({ userId: 'demo-mom', message: 'She takes calcium at 9am' });
  assert.equal(res.status, 200);
  const done = events.find((e) => e.event === 'done').data;
  assert.equal(done.savedBlob, null, 'demo never writes');
  assert.ok(/read-only/i.test(done.reply), 'teach redirects instead of vanishing');
});

test('SSE chunk parser: split lines, [DONE], malformed JSON skipped, multi-byte intact', async () => {
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
