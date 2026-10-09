// Usage-evidence + proactive-safety tests (offline, no network — uses the local
// client / fault injection). Run: node --test src/stats.test.js  (part of `npm test`)
// Covers: UsageTracker accounting (dedup by blob id, qualifies, JSON/MD export),
// GuardProof append + tamper detection, morning brief, nightly cross-check,
// tickOnce morning/evening split, and the new routes (usage, guard-proof,
// proactive, nudge) over the real Express app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Configure BEFORE importing the app (dotenv does not override existing vars).
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-stats-'));
process.env.DD_LOCAL_STORE = path.join(TMPDIR, 'local-memory.json');
process.env.DD_USAGE_LEDGER = path.join(TMPDIR, 'usage-ledger.json');
process.env.DD_GUARD_PROOF = path.join(TMPDIR, 'guard-proof.json');
process.env.MEMWAL_MODE = 'local';
process.env.SESSION_SECRET = 'stats-test-secret';
process.env.OPENROUTER_API_KEY = '';
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_REGISTRY_PATH = path.join(TMPDIR, 'registry.json');

const { UsageTracker, GuardProof, morningBriefFromRecall, nightlyCrossCheckFromRecall, tickOnce, USERS } = await import('./usage.js');
const { default: app } = await import('./server.js');
const { issueSession: issueSessionTop } = await import('./walletAuth.js');
const { upsertUser: upsertUserTop } = await import('./userRegistry.js');

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  try { server.close(); } catch {}
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
});

const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
const get = (p, headers) => fetch(base + p, { headers: headers || {} });
// Personal-chat login gate (SPEC §4/A): anonymous personal chat is 401, so
// behavior tests chat through a per-label vault session (named userId passes
// through untouched; the session vault answers).
let autoVaultN = 0;
const vaultAddrFor = (label) => '0x' + crypto.createHash('sha256').update(`stats-vault:${label}`).digest('hex');
const vaultSeen = new Set();
const vh = (label, extra) => {
  const addr = vaultAddrFor(label);
  if (!vaultSeen.has(addr)) {
    vaultSeen.add(addr);
    upsertUserTop({ address: addr, accountId: `obj-SX-AUTO-${++autoVaultN}`, delegatePrivateKey: '11'.repeat(32), delegatePublicKey: '22'.repeat(64), delegateAddress: '0x' + '33'.repeat(32), pendingPhase: null, pendingTxBytes: null });
  }
  return { Cookie: `dd_session=${issueSessionTop(addr)}`, ...(extra || {}) };
};
const chat = async (userId, message, headers) => (await post('/api/chat', { userId, message }, vh(userId, headers))).json();
// Deterministic counter ids (no Date.now() — parallel-stable, no collisions).
let stn = 0;
const stid = (p) => `${p}-${String(++stn).padStart(6, '0')}`;

test('UsageTracker: dedups by blob id, counts qualifying users, exports JSON + markdown', () => {
  const t = new UsageTracker({ persistPath: null });
  for (let i = 0; i < 12; i++) t.recordMemory('alice', { blobId: `blob-a${i}`, text: `fact ${i}` });
  t.recordMemory('alice', { blobId: 'blob-a0', text: 'fact 0' }); // duplicate blob id must not double-count
  t.recordMemory('bob', { blobId: 'blob-b0', text: 'fact' });
  const snap = USERS.map((u) => t.snapshot(u)); // default users: none of alice/bob
  assert.equal(snap.every((s) => s.memories === 0), true, 'untracked users report zero, not fake data');
  const sum = t.summary({ users: ['alice', 'bob', 'carol'], mode: 'local' });
  assert.equal(sum.json.users.find((u) => u.userId === 'alice').memories, 12);
  assert.equal(sum.json.users.find((u) => u.userId === 'bob').memories, 1);
  assert.equal(sum.json.qualifyingUsers, 1, 'only alice meets 10');
  assert.equal(sum.json.meetsMinimum, false);
  assert.match(sum.md, /NOT MET/);
  assert.match(sum.md, /blob-a0/);
  t.recordMemory('carol', { blobId: 'blob-c0', text: 'x' });
  const partial = t.summary({ users: ['alice', 'bob', 'carol'] }).json;
  assert.equal(partial.totalMemories, 14);
  // Redaction is explicit, not silent: a redactUser predicate hides texts
  // behind a visible marker (route tests assert the predicate wiring).
  const red = t.summary({ users: ['alice'], redactUser: () => true });
  assert.match(red.md, /\[redacted/, 'redaction marker present in markdown');
  assert.ok(!/fact 0/.test(red.md), 'redacted texts hidden in markdown');
  assert.ok(red.json.users[0].blobs.length >= 1, 'counts + ids stay public under redaction');
  const open = t.summary({ users: ['alice'], redactUser: () => false });
  assert.ok(/fact 0/.test(open.md), 'owners still read their own texts');
});

test('UsageTracker: persists and reloads (server restart must not lose evidence)', () => {
  const p = path.join(TMPDIR, 'reload.json');
  const t1 = new UsageTracker({ persistPath: p });
  t1.touchUser('u1', { turn: true });
  t1.recordMemory('u1', { blobId: 'b1', text: 'takes Metformin 500mg at 8pm' });
  const t2 = new UsageTracker({ persistPath: p });
  const s = t2.snapshot('u1');
  assert.equal(s.memories, 1);
  assert.equal(s.turns, 1);
  assert.equal(s.meetsMinimum, false);
  assert.equal(s.blobs[0].link, null, 'local ids must never get walruscan links');
});

test('GuardProof: appends, links the chain, and detects tampering', () => {
  const p = path.join(TMPDIR, 'gp.json');
  const g = new GuardProof({ persistPath: p });
  const e1 = g.record({ userId: 'demo-mom', kind: 'conflict', substance: 'ibuprofen', severity: 'high', reason: 'recalled allergy', fact: 'allergic to ibuprofen', blobId: 'local-x', message: 'Can she take ibuprofen?' });
  const e2 = g.record({ userId: 'demo-mom', kind: 'interaction', substance: 'ibuprofen', withSubstance: 'warfarin', severity: 'high', reason: 'bleeding risk', fact: 'takes warfarin', blobId: 'local-y', message: 'Can she take ibuprofen?' });
  assert.equal(e1.n, 1);
  assert.equal(e2.prev, e1.hash, 'entry 2 must carry entry 1\'s hash');
  assert.equal(g.verify().ok, true);
  // Tamper: edit one persisted entry after the fact.
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  raw.entries[0].substance = 'paracetamol';
  fs.writeFileSync(p, JSON.stringify(raw));
  const g2 = new GuardProof({ persistPath: p });
  const v = g2.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
});

test('morning brief: meds + allergies from recall, null on empty, null without meds', () => {
  const brief = morningBriefFromRecall([
    { text: 'User demo-mom: takes Metformin 500mg at 8pm after food' },
    { text: 'User demo-mom: allergic to ibuprofen — causes rash' },
  ]);
  assert.match(brief, /Good morning/);
  assert.match(brief, /Metformin 500mg at 8pm/);
  assert.match(brief, /Allergies on file: allergic to ibuprofen/);
  assert.equal(morningBriefFromRecall([]), null);
  assert.equal(morningBriefFromRecall([{ text: 'dinner at 7pm' }]), null, 'no meds → no brief');
});

test('nightly cross-check: catches a pair taught on different days, skips allergy clauses, dedups pairs', () => {
  const facts = [
    { text: 'User demo: takes warfarin 5mg daily', blob_id: 'b1' },
    { text: 'User demo: takes sertraline 50mg every morning', blob_id: 'b2' },
  ];
  const hits = nightlyCrossCheckFromRecall(facts);
  assert.equal(hits.length, 1, 'one unordered pair, not two scan directions');
  const pair = [hits[0].substance, hits[0].withSubstance].sort().join('+');
  assert.ok(['sertraline+warfarin', 'warfarin+serotonergic'].includes(pair), `pair is the warfarin×sertraline interaction (got ${pair})`);
  assert.equal(hits[0].severity, 'high');
  // An allergy clause must never seed an interaction (allergy is not a current med).
  const noAllergySeed = nightlyCrossCheckFromRecall([{ text: 'allergic to ibuprofen — rash' }, { text: 'takes warfarin 5mg' }]);
  for (const h of noAllergySeed) assert.notEqual(h.withSubstance, 'ibuprofen', 'allergy fact must not be treated as a current med');
});

test('tickOnce: morning hour yields the brief, evening hour yields only the safety check', async () => {
  const { createLocalClient } = await import('./localClient.js');
  const client = createLocalClient({ namespace: 'user-tick-test' });
  await client.remember('User tick: takes warfarin 5mg daily');
  await client.remember('User tick: takes sertraline 50mg in the morning');
  const morning = await tickOnce(client, { hour: 7 });
  assert.ok(morning.items.some((i) => i.kind === 'morning-brief'), 'morning brief fires before noon');
  assert.ok(morning.items.some((i) => i.kind === 'interaction-check'), 'cross-check fires every tick');
  const evening = await tickOnce(client, { hour: 20 });
  assert.ok(!evening.items.some((i) => i.kind === 'morning-brief'), 'no morning brief in the evening');
  assert.ok(evening.items.some((i) => i.kind === 'interaction-check'));
});

// ---- routes over the real app ----

test('/api/usage: zero-state is honest (meetsMinimum false, no fake users)', async () => {
  const j = await (await get('/api/usage')).json();
  assert.equal(j.meetsMinimum, false);
  assert.equal(j.users.length, 3);
  assert.ok(j.users.every((u) => u.memories === 0));
});

test('/guard-proof + /api/guard-proof: renders, and the fired STOP is on the ledger with a blob', async () => {
  const u = stid('stats-gp');
  await chat(u, 'She is allergic to ibuprofen, causes rash');
  await chat(u, 'Can she take ibuprofen for her headache?'); // fires the guard
  const api = await (await get('/api/guard-proof')).json();
  assert.ok(api.count >= 1, 'guard firing must be recorded');
  assert.equal(api.verify.ok, true, 'published chain must verify');
  const entry = api.entries.find((e) => e.kind === 'conflict' && e.substance === 'ibuprofen');
  assert.ok(entry, 'the allergy STOP is on the public ledger');
  assert.ok(entry.blobId, 'the receipt cites the blob that fired it');
  const page = await get('/guard-proof');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Guard proof/);
  assert.match(html, /chain intact/);
});

test('/api/proactive: morning plan + cross-check from recall only', async () => {
  // Login gate (SPEC §4/A): the personal namespace is seeded directly (reads
  // stay world-readable), so the brief compiles from seeded recall.
  const u = stid('stats-pro');
  const { createLocalClient } = await import('./localClient.js');
  const { namespaceFor: nsf } = await import('./memory.js');
  const seedClient = createLocalClient({ namespace: nsf(u) });
  await seedClient.remember('My mom takes warfarin 5mg at 8pm');
  await seedClient.remember('She takes sertraline 50mg every morning');
  const j = await (await get(`/api/proactive?user=${encodeURIComponent(u)}`)).json();
  assert.match(j.morning, /Good morning/);
  assert.match(j.morning, /warfarin/);
  assert.ok(Array.isArray(j.interactionWarnings));
});

test('/api/nudge: runs the tick on demand and returns per-user items', async () => {
  // Login gate (SPEC §4/A): the target namespace is seeded directly (nudge is
  // a read surface and stays anonymous).
  const u = stid('stats-nudge');
  const { createLocalClient } = await import('./localClient.js');
  const { namespaceFor: nsf2 } = await import('./memory.js');
  await (createLocalClient({ namespace: nsf2(u) })).remember('My mom takes warfarin 5mg at 8pm');
  const r = await post('/api/nudge', { users: [u], hour: 8 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.users.length, 1);
  assert.equal(j.users[0].user, u);
  assert.ok(Array.isArray(j.users[0].items));
});

test('/api/nudge: reserved namespaces are refused', async () => {
  const r = await post('/api/nudge', { users: ['vault-abc'], hour: 8 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.users.length, 0, 'a vault namespace must never be probed anonymously');
});

test('/api/usage: anonymous callers get counts but redacted blob texts (privacy)', async () => {
  await chat('user-a', 'User-a takes Metformin 500mg at 8pm');
  const j = await (await get('/api/usage')).json();
  // Counts + requirement stay public.
  assert.ok(j.requirement, 'requirement stays public');
  // NOTE (G3-FIX B): `user-` prefixes strip during normalisation, so this
  // teach lands in the canonical `a` row — untracked by the fixed JSON USERS
  // list. No shadow `user-a` row may be fabricated, and the fact text must
  // leak nowhere (counts-public/texts-redacted for tracked rows is covered
  // end-to-end on SQLite in db.test.js, where seen ids are enumerated).
  const shadow = j.users.find((u) => u.userId === 'user-a');
  assert.ok(shadow && shadow.memories === 0, 'no shadow usage row fabricated for the prefixed id');
  assert.ok(!JSON.stringify(j).toLowerCase().includes('metformin'), 'untracked-namespace fact text leaks nowhere');
});
