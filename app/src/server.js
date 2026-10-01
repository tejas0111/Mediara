// DoseDaughter web widget — Express chatbot endpoint.
// GET / → chat UI. GET /memory?user=ID → public memory-visible page.
// GET /demo?persona=day1|day7 → before/after harness (empty vs seeded namespace).
// POST /api/chat { userId, message } → recall → LLM → auto-remember facts.
// GET /api/summary?user=ID → doctor-visit summary compiled from recall only.
// Memory backend: MEMWAL_MODE=mainnet (real Walrus Memory, needs keys) or local (default,
// file-backed stand-in with identical interface for offline development and demos).
// Wallet identity: visitors sign in with a Sui wallet (signature verified, HMAC
// session cookie); onboarded users get a per-user MemWal delegate client so chat
// memory lands in THEIR OWN MemWalAccount (they own it; app wallet never touched).
import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createClient, namespaceFor, recallRelevant, recallRelevantMeta, recallAllMeta, mentionsDrug, buildSystemPrompt, rememberAndWait, shouldRemember, findConflict, findInteraction, classifyFacts } from './memory.js';
import { createLocalClient } from './localClient.js';
import { chatPage, memoryPage, demoPage, printPage, replayPage } from './page.js';
import { issueNonce, consumeNonce, verifyWalletSignature, issueSession, sessionFromReq, sessionCookie, clearCookie } from './walletAuth.js';
import { walletStatus, prepareCreateAccount, prepareLinkDelegate, completeOnboarding, relinkExisting } from './onboarding.js';
import { createDelegateClient } from './memory.js';
import { getUser } from './userRegistry.js';
import { limiter, clientIp } from './rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Escape anything echoed into an HTML error page (never reflect raw upstream text).
const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Map an error to a status. Client-state errors carry `status` (e.g. 409 from
// onboarding); everything else is a real 500 and is logged, never echoed raw.
function fail(res, e) {
  const code = (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 600) ? e.status : 500;
  if (code >= 500) console.error('request error:', String((e && e.message) || e).slice(0, 200));
  res.status(code).json({ error: code >= 500 ? 'Internal error' : String((e && e.message) || e) });
}
// A session cookie that fails to parse means EXPIRED (not anonymous). Used to
// avoid silently downgrading an expired signed-in user to the shared channel.
const hasSessionCookie = (req) => /(?:^|;\s*)dd_session=/.test(req.headers.cookie || '');
// Query-string user id: coerce arrays/objects and clamp length (never echo raw).
const clampUser = (v) => { const s = Array.isArray(v) ? v[0] : v; return String(s == null ? '' : s).slice(0, 64) || 'demo-mom'; };

const MODE = process.env.MEMWAL_MODE === 'mainnet' ? 'mainnet' : 'local';
function clientFor(userId) {
  const ns = namespaceFor(userId);
  if (MODE === 'mainnet') return { client: createClient({ namespace: ns }), mode: 'mainnet' };
  return { client: createLocalClient({ namespace: ns }), mode: 'local' };
}

// Wallet-authenticated user → their own MemWal account via delegate key.
// Returns null when the visitor is not signed in / not onboarded (caller falls
// back to the anonymous channel — honest, never silently mixed).
function userClientFor(address) {
  const user = getUser(address);
  if (!user?.accountId || !user?.delegatePrivateKey) return null;
  // Hash the address into a `vault-` namespace: it is NOT derivable from the
  // public address, and namespaceFor's 48-char truncation can no longer reunite
  // two wallets or expose the vault to a guessable `w-<address>` query.
  const ns = namespaceFor(`vault-${crypto.createHash('sha256').update(String(address).toLowerCase()).digest('hex').slice(0, 32)}`);
  // Respect MEMWAL_MODE: in local dev a wallet user must NOT hit the live relayer.
  const client = MODE === 'mainnet'
    ? createDelegateClient({ delegatePrivateKey: user.delegatePrivateKey, accountId: user.accountId, namespace: ns })
    : createLocalClient({ namespace: ns });
  return { client, ns };
}

const app = express();
app.disable('x-powered-by');
// Trust exactly one proxy hop (the platform edge) so req.ip is the real client.
// With no proxy (local dev) leave it off — never trust client-supplied XFF.
// Parse TRUST_PROXY explicitly: '0'/'false' MUST disable it (Number('0')||1 was 1).
const tp = process.env.TRUST_PROXY;
app.set('trust proxy', tp === undefined || tp === ''
  ? (process.env.VERCEL === '1' ? 1 : false)
  : (/^(?:0|false)$/i.test(tp) ? false : (Number(tp) || 1)));
// Security headers on every response. CSP allows inline scripts (the UI is
// server-rendered, no build step) but blocks every external origin.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // script-src is 'self' only (no inline scripts) — the UI JS is served from /assets.
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'");
  if (req.secure || (app.get('trust proxy') && req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});
// CSRF: a browser sends Origin on cross-site POSTs; require same-origin. Non-
// browser clients (no Origin) are unaffected.
app.use((req, res, next) => {
  if (req.method === 'POST' && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'cross-origin request blocked' }); }
    catch { return res.status(403).json({ error: 'invalid origin' }); }
  }
  next();
});
// Static UI assets (hand-written CSS/JS in app/public).
app.use('/assets', express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));
// 16 KB JSON bodies — chat messages and tx signatures are tiny; anything
// larger is abuse. (Express's json parser rejects oversize with 413.)
app.use(express.json({ limit: '16kb' }));

// Rate limits (fixed-window, per IP).
const authLimiter = limiter({ keyFn: (req) => `auth:${clientIp(req)}`, limit: 10, windowMs: 60_000 });
const onboardLimiter = limiter({ keyFn: (req) => `ob:${clientIp(req)}`, limit: 12, windowMs: 60_000 });
const chatLimiter = limiter({ keyFn: (req) => `chat:${clientIp(req)}`, limit: 30, windowMs: 60_000 });
// Read routes fan out to several recall queries; cap them too (audit M9).
const readLimiter = limiter({ keyFn: (req) => `read:${clientIp(req)}`, limit: 60, windowMs: 60_000 });
// Nonce minting is cheap but unbounded; cap it (the nonce Map would otherwise grow).
const nonceLimiter = limiter({ keyFn: (req) => `nonce:${clientIp(req)}`, limit: 30, windowMs: 60_000 });

// Bounded per-namespace conversation transcript so the model sees recent turns,
// not just recalled facts (facts are durable; this is ephemeral context).
const transcripts = new Map();
function historyFor(ns) { return transcripts.get(ns) || []; }
function rememberTurn(ns, role, content) {
  const h = transcripts.get(ns) || [];
  h.push({ role, content: String(content).slice(0, 500) });
  while (h.length > 6) h.shift();
  transcripts.set(ns, h);
  if (transcripts.size > 2000) transcripts.clear();
}

async function callLLM(system, userMessage, history = []) {
  // OpenRouter (Gemini Flash default — Beyond Big Two eligible). Falls back to echo if no key.
  // Resilience: explicit max_tokens (default 65k exceeds free-tier credit), then free-model
  // fallback chain on 402/429 so the demo NEVER dies mid-judge-test. Errors stay graceful.
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.LLM_MODEL || 'google/gemini-2.5-flash';
  if (!apiKey) return '__NO_LLM__';
  // Free-model fallback chain (verified against the OpenRouter free list; all
  // non-OpenAI/Anthropic, so Beyond-Big-Two eligible). Pruned when models die.
  const models = [model, 'google/gemma-4-31b-it:free', 'qwen/qwen3.8-27b:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'liquid/lfm-2.5-2.6b:free', 'openrouter/free'].filter((m, i, a) => a.indexOf(m) === i);
  let lastErr = '';
  for (const m of models) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          model: m,
          max_tokens: 300,
          messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: userMessage }],
        }),
      });
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) return content;
      lastErr = data?.error?.message || JSON.stringify(data).slice(0, 200);
      console.error(`LLM ${m} failed: ${lastErr.slice(0, 120)}`);
    } catch (e) { lastErr = String(e.message || e); }
  }
  return '__NO_LLM__'; // route falls back to a memory-grounded answer
}

// Deterministic, keyless, LLM-free answer built from recalled facts — used when
// there is no key or every model failed, so the demo ALWAYS shows memory working.
function memoryAnswer(recalled) {
  if (!recalled || !recalled.length) return `I don't have any memories for this user yet. Teach me 3 facts: daily meds with times, allergies, and routine.`;
  return `Here's what I remember about this person:\n- ${recalled.slice(0, 4).map((r) => String(r.text).replace(/^User\s+\S+:\s*/i, '')).join('\n- ')}\n\nConfirm with your doctor — this is not medical advice.`;
}

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { userId = 'anon', message = '' } = req.body;
    if (typeof message !== 'string' || !message.trim() || message.length > 500) {
      return res.status(400).json({ error: 'message must be 1-500 chars' });
    }
    if (typeof userId !== 'string') return res.status(400).json({ error: 'userId must be a string' });
    if (userId.length > 64) return res.status(400).json({ error: 'userId too long' });
    // Strip control chars/newlines before the id is used as a namespace or a
    // stored fact label — otherwise it is a stored-prompt-injection primitive.
    const safeUser = String(userId).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48) || 'anon';
    // Identity: signed-in onboarded wallet user → their OWN MemWal account
    // (delegate client). Everyone else → the shared anonymous channel
    // (agent account on mainnet / local stand-in in dev). Never mixed.
    const sess = sessionFromReq(req);
    const walletClient = sess ? userClientFor(sess.address) : null;
    // An expired session must NOT silently fall through to the shared channel —
    // that would write a signed-in user's private facts to a public namespace.
    if (!sess && hasSessionCookie(req)) {
      return res.status(401).json({ error: 'Your session expired — sign in again to keep using your own vault.' });
    }
    // Never silently downgrade a signed-in user to the shared channel — that would
    // write their private health facts into a world-readable namespace. Fail loud.
    if (sess && !walletClient) {
      return res.status(409).json({ error: 'Your memory vault is not linked on this server. Reconnect your wallet to finish onboarding (or re-link), then retry.' });
    }
    // Vault namespaces (w-<address>) are credential-scoped: an anonymous caller
    // must never be able to name one. Reserve the prefix for wallet sessions.
    if (!walletClient && /^(?:w-|vault-)/i.test(safeUser)) {
      return res.status(400).json({ error: 'that userId is reserved' });
    }
    const identity = walletClient ? { kind: 'wallet-owner', address: sess.address, ns: walletClient.ns } : { kind: 'shared-anon', ns: namespaceFor(safeUser) };
    const client = walletClient ? walletClient.client : clientFor(safeUser).client;
    const label = walletClient ? `User ${sess.address.slice(0, 10)}…` : `User ${safeUser}`;
    const nsKey = identity.ns;
    const history = historyFor(nsKey);

    const rr = await recallRelevantMeta(client, message, 5);
    const recalled = rr.facts;
    // FAIL CLOSED: if memory is unreachable we cannot verify allergies or
    // interactions, so refuse medication questions rather than answer unguarded.
    if (rr.degraded && mentionsDrug(message)) {
      return res.status(503).json({ error: 'Memory is temporarily unreachable, so I can\u2019t verify allergies or interactions right now. I won\u2019t answer a medication question until it loads \u2014 please retry shortly.', retryable: true });
    }
    // Coded safety nets FIRST, before any LLM output:
    //   1) allergy conflict (hard block)  2) curated drug–drug interaction.
    const conflict = findConflict(message, recalled);
    const interaction = conflict ? null : findInteraction(message, recalled);
    let reply;
    if (conflict) {
      reply = `STOP — do not give ${conflict.substance}. Recalled allergy: "${conflict.fact}"${conflict.blob_id ? ` (blob ${conflict.blob_id})` : ''}. Confirm with your doctor — this is not medical advice.`;
    } else if (interaction) {
      const lead = interaction.severity === 'high' ? 'STOP' : 'CAUTION';
      reply = `${lead} — ${interaction.substance} may interact with ${interaction.withSubstance}${interaction.blob_id ? ` (blob ${interaction.blob_id})` : ''}: ${interaction.reason}. Confirm with your doctor — this is not medical advice.`;
    } else {
      const system = buildSystemPrompt(recalled);
      reply = await callLLM(system, message, history);
      // No key, or every model failed (dead free model, out of credits, stall):
      // answer FROM MEMORY instead of leaking a debug stub.
      if (reply === '__NO_LLM__' || reply.startsWith('[LLM unavailable') || reply.startsWith('[no LLM key')) {
        reply = memoryAnswer(recalled);
      }
    }
    rememberTurn(nsKey, 'user', message);
    rememberTurn(nsKey, 'assistant', reply);
    // Auto-save AFTER generation only, and NEVER when a safety guard fired: a
    // blocked administration order must not be persisted as a durable fact.
    let saved = null, memoryPersisted = null;
    if (!conflict && !interaction && shouldRemember(message)) {
      memoryPersisted = false;
      try {
        // Dedup: skip a write only when it is near-identical to an existing fact.
        // The containment check prevents collapsing DIFFERENT facts that happen to
        // score close (e.g. "Metformin at 8pm" vs "Metformin at 9pm").
        const normText = (s) => String(s).toLowerCase().replace(/^user\s+\S+:\s*/i, '').replace(/\s+/g, ' ').trim();
        const near = await recallRelevant(client, message, 1);
        const a = normText(message), b = near.length ? normText(near[0].text) : '';
        const isDup = near.length && (near[0].distance ?? 1) < 0.15 && (a === b || a.includes(b) || b.includes(a));
        if (isDup) { saved = { blob_id: near[0].blob_id, deduped: true }; memoryPersisted = true; }
        else { saved = await rememberAndWait(client, `${label}: ${message}`); memoryPersisted = !!saved?.blob_id; }
      } catch { memoryPersisted = false; /* surfaced to the client below */ }
    }
    res.json({
      reply,
      recalled: recalled.map((r) => r.text),
      recalledMeta: recalled.map((r) => ({ text: r.text, blob_id: r.blob_id || null, distance: r.distance ?? null })),
      memoryScope: identity.ns,
      identity: identity.kind,
      savedBlob: saved?.blob_id || null,
      memoryPersisted,
      mode: MODE,
      disclaimer: 'Confirm with your doctor — this is not medical advice.',
    });
  } catch (e) { fail(res, e); }
});

app.get('/api/summary', readLimiter, async (req, res) => {
  // Doctor-visit summary compiled from recall ONLY — no chat history, no model memory.
  try {
    res.setHeader('Cache-Control', 'no-store');
    // Same shared whole-namespace read as /memory, /print, /replay (no drift).
    const view = await namespaceView(req, res);
    if (!view) return;
    const { userId, mode, recalled } = view;
    const facts = recalled.map((r) => r.text);
    const summary = {
      user: userId,
      mode,
      generatedAt: new Date().toISOString(),
      ...classifyFacts(facts),
      blobCount: facts.length,
      stale: view.degraded,
      disclaimer: 'Confirm with your doctor — this is not medical advice.',
    };
    res.json(summary);
  } catch (e) { fail(res, e); }
});

app.get('/memory', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const view = await namespaceView(req, res);
    if (!view) return;
    const { userId, mode, recalled, isVault, address } = view;
    res.send(memoryPage({
      user: isVault ? `${String(address).slice(0, 10)}… (your vault)` : userId,
      mode,
      stale: view.degraded,
      rows: recalled.map((r) => ({ text: r.text, blob_id: r.blob_id })),
      agentShort: isVault ? null : String(process.env.MEMWAL_ACCOUNT_ID || '').slice(0, 10),
    }));
  } catch (e) { res.status(500).send(`<pre>${esc(String(e.message || e))}</pre>`); }
});

app.get('/', (req, res) => {
  res.send(chatPage({ mode: MODE, model: process.env.LLM_MODEL || 'google/gemini-2.5-flash' }));
});

app.get('/demo', readLimiter, async (req, res) => {
  // LIVE before/after: same question, real recall against two namespaces.
  // demo-day1 is never seeded (empty); demo-day7 fills via POST /api/chat teaches.
  try {
    const q = 'What meds does mom take?';
    const d1 = clientFor('demo-day1');
    const d7 = clientFor('demo-day7');
    const r1 = await recallRelevant(d1.client, q, 5);
    let r7 = await recallRelevant(d7.client, q, 5);
    // AFTER side: use demo-day7 when populated (local clone-and-run via demo:seed);
    // on a fresh mainnet deploy fall back to the seeded demo-mom namespace so the
    // before/after always shows real memories. The page labels whichever is used.
    let afterNs = 'user-demo-day7';
    if (r7.length === 0) {
      const dm = clientFor('demo-mom');
      const rdm = await recallRelevant(dm.client, q, 5);
      if (rdm.length > 0) { r7 = rdm; afterNs = 'user-demo-mom'; }
    }
    res.send(demoPage({
      q,
      mode: d7.mode,
      before: r1.map((m) => ({ text: m.text, blob_id: m.blob_id })),
      after: r7.map((m) => ({ text: m.text, blob_id: m.blob_id })),
      afterNs,
      day7Empty: r7.length === 0,
    }));
  } catch (e) { res.status(500).send(`<pre>${esc(String(e.message || e))}</pre>`); }
});

// Shared multi-angle queries for whole-namespace reads.
const ALL_QUERIES = [
  'medications allergies routine family',
  'takes taking take dose pill tablet prescription mg mcg daily', // drug-agnostic
  'allergic rash avoid reaction intolerance',
  'dinner bedtime morning reminder routine',
  'daughter son doctor pharmacy emergency contact',
  'blood sugar log target fasting',
  'warfarin sertraline statin nitrate blood thinner',
];

async function namespaceView(req, res) {
  const sess = sessionFromReq(req);
  if (!sess && hasSessionCookie(req)) { res.status(401).json({ error: 'Your session expired — sign in again.' }); return null; }
  const mine = sess ? userClientFor(sess.address) : null;
  if (sess && !mine) { res.status(409).json({ error: 'Your memory vault is not linked on this server.' }); return null; }
  const userId = mine ? mine.ns.replace(/^user-/, '') : clampUser(req.query.user);
  // A wallet vault is credential-scoped: refuse to resolve it anonymously. The
  // namespace id is derivable from a public address, so it is not a secret.
  if (!mine && /^(?:w-|vault-)/i.test(userId)) { res.status(403).json({ error: 'That vault belongs to a wallet \u2014 sign in to view it.' }); return null; }
  const { client, mode } = mine ? { client: mine.client, mode: MODE } : clientFor(userId);
  const ra = await recallAllMeta(client, ALL_QUERIES, 25);
  return { userId, mode, recalled: ra.facts, degraded: ra.degraded, isVault: !!mine, address: sess?.address || null };
}

// Printable emergency card + doctor-visit summary (recall only).
app.get('/print', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const view = await namespaceView(req, res);
    if (!view) return;
    const { userId, mode, recalled } = view;
    const facts = recalled.map((r) => ({ text: r.text, blob_id: r.blob_id }));
    const byText = new Map(facts.map((r) => [r.text, r]));
    const g = classifyFacts(facts.map((r) => r.text));
    const groups = {};
    for (const k of Object.keys(g)) groups[k] = g[k].map((t) => byText.get(t) || { text: t });
    res.send(printPage({ user: userId, mode, facts, groups, stale: view.degraded, agentShort: mode === 'mainnet' ? String(process.env.MEMWAL_ACCOUNT_ID || '').slice(0, 10) : null }));
  } catch (e) { res.status(500).send(`<pre>${esc(String(e.message || e))}</pre>`); }
});

// Day 1 -> Day 90 replay (facts recalled live).
app.get('/replay', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const view = await namespaceView(req, res);
    if (!view) return;
    const { userId, mode, recalled } = view;
    res.send(replayPage({ user: userId, mode, stale: view.degraded, facts: recalled.map((r) => ({ text: r.text, blob_id: r.blob_id })) }));
  } catch (e) { res.status(500).send(`<pre>${esc(String(e.message || e))}</pre>`); }
});

// ---------------- wallet identity + per-user memory ----------------
// Sign-in: the browser asks the wallet to sign a FIXED personal message; we
// verify the signature server-side and set an HMAC session cookie. No fee.
app.get('/api/auth/message', nonceLimiter, (req, res) => {
  const { nonce, message } = issueNonce();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ nonce, message });
});

app.post('/api/auth/verify', authLimiter, async (req, res) => {
  try {
    const { address, signature, nonce } = req.body || {};
    // Single-use, short-TTL challenge: a captured signature can never be replayed.
    if (!consumeNonce(nonce)) return res.status(401).json({ error: 'sign-in challenge expired or already used — reload and try again' });
    const ok = await verifyWalletSignature({ address, signature, nonce });
    if (!ok) return res.status(401).json({ error: 'signature verification failed' });
    const secure = req.secure || (app.get('trust proxy') && req.headers['x-forwarded-proto'] === 'https');
    res.setHeader('Set-Cookie', sessionCookie(issueSession(ok.address), { secure }));
    res.json({ ok: true, address: ok.address });
  } catch (e) { fail(res, e); }
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

app.get('/api/wallet/status', readLimiter, async (req, res) => {
  try {
    const sess = sessionFromReq(req);
    if (!sess) return res.json({ signedIn: false });
    const status = await walletStatus(sess.address);
    res.json({ signedIn: true, ...status });
  } catch (e) { fail(res, e); }
});

// Onboarding step 1a (fresh users): tx bytes for create_account.
app.post('/api/wallet/onboard/create', onboardLimiter, async (req, res) => {
  try {
    const sess = sessionFromReq(req);
    if (!sess) return res.status(401).json({ error: 'sign in first' });
    res.json(await prepareCreateAccount(sess.address));
  } catch (e) { fail(res, e); }
});

// Onboarding step 1b (fresh users after tx 1; existing users): link delegate.
app.post('/api/wallet/onboard/link', onboardLimiter, async (req, res) => {
  try {
    const sess = sessionFromReq(req);
    if (!sess) return res.status(401).json({ error: 'sign in first' });
    res.json(await prepareLinkDelegate(sess.address));
  } catch (e) { fail(res, e); }
});

// Onboarding step 2: submit the visitor-signed transaction.
app.post('/api/wallet/onboard/complete', onboardLimiter, async (req, res) => {
  try {
    const sess = sessionFromReq(req);
    if (!sess) return res.status(401).json({ error: 'sign in first' });
    const { signature } = req.body || {};
    if (typeof signature !== 'string' || signature.length < 50) return res.status(400).json({ error: 'missing signature' });
    res.json(await completeOnboarding(sess.address, signature));
  } catch (e) { fail(res, e); }
});

// Recovery: re-link an account that exists onchain but is missing locally.
app.post('/api/wallet/relink', onboardLimiter, async (req, res) => {
  try {
    const sess = sessionFromReq(req);
    if (!sess) return res.status(401).json({ error: 'sign in first' });
    const out = await relinkExisting(sess.address);
    if (!out) return res.status(404).json({ error: 'no account found onchain for this address' });
    res.json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
});

// Explicit terminal 404 (keeps the security headers the middleware set; the
// default finalhandler replaces the CSP with `default-src 'none'`).
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Centralized JSON error handler (body-parser SyntaxError/413 happen before any
// route). Never leak a stack or filesystem path; keep the API contract JSON.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  const code = err?.status || err?.statusCode || 500;
  if (err?.type === 'entity.too.large' || code === 413) return res.status(413).json({ error: 'request body too large' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'malformed JSON' });
  if (code >= 500) console.error('unhandled error:', String(err?.message || err).slice(0, 200));
  res.status(code >= 400 && code < 600 ? code : 500).json({ error: code >= 500 ? 'Internal error' : String(err?.message || err) });
});

const port = process.env.PORT || 3001;
app.get('/healthz', (req, res) => res.json({ ok: true, mode: MODE, time: new Date().toISOString() }));
if (process.env.VERCEL !== '1' && import.meta.url === `file://${process.argv[1]}`) {
  const server = app.listen(port, () => console.log(`DoseDaughter on :${port}`));
  // A listen failure (EADDRINUSE) must not crash as an unhandled 'error' event.
  server.on('error', (e) => { console.error('listen error:', String((e && e.message) || e)); process.exit(1); });
  server.setTimeout(30_000); // bound slow-loris / hung sockets
}
// Last-resort visibility: never let a stray rejection/throw take the process
// down silently in a demo.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', String((e && e.message) || e).slice(0, 200)));
process.on('uncaughtException', (e) => console.error('uncaughtException:', String((e && e.message) || e).slice(0, 200)));
export default app;
