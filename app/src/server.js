// Mediara web widget — Express chatbot endpoint.
// GET / → chat UI. GET /memory?user=ID → public memory-visible page.
// GET /demo → before/after harness (empty demo-day1 vs seeded demo-day7/demo-mom).
// POST /api/chat { userId, message } → recall → LLM → auto-remember facts.
// GET /api/summary?user=ID → doctor-visit summary compiled from recall only.
// Memory backend: MEMWAL_MODE=mainnet (real Walrus Memory, needs keys) or local (default,
// file-backed stand-in with identical interface for offline development and demos).
// Wallet identity: visitors sign in with a Sui wallet (signature verified, HMAC
// session cookie); onboarded users get a per-user MemWal delegate client so chat
// memory lands in THEIR OWN MemWalAccount (they own it; app wallet never touched).
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createClient, namespaceFor, recallRelevant, recallRelevantMeta, recallAllMeta, namespaceCensus, mentionsDrug, looksLikeMedicationQuestion, memoryDegraded, withTimeout, truncateFact, hasAllergySignalExport, sanitizeChatTurn, buildSystemPrompt, rememberAndWait, rememberWithReceipt, shouldRemember, findConflict, findInteraction, classifyFacts } from './memory.js';
import { createLocalClient } from './localClient.js';
import { chatPage, memoryPage, demoPage, printPage, replayPage, comparePage, ledgerPage, landingPage, esc } from './page.js';
import { issueNonce, consumeNonce, verifyWalletSignature, issueSession, sessionFromReq, sessionCookie, clearCookie, revokeSession } from './walletAuth.js';
import { walletStatus, prepareCreateAccount, prepareLinkDelegate, completeOnboarding, relinkExisting, resetVault } from './onboarding.js';
import { createDelegateClient } from './memory.js';
import { getUser, registryStatus } from './userRegistry.js';
import { limiter, clientKey } from './rateLimit.js';
import { encryptionEnabled } from './cryptoUtils.js';
import { UsageTracker, GuardProof, morningBriefFromRecall, nightlyCrossCheckFromRecall, tickOnce } from './usage.js';
import { createStores, DEFAULT_DB_PATH } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// esc (HTML escaping) lives in page.js — single definition, no drift.
// Map an error to a status. Client-state errors carry `status` (e.g. 409 from
// onboarding); everything else is a real 500 and is logged, never echoed raw.
function fail(res, e) {
  const code = (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 600) ? e.status : 500;
  if (code >= 500) console.error('request error:', String((e && e.message) || e).slice(0, 200));
  // Pass through messages we authored (e.expose), even for 501; mask only
  // genuinely internal 5xx.
  const msg = (e && e.expose) ? String(e.message) : (code >= 500 ? 'Internal error' : String((e && e.message) || e));
  // Actionable flags our code attaches (e.data) ride along, e.g.
  // { needsRelink: true } / { retiredDeployment: true } — never secrets.
  const extra = (e && e.data && typeof e.data === 'object') ? e.data : null;
  res.status(code).json(extra ? { error: msg, ...extra } : { error: msg });
}
// A session cookie that fails to parse means EXPIRED (not anonymous). Used to
// avoid silently downgrading an expired signed-in user to the shared channel.
const hasSessionCookie = (req) => /(?:^|;\s*)dd_session=/.test(req.headers.cookie || '');
// ONE user-id normaliser shared by the write and read paths: strip control
// chars, collapse whitespace, bound length. Applied BEFORE the reserved-prefix
// check so junk prefixes ('!!vault-…', '..w-…') can't slip past the guard.
const normalizeUser = (v, fallback = 'demo-mom') => {
  const s = Array.isArray(v) ? v[0] : v;
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48) || fallback;
};
// Namespaces derived from a credential (wallet vault) or a private channel must
// never be addressable anonymously. Check the NORMALISED namespace.
const isReservedNs = (id) => /^user-(?:w-|vault-|tg-)/i.test(namespaceFor(id));

// Guests (no wallet, no forced wall) get personal memory keyed to IP+device.
// The client sends X-Device-Id (persisted UUID in localStorage); the server
// hashes it with the caller IP into a stable per-browser key:
//
//   guestKey = 'guest:' + sha256(ip + '|' + deviceId).slice(0, 12)
//
// Usage-ledger keys stay readable: wallet users keep their full `safeUser`,
// demo namespaces keep the shared `safeUser` (existing demo rules), and every
// other anonymous caller is budgeted under their `guest:<hash12>`. The device
// id is client-rotatable (never a security boundary); the IP limiter below it
// still applies. Demo namespaces are unaffected by device rotation by design.
function deviceIdFor(req) {
  const v = req.headers['x-device-id'];
  const s = Array.isArray(v) ? v[0] : v;
  const t = String(s == null ? '' : s).trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(t) ? t : 'anon';
}
function guestKeyFor(req) {
  const ip = clientKey(req);
  return 'guest:' + crypto.createHash('sha256').update(`${ip}|${deviceIdFor(req)}`).digest('hex').slice(0, 12);
}

const MODE = process.env.MEMWAL_MODE === 'mainnet' ? 'mainnet' : 'local';

// Usage evidence (hackathon requirement: ≥3 users × ≥10 memories) + the
// tamper-evident guard ledger.
//
// Store selection rule: SQLite (src/data/dosedughter.db, or DD_DB_PATH) is
// ALWAYS preferred — EXCEPT when DD_USAGE_LEDGER or DD_GUARD_PROOF is set, in
// which case the legacy JSON-file classes are used untouched. Tests isolate
// via temp JSON paths, so they keep exercising the JSON path unchanged.
function buildStores() {
  if (process.env.DD_USAGE_LEDGER || process.env.DD_GUARD_PROOF) {
    return {
      usage: new UsageTracker({ persistPath: process.env.DD_USAGE_LEDGER || path.join(__dirname, 'usage-ledger.json') }),
      guardProof: new GuardProof({ persistPath: process.env.DD_GUARD_PROOF || path.join(__dirname, 'guard-proof.json') }),
    };
  }
  return createStores({ dbPath: process.env.DD_DB_PATH || DEFAULT_DB_PATH });
}
const { usage, guardProof } = buildStores();

// Reuse MemWal clients: constructing one per request repeats the relayer
// /version + /config + Seal-session handshake (~3s) on every mainnet call. Cache
// by key with a TTL below the Seal session expiry (5 min).
const CLIENT_TTL_MS = 4 * 60 * 1000;
const clientCache = new Map();
// A 401 is almost always client-state (stale Seal session, rotated key), not a
// dead relayer: evict the cached client and retry ONCE with a fresh handshake
// instead of serving degraded reads for up to 4 minutes on a broken client.
// Any other error (or a second 401) propagates to the normal degraded path.
function isAuthFailure(e) {
  return /\b401\b|unauthorized|forbidden|invalid signature|wrong private key/i.test(String((e && e.message) || e));
}
function wrapRecallRecovery(key, make, client) {
  if (!client || typeof client.recall !== 'function' || client.__recallWrapped) return client;
  const inner = client.recall.bind(client);
  const wrapped = Object.create(client);
  wrapped.recall = async (params) => {
    try {
      return await inner(params);
    } catch (e) {
      if (!isAuthFailure(e)) throw e;
      clientCache.delete(key); // drop the poisoned client first — never reuse it
      const retryClient = make();
      // Cache the WRAPPED client for future requests, but retry this call on
      // the raw client: exactly one recovery attempt, never recursion.
      clientCache.set(key, { client: wrapRecallRecovery(key, make, retryClient), at: Date.now() });
      return retryClient.recall(params);
    }
  };
  Object.defineProperty(wrapped, '__recallWrapped', { value: true });
  return wrapped;
}
export function __cachedClientForTest(key, make) { return cachedClient(key, make); }
function cachedClient(key, make) {
  const now = Date.now();
  const hit = clientCache.get(key);
  if (hit && now - hit.at < CLIENT_TTL_MS) return hit.client;
  const client = wrapRecallRecovery(key, make, make());
  clientCache.set(key, { client, at: now });
  if (clientCache.size > 500) { for (const k of clientCache.keys()) { clientCache.delete(k); if (clientCache.size <= 400) break; } }
  return client;
}
// Exported for tests only: poisoning the cache must be observable + recoverable.
export function __evictClientForTest(key) { clientCache.delete(key); }
export function __cacheSizeForTest() { return clientCache.size; }

function clientFor(userId) {
  const ns = namespaceFor(userId);
  if (MODE === 'mainnet') return { client: cachedClient(`m:${ns}`, () => createClient({ namespace: ns })), mode: 'mainnet' };
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
    ? cachedClient(`d:${user.accountId}:${ns}`, () => createDelegateClient({ delegatePrivateKey: user.delegatePrivateKey, accountId: user.accountId, namespace: ns }))
    : createLocalClient({ namespace: ns });
  return { client, ns };
}

const app = express();
app.disable('x-powered-by');
// Trust exactly one proxy hop (the platform edge) so req.ip is the real client.
// With no proxy (local dev) leave it off — never trust client-supplied XFF.
// Parse TRUST_PROXY explicitly and FAIL CLOSED on anything unrecognised: a typo
// must never widen proxy trust (which would make every limiter spoofable).
const tp = process.env.TRUST_PROXY;
let trustProxy;
if (tp === undefined || tp === '') trustProxy = process.env.VERCEL === '1' ? 1 : false;
else if (/^(?:0|false|off|no)$/i.test(tp)) trustProxy = false;
else if (/^\d+$/.test(tp)) trustProxy = Number(tp);
else { console.warn(`TRUST_PROXY="${tp}" not understood — defaulting to false (client headers NOT trusted)`); trustProxy = false; }
app.set('trust proxy', trustProxy);
// Security headers on every response. CSP blocks inline scripts AND every
// external origin (UI JS is served from /assets; only inline styles allowed).
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
// React SPA bundle (Vite build in app/web/dist, served under /app). Hashed
// filenames are immutable; index.html is served explicitly at / (never cached).
const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');
app.use('/app', express.static(WEB_DIST, { maxAge: '1y', index: false, immutable: true, redirect: false }));
// 16 KB JSON bodies — chat messages and tx signatures are tiny; anything
// larger is abuse. (Express's json parser rejects oversize with 413.)
app.use(express.json({ limit: '16kb' }));

// Rate limits (fixed-window, per IP).
// Limits are env-overridable so tests can raise them (defaults are production).
const L = (name, dflt) => Number(process.env[name]) > 0 ? Number(process.env[name]) : dflt;
const authLimiter = limiter({ keyFn: (req) => `auth:${clientKey(req)}`, limit: L('DD_AUTH_LIMIT', 10), windowMs: 60_000 });
const onboardLimiter = limiter({ keyFn: (req) => `ob:${clientKey(req)}`, limit: L('DD_ONBOARD_LIMIT', 12), windowMs: 60_000 });
const chatLimiter = limiter({ keyFn: (req) => `chat:${clientKey(req)}`, limit: L('DD_CHAT_LIMIT', 30), windowMs: 60_000 });
// Read routes fan out to several recall queries; cap them too (audit M9).
const readLimiter = limiter({ keyFn: (req) => `read:${clientKey(req)}`, limit: L('DD_READ_LIMIT', 60), windowMs: 60_000 });
// Nonce minting is cheap but unbounded; cap it (the nonce Map would otherwise grow).
const nonceLimiter = limiter({ keyFn: (req) => `nonce:${clientKey(req)}`, limit: L('DD_NONCE_LIMIT', 30), windowMs: 60_000 });
const logoutLimiter = limiter({ keyFn: (req) => `logout:${clientKey(req)}`, limit: L('DD_LOGOUT_LIMIT', 30), windowMs: 60_000 });

// Bounded per-namespace conversation transcript so the model sees recent turns,
// not just recalled facts (facts are durable; this is ephemeral context).
const transcripts = new Map();
// A per-browser client id isolates transcripts so two anonymous visitors who
// happen to share a namespace cannot read each other's un-persisted turns.
function clientId(req, res) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)dd_cid=([A-Za-z0-9_-]{8,64})/);
  if (m) return m[1];
  const id = crypto.randomBytes(12).toString('base64url');
  res.append('Set-Cookie', `dd_cid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  return id;
}
function historyFor(ns) { return transcripts.get(ns) || []; }
function rememberTurn(ns, role, content) {
  const h = transcripts.get(ns) || [];
  // Neutralise tag delimiters so a prior turn cannot break out of its chat role
  // framing and masquerade as system instructions.
  h.push({ role, content: sanitizeChatTurn(content) });
  while (h.length > 6) h.shift();
  transcripts.set(ns, h);
  // Bounded LRU: evict oldest instead of wiping everyone's context.
  while (transcripts.size > 5000) transcripts.delete(transcripts.keys().next().value);
}

async function callLLM(system, userMessage, history = [], modelOverride) {
  // OpenRouter free-tier default (verified against the live /models free list;
  // all non-OpenAI/Anthropic, so Beyond-Big-Two eligible). Falls back to echo if no key.
  // Resilience: explicit max_tokens, then free-model fallback chain on 402/429
  // so the demo NEVER dies mid-judge-test. Errors stay graceful.
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = modelOverride || process.env.LLM_MODEL || FREE_DEFAULT;
  if (!apiKey) return { text: '__NO_LLM__', model: null };
  // Free-model fallback chain (verified 2026-10-07 against the live free list).
  const models = [model, 'google/gemma-4-31b-it:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'google/gemma-4-26b-a4b-it:free', 'liquid/lfm-2.5-2.6b:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'openrouter/free'].filter((m, i, a) => a.indexOf(m) === i);
  let lastErr = '';
  // Overall budget across the whole chain so one stalled provider can't run for
  // 6 × 15s; the socket timeout is 120s, so the handler must return well before.
  const deadline = Date.now() + 25_000;
  for (const m of models) {
    if (Date.now() > deadline) break;
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(Math.max(2000, Math.min(15_000, deadline - Date.now()))),
        body: JSON.stringify({
          model: m,
          max_tokens: 300,
          messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: userMessage }],
        }),
      });
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) return { text: content, model: m };
      lastErr = data?.error?.message || JSON.stringify(data).slice(0, 200);
      console.error(`LLM ${m} failed: ${lastErr.slice(0, 120)}`);
    } catch (e) { lastErr = String(e.message || e); }
  }
  return { text: '__NO_LLM__', model: null }; // route falls back to a memory-grounded answer
}

// Human-readable model name for user-visible reasoning (mirrors the client's
// prettyModel; server can't import tsx). 'google/gemma-4-31b-it:free' -> 'Gemma 4 31B'.
function prettyModelName(id) {
  const s = String(id || '');
  if (/^openrouter\/free$/i.test(s)) return 'Auto';
  const base = (s.split('/').pop() || s).replace(/:free$/i, '');
  return base.split('-').filter((p) => !/^(it|free|preview)$/i.test(p))
    .map((p) => (/^[a-z]*\d/i.test(p) && /[a-z]/i.test(p)) || /^\d/i.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ').replace(/\s+/g, ' ').trim() || s;
}

// Deterministic, keyless, LLM-free answer built from recalled facts — used when
// there is no key or every model failed, so the demo ALWAYS shows memory working.
function memoryAnswer(recalled) {
  if (!recalled || !recalled.length) return `I don't have any memories for this user yet. Teach me 3 facts: daily meds with times, allergies, and routine.`;
  return `Here's what I remember about this person:\n- ${recalled.slice(0, 4).map((r) => String(r.text).replace(/^User\s+\S+:\s*/i, '')).join('\n- ')}\n\nConfirm with your doctor — this is not medical advice.`;
}

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const { userId = 'anon', message = '', model: reqModel } = req.body;
    // Free-only picker: unknown/paid models are rejected, never silently swapped.
    let model = undefined;
    if (reqModel !== undefined) {
      if (!(await isFreeModel(reqModel))) {
        return res.status(400).json({ error: 'unknown model — pick one from the model list' });
      }
      model = reqModel;
    }
    const effectiveModel = model || process.env.LLM_MODEL || FREE_DEFAULT;
    // One-toggle amnesia: memory=off skips recall AND the guards, so the same bot
    // can be shown with and without memory — the rubric's before/after.
    const memoryOff = req.body.memory === false || req.body.memory === 'off' || req.query.memory === 'off';
    if (typeof message !== 'string' || !message.trim() || message.length > 500) {
      return res.status(400).json({ error: 'message must be 1-500 chars' });
    }
    if (typeof userId !== 'string') return res.status(400).json({ error: 'userId must be a string' });
    if (userId.length > 64) return res.status(400).json({ error: 'userId too long' });
    // Strip control chars/newlines before the id is used as a namespace or a
    // stored fact label — otherwise it is a stored-prompt-injection primitive.
    const safeUser = normalizeUser(userId, 'anon');
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
    // Shared demo namespaces are READ-ONLY for anonymous callers: anyone may
    // ask (recall + guards run), but nobody without a wallet vault can write
    // into the premade demo memory. Signed-in vault writes are unaffected.
    const DEMO_READONLY = new Set(['demo-mom', 'demo-day7', 'demo-day1']);
    const demoReadonly = !walletClient && DEMO_READONLY.has(safeUser);
    // Rolling budget gate: DEMO + ANON channels roll on a 24h sliding window
    // (per-key turn timestamps, last 50 kept) so one user cannot burn the
    // shared OpenRouter/Walrus budget (free tiers are rate-limited upstream).
    // Anonymous shared channel: DD_DAY_LIMIT_ANON (default 20) — EXCEPT inside
    // the shared demo namespaces (demo-mom/demo-day7/demo-day1), which cap at
    // DD_DAY_LIMIT_DEMO (default 10) no matter how high DD_DAY_LIMIT_ANON is
    // set, so the premade demo cannot be burned down. Signed-in vault users
    // keep the legacy UTC-day bucket: DD_DAY_LIMIT_WALLET (default 200).
    // Judges keep the ready-made demo namespace either way; the demo
    // namespaces stay read-only for anonymous writers regardless of budget.
    // NOTE: current spend is $0 (sponsored writes + free models) — this gate
    // guards rate, not money. User-pays billing is a future decision, see docs.
    const dayCap = (name, dflt) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : dflt);
    const cap = walletClient
      ? dayCap('DD_DAY_LIMIT_WALLET', 200)
      : (DEMO_READONLY.has(safeUser) ? dayCap('DD_DAY_LIMIT_DEMO', 10) : dayCap('DD_DAY_LIMIT_ANON', 20));
    // Budget identity: wallet users spend as themselves, demo namespaces spend
    // as the shared demo id (existing demo rules), everyone else spends as
    // their per-browser guest key — one IP with N browsers gets N budgets.
    const budgetKey = walletClient || DEMO_READONLY.has(safeUser) ? safeUser : guestKeyFor(req);
    // Wallet stays on the UTC-day bucket; demo + anon roll on the 24h window.
    const budgetMode = walletClient ? { mode: 'daily' } : undefined;
    const nextUtcMidnightIso = () => {
      const d = new Date();
      d.setUTCHours(24, 0, 0, 0);
      return d.toISOString();
    };
    let chk = { ok: true, used: 0, remaining: cap, reset: null, resetAt: null, resetInHrs: null };
    try {
      chk = usage.checkDay(budgetKey, cap, budgetMode);
    } catch { /* fail open on ledger errors — the IP limiter below still applies */ }
    if (!chk.ok) {
      const walletResetAt = nextUtcMidnightIso();
      return res.status(429).json({
        error: walletClient
          ? `You've used your ${cap} daily messages — limit resets at UTC midnight.`
          : DEMO_READONLY.has(safeUser)
            ? `You've used your ${cap} demo messages — sign in with your Sui wallet for a bigger budget and your own vault.`
            : `You've used your ${cap} guest messages — sign in with your Sui wallet for a bigger budget and your own vault.`,
        loginRequired: !walletClient,
        demoUser: 'demo-mom',
        remaining: 0,
        resetsAt: chk.reset,
        resetAt: walletClient ? walletResetAt : (chk.resetAt || null),
        resetInHrs: walletClient ? Math.max(1, Math.ceil((Date.parse(walletResetAt) - Date.now()) / 3_600_000)) : (chk.resetInHrs ?? null),
      });
    }
    // Vault namespaces (w-<address>) are credential-scoped: an anonymous caller
    // must never be able to name one. Reserve the prefix for wallet sessions.
    if (!walletClient && isReservedNs(safeUser)) {
      return res.status(400).json({ error: 'that userId is reserved' });
    }
    const identity = walletClient ? { kind: 'wallet-owner', address: sess.address, ns: walletClient.ns } : { kind: 'shared-anon', ns: namespaceFor(safeUser) };
    const client = walletClient ? walletClient.client : clientFor(safeUser).client;
    const label = walletClient ? `User ${sess.address.slice(0, 10)}…` : `User ${safeUser}`;
    const nsKey = `${identity.ns}:${clientId(req, res)}`;
    const history = historyFor(nsKey);

    // Recall a wide set for the GUARDS (so presentation trimming / poisoning can
    // never evict the allergy fact a STOP depends on), but show only the top 5.
    const rr = memoryOff ? { facts: [], degraded: false } : await recallRelevantMeta(client, message, 25);
    // Dead vault credential (the relayer 401s this wallet's delegate key):
    // retrying the same key can never succeed, so fail actionable (re-link)
    // instead of the generic "retry shortly" 503. Shared-channel outages keep
    // the honest 503 below. memoryOff never touches the delegate, unaffected.
    if (!memoryOff && walletClient && rr.authFailure) {
      return res.status(409).json({
        error: 'Your vault link was rejected by the memory network — the delegate key on file is not registered on your account. Re-link your wallet (one signature) and retry.',
        needsRelink: true,
      });
    }
    const guardFacts = rr.facts;
    let recalled = rr.facts.slice(0, 5);
    // Visible reasoning trace (DeepSeek-style "thinking", but real): every
    // step below is data this request actually computed — nothing inferred.
    const thinking = [];
    thinking.push(memoryOff
      ? { label: 'Recall', detail: 'Memory is OFF for this turn (before/after demo) — recall and both guards skipped.' }
      : { label: 'Recall', detail: `3 query angles (your words + allergy sweep + medication sweep) → ${guardFacts.length} candidate facts for the guards, top ${recalled.length} shown${rr.degraded ? ' (memory degraded — stale read)' : ''}.` });
    // "What do you remember?" must return the WHOLE namespace, not a query subset.
    if (/\bwhat\s+do\s+you\s+(?:remember|know)\b|\bremember\s+about\b|\brecap\b|\bso\s+far\b|\bwhat\s+did\s+i\s+(?:tell|say)\b/i.test(message)) {
      try { const full = await recallAllMeta(client, ALL_QUERIES, 25); if (full.facts.length) recalled = full.facts; } catch { /* keep the query recall */ }
    }
    // A memory recap ("what do you remember?") is not an advice question, so it
    // is exempt from the fail-closed below — but it must say UNREACHABLE,
    // never "I don't have any memories" (that would deny stored facts).
    const isRecap = /\bwhat\s+do\s+you\s+(?:remember|know)\b|\bremember\s+about\b|\brecap\b|\bso\s+far\b|\bwhat\s+did\s+i\s+(?:tell|say)\b/i.test(message);
    // FAIL CLOSED: if memory is unreachable we cannot verify allergies or
    // interactions, so refuse medication questions rather than answer unguarded.
    if (rr.degraded && looksLikeMedicationQuestion(message) && !isRecap) {
      return res.status(503).json({ error: 'Memory is temporarily unreachable, so I can\u2019t verify allergies or interactions right now. I won\u2019t answer a medication question until it loads \u2014 please retry shortly.', retryable: true });
    }
    if (rr.degraded && isRecap) {
      thinking.push({ label: 'Recall', detail: 'Memory unreachable — answering honestly instead of pretending to be empty.' });
      const reply = 'Memory is temporarily unreachable, so I can\u2019t load your memories right now — please retry shortly. Nothing was answered from memory.';
      rememberTurn(nsKey, 'user', message);
      rememberTurn(nsKey, 'assistant', reply);
      usage.touchUser(budgetKey, { turn: true });
      let recapBudget = { used: (chk.used || 0) + 1, cap, remaining: Math.max(0, cap - (chk.used || 0) - 1), resetAt: chk.resetAt || null };
      try {
        const post = usage.checkDay(budgetKey, cap, budgetMode);
        recapBudget = { used: post.used, cap, remaining: post.remaining, resetAt: post.resetAt || null };
      } catch { /* fail open — budget snapshot best-effort */ }
      return res.json({
        reply, recalled: [], recalledMeta: [], memoryScope: identity.ns,
        identity: identity.kind, savedBlob: null, memoryPersisted: null,
        memoryOff, thinking, mode: MODE,
        disclaimer: 'Confirm with your doctor — this is not medical advice.',
        budget: recapBudget,
      });
    }
    // Coded safety nets FIRST, before any LLM output:
    //   1) allergy conflict (hard block)  2) curated drug–drug interaction.
    const conflict = memoryOff ? null : findConflict(message, guardFacts);
    const interaction = (memoryOff || conflict) ? null : findInteraction(message, guardFacts);
    if (memoryOff) {
      thinking.push({ label: 'Allergy guard', detail: 'Skipped (memory off).' });
      thinking.push({ label: 'Interaction guard', detail: 'Skipped (memory off).' });
    } else if (conflict) {
      thinking.push({ label: 'Allergy guard', detail: `MATCH on “${conflict.substance}” from recalled fact${conflict.blob_id ? ` (blob ${conflict.blob_id})` : ''} — STOP issued before any LLM output.` });
      thinking.push({ label: 'Interaction guard', detail: 'Skipped (allergy guard already fired).' });
    } else {
      thinking.push({ label: 'Allergy guard', detail: `No match across ${guardFacts.length} recalled facts.` });
      thinking.push(interaction
        ? { label: 'Interaction guard', detail: `MATCH: ${interaction.substance} × ${interaction.withSubstance} (${interaction.severity})${interaction.blob_id ? ` (blob ${interaction.blob_id})` : ''} — ${interaction.reason}.` }
        : { label: 'Interaction guard', detail: `No match across ${guardFacts.length} recalled facts.` });
    }
    // Public proof: every fired guard is appended to the tamper-evident ledger
    // (/guard-proof) with the exact recalled fact + blob id behind the decision.
    if (conflict) guardProof.record({ userId: safeUser, kind: 'conflict', substance: conflict.substance, severity: 'high', reason: 'recalled allergy', fact: conflict.fact, blobId: conflict.blob_id, message });
    if (interaction) guardProof.record({ userId: safeUser, kind: 'interaction', substance: interaction.substance, withSubstance: interaction.withSubstance, severity: interaction.severity, reason: interaction.reason, fact: interaction.fact, blobId: interaction.blob_id, message });
    let reply, answerSource = 'guard';
    if (conflict) {
      reply = `STOP — do not give ${conflict.substance}. Recalled allergy: "${conflict.fact}"${conflict.blob_id ? ` (blob ${conflict.blob_id})` : ''}. Confirm with your doctor — this is not medical advice.`;
      thinking.push({ label: 'Answer', detail: 'Deterministic guard template — no LLM involved in a STOP.' });
    } else if (interaction) {
      const lead = interaction.severity === 'high' ? 'STOP' : 'CAUTION';
      reply = `${lead} — ${interaction.substance} may interact with ${interaction.withSubstance}${interaction.blob_id ? ` (blob ${interaction.blob_id})` : ''}: ${interaction.reason}. Confirm with your doctor — this is not medical advice.`;
      thinking.push({ label: 'Answer', detail: 'Deterministic guard template — no LLM involved in a STOP/CAUTION.' });
    } else {
      const system = buildSystemPrompt(recalled);
      const llm = await callLLM(system, message, history, model);
      reply = llm.text;
      // No key, or every model failed (dead free model, out of credits, stall):
      // answer FROM MEMORY instead of leaking a debug stub.
      if (reply === '__NO_LLM__' || reply.startsWith('[LLM unavailable') || reply.startsWith('[no LLM key')) {
        reply = memoryAnswer(recalled);
        answerSource = 'memory-fallback';
        thinking.push({ label: 'Answer', detail: `No LLM reachable — answered from the ${recalled.length} recalled facts above.` });
      } else {
        answerSource = 'llm';
        thinking.push({ label: 'Answer', detail: `${prettyModelName(llm.model || effectiveModel)} answered with the ${recalled.length} recalled facts in context (guards already ran first).` });
      }
    }
    rememberTurn(nsKey, 'user', message);
    rememberTurn(nsKey, 'assistant', reply);
    // Auto-save AFTER generation only, and NEVER when a safety guard fired: a
    // blocked administration order must not be persisted as a durable fact.
    let saved = null, memoryPersisted = null;
    if (memoryOff) {
      thinking.push({ label: 'Memory write', detail: 'Skipped (memory off for this turn).' });
    } else if (demoReadonly) {
      thinking.push({ label: 'Memory write', detail: 'Skipped — the shared demo is read-only. Sign in with your Sui wallet to save your own memories.' });
    } else if (conflict || interaction) {
      thinking.push({ label: 'Memory write', detail: 'Skipped — a fired guard means this turn is never stored as a fact.' });
    } else if (!shouldRemember(message)) {
      thinking.push({ label: 'Memory write', detail: 'Skipped — not a durable fact (chit-chat, question, or no save signal).' });
    }
    if (!memoryOff && !demoReadonly && !conflict && !interaction && shouldRemember(message)) {
      memoryPersisted = false;
      try {
        // Dedup: skip a write only when it is near-identical to an existing fact.
        // The containment check prevents collapsing DIFFERENT facts that happen to
        // score close (e.g. "Metformin at 8pm" vs "Metformin at 9pm").
        const normText = (s) => String(s).toLowerCase().replace(/^user\s+\S+:\s*/i, '').replace(/\s+/g, ' ').trim();
        const nearMeta = await recallRelevantMeta(client, message, 1);
        const near = nearMeta.degraded ? [] : nearMeta.facts; // no dedup against a broken relayer
        const a = normText(message), b = near.length ? normText(near[0].text) : '';
        const isDup = near.length && (near[0].distance ?? 1) < 0.15 && (a === b || a.includes(b) || b.includes(a));
        if (isDup) { saved = { blob_id: near[0].blob_id, deduped: true }; memoryPersisted = true; thinking.push({ label: 'Memory write', detail: `Skipped — near-identical fact already stored${near[0].blob_id ? ` (blob ${near[0].blob_id})` : ''}.` }); }
        else {
          // Never store a fact that lost its safety signal to truncation — a
          // truncated allergy is silent amnesia.
          const stored = truncateFact(`${label}: ${message}`);
          const lostSignal = (hasAllergySignalExport(message) || mentionsDrug(message)) && !(hasAllergySignalExport(stored) || mentionsDrug(stored));
          if (lostSignal) {
            memoryPersisted = false;
            console.error('write skipped: fact truncated past its safety signal');
            thinking.push({ label: 'Memory write', detail: 'Skipped — the message was too long and truncation cut its safety signal.' });
            reply += ' (Note: that was too long to save — please resend the allergy/medication in one short sentence.)';
          }
          else if (MODE === 'mainnet') {
            // Mainnet indexing (~50s) exceeds any sane chat budget: accept fast,
            // wait bounded, and be honest about pending (never fake a blob).
            const rec = await rememberWithReceipt(client, stored);
            if (rec.status === 'saved') {
              saved = { blob_id: rec.blob_id }; memoryPersisted = true;
              thinking.push({ label: 'Memory write', detail: `Saved to Walrus (blob ${rec.blob_id}).` });
            } else if (rec.status === 'pending') {
              memoryPersisted = 'pending';
              thinking.push({ label: 'Memory write', detail: 'Upload accepted — Walrus is still indexing, so no blob id yet. It will appear under Memory shortly.' });
              reply += ' (Saving to memory — it will appear under Memory shortly.)';
              // Record usage when the index lands (fire-and-forget, rejection-safe).
              rec.done.then((b) => { if (b) usage.recordMemory(safeUser, { blobId: b, text: message }); }).catch(() => {});
            } else {
              memoryPersisted = false;
              thinking.push({ label: 'Memory write', detail: `Write failed (${rec.error || 'upload rejected'}) — surfaced, not silently kept.` });
            }
          }
          else { saved = await withTimeout(rememberAndWait(client, stored), 15_000, 'remember'); memoryPersisted = !!saved?.blob_id; thinking.push({ label: 'Memory write', detail: saved?.blob_id ? `Saved to Walrus (blob ${saved.blob_id}).` : 'Write attempted but no blob returned.' }); }
        }
      } catch { memoryPersisted = false; thinking.push({ label: 'Memory write', detail: 'Skipped — the write failed and was surfaced, not silently kept.' }); /* surfaced to the client below */ }
    }
    // Never deny memory we just stored: if the (keyless) reply says we know
    // nothing but a fact was saved this turn, acknowledge it.
    if (saved?.blob_id && /^I don't have any memories/i.test(reply)) {
      reply = `Noted \u2014 I'll remember: \u201c${message}\u201d. Confirm with your doctor \u2014 this is not medical advice.`;
    }
    // Usage evidence: only REAL chat turns and only blobs Walrus actually
    // returned are counted — `npm run stats` reads this same ledger.
    usage.touchUser(budgetKey, { turn: true });
    if (saved?.blob_id) usage.recordMemory(safeUser, { blobId: saved.blob_id, text: message });
    // Rolling budget snapshot for the client (best-effort — never fails chat).
    let turnBudget = { used: (chk.used || 0) + 1, cap, remaining: Math.max(0, cap - (chk.used || 0) - 1), resetAt: chk.resetAt || null };
    try {
      const post = usage.checkDay(budgetKey, cap, budgetMode);
      turnBudget = { used: post.used, cap, remaining: post.remaining, resetAt: post.resetAt || null };
    } catch { /* fail open — budget snapshot best-effort */ }

    res.json({
      reply,
      recalled: recalled.map((r) => r.text),
      recalledMeta: recalled.map((r) => ({ text: r.text, blob_id: r.blob_id || null, distance: r.distance ?? null })),
      memoryScope: identity.ns,
      identity: identity.kind,
      savedBlob: saved?.blob_id || null,
      memoryPersisted,
      memoryOff,
      thinking,
      mode: MODE,
      disclaimer: 'Confirm with your doctor — this is not medical advice.',
      budget: turnBudget,
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
      allergiesKnown: !view.degraded,
      medicationsKnown: !view.degraded,
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
  } catch (e) { console.error('page error:', String((e && e.message) || e).slice(0, 200)); res.status(500).send('<pre>Something went wrong loading this page. Please retry.</pre>'); }
});

// Landing at / (server-rendered premium dark hero, zero JS) + the React SPA
// at /app (vite base '/app/'; hash routing means /app + static /app/* cover
// every view). Legacy compat routes (/memory, /demo, /print, …) untouched.
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let demoBlobs = 0, guardCount = 0;
    try { demoBlobs = usage.snapshot('demo-mom').memories || 0; } catch { /* evidence best-effort */ }
    try { guardCount = guardProof.entries.length || 0; } catch { /* evidence best-effort */ }
    res.send(landingPage({ mode: MODE, demoBlobs, guardCount }));
  } catch {
    res.send(chatPage({ mode: MODE }));
  }
});

function sendSpa(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.send(fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8'));
  } catch {
    res.send(chatPage({ mode: MODE }));
  }
}
app.get('/app', sendSpa);
app.get('/app/*', sendSpa);

app.get('/demo', readLimiter, async (req, res) => {
  // LIVE before/after: same question, real recall against two namespaces.
  // demo-day1 is never seeded (empty); demo-day7 fills via POST /api/chat teaches.
  try {
    res.setHeader('Cache-Control', 'no-store');
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
  } catch (e) { console.error('page error:', String((e && e.message) || e).slice(0, 200)); res.status(500).send('<pre>Something went wrong loading this page. Please retry.</pre>'); }
});

// Shared multi-angle queries for whole-namespace reads.
// Last-known-good whole-namespace reads, served (stale-labelled) during an outage.
const lastGood = new Map(); // userId -> { facts, at }
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
  const userId = mine ? mine.ns.replace(/^user-/, '') : normalizeUser(req.query.user);
  // A wallet vault is credential-scoped: refuse to resolve it anonymously. The
  // namespace id is derivable from a public address, so it is not a secret.
  if (!mine && isReservedNs(userId)) { res.status(403).json({ error: 'That vault belongs to a wallet \u2014 sign in to view it.' }); return null; }
  const { client, mode } = mine ? { client: mine.client, mode: MODE } : clientFor(userId);
  const ns = mine ? mine.ns : namespaceFor(userId);
  const ra = await recallAllMeta(client, ALL_QUERIES, 25);
  // Last-known-good cache: on an outage, serve the most recent successful read
  // (labelled stale) rather than a blank card — a safety product should show
  // stale-but-labelled allergies, not "UNKNOWN".
  if (!ra.degraded && ra.facts.length) {
    lastGood.set(userId, { facts: ra.facts, at: Date.now() });
    while (lastGood.size > 1000) lastGood.delete(lastGood.keys().next().value);
  }
  let facts = ra.facts;
  if (ra.degraded) {
    const lg = lastGood.get(userId);
    if (lg && Date.now() - lg.at < 10 * 60 * 1000) facts = lg.facts;
  }
  return { userId, mode, recalled: facts, degraded: ra.degraded, isVault: !!mine, address: sess?.address || null, ns, client };
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
  } catch (e) { console.error('page error:', String((e && e.message) || e).slice(0, 200)); res.status(500).send('<pre>Something went wrong loading this page. Please retry.</pre>'); }
});

// Day 1 -> Day 90 replay (facts recalled live).
app.get('/replay', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const view = await namespaceView(req, res);
    if (!view) return;
    const { userId, mode, recalled } = view;
    res.send(replayPage({ user: userId, mode, stale: view.degraded, facts: recalled.map((r) => ({ text: r.text, blob_id: r.blob_id })) }));
  } catch (e) { console.error('page error:', String((e && e.message) || e).slice(0, 200)); res.status(500).send('<pre>Something went wrong loading this page. Please retry.</pre>'); }
});

// Cross-user isolation proof: one question, two namespaces, side by side.
app.get('/compare', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const a = normalizeUser(req.query.a, 'demo-mom');
    const b = normalizeUser(req.query.b, 'demo-day7');
    if (isReservedNs(a) || isReservedNs(b)) return res.status(403).send('Reserved namespace.');
    const q = 'What medications and allergies does this person have?';
    const ra = await recallAllMeta(clientFor(a).client, ALL_QUERIES, 15);
    const rb = await recallAllMeta(clientFor(b).client, ALL_QUERIES, 15);
    res.send(comparePage({ q, mode: MODE, a, b, aFacts: ra.facts, bFacts: rb.facts }));
  } catch (e) { console.error('compare error:', String((e && e.message) || e).slice(0, 160)); res.status(500).send('<pre>Something went wrong loading this page. Please retry.</pre>'); }
});

// Machine-readable export (feeds the article / submission evidence).
app.get('/api/export', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const view = await namespaceView(req, res);
    if (!view) return;
    res.json({
      user: view.userId, mode: view.mode,
      agentId: process.env.MEMWAL_ACCOUNT_ID || null,
      blobCount: view.recalled.length,
      facts: view.recalled.map((r) => ({ text: r.text, blob_id: r.blob_id || null })),
    });
  } catch (e) { fail(res, e); }
});

// Usage evidence (hackathon requirement ≥3 users × ≥10 memories): JSON view.
//
// PRIVACY RULE: counts + requirement are public, but per-blob TEXT is private.
// `users[].blobs[].text` is included ONLY for namespaces the caller owns —
// i.e. a wallet session whose vault namespace matches the snapshot's
// namespace. Anonymous callers (and signed-in callers viewing anyone else's
// namespace) get `{ blobId, link }` with `text: null`: enough to verify the
// count, never enough to read someone else's health facts.
app.get('/api/usage', readLimiter, (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const wantsMd = String(req.query.format || '') === 'md';
    const sess = sessionFromReq(req);
    const mine = sess ? userClientFor(sess.address) : null;
    const ownedNs = mine ? mine.ns : null;
    const redactUser = (id) => !(ownedNs && namespaceFor(id) === ownedNs);
    const s = usage.summary({ mode: MODE, redactUser });
    const users = (s.json.users || []).map((u) => {
      if (ownedNs && u.namespace === ownedNs) return u;
      return { ...u, blobs: (u.blobs || []).map((b) => ({ ...b, text: null })) };
      // NOTE: markdown is redacted inside summary() via the same predicate.
    });
    res.json({ ...s.json, users, markdown: wantsMd ? s.md : undefined });
  } catch (e) { fail(res, e); }
});

app.get('/api/dashboard', readLimiter, async (req, res) => {
  // Per-user dashboard: demo readiness + personal budget/memories + vault state.
  // Same auth/namespace rules as /api/summary (shared namespaceView: expired
  // sessions 401, unlinked vaults 409, anonymous vault peeks 403).
  try {
    res.setHeader('Cache-Control', 'no-store');
    const view = await namespaceView(req, res);
    if (!view) return;
    const { userId, mode } = view;
    const dayCap = (name, dflt) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : dflt);
    const isDemoNs = ['demo-mom', 'demo-day7', 'demo-day1'].includes(userId);
    const cap = view.isVault
      ? dayCap('DD_DAY_LIMIT_WALLET', 200)
      : (isDemoNs ? dayCap('DD_DAY_LIMIT_DEMO', 10) : dayCap('DD_DAY_LIMIT_ANON', 20));
    // Same budget identity as /api/chat: vault + demo namespaces spend as the
    // user id, anonymous guests spend as their per-browser guest key. The
    // personal turn/budget readout follows the SAME key (a guest sees their
    // own activity); blob evidence stays keyed by namespace (recordMemory
    // uses safeUser, so /api/usage + stats attribution is unchanged).
    // Wallet reads the UTC-day bucket; demo + anon read the 24h window.
    const budgetKey = (view.isVault || isDemoNs) ? userId : guestKeyFor(req);
    const budgetMode = view.isVault ? { mode: 'daily' } : undefined;
    let chk = { ok: true, used: 0, remaining: cap, reset: null, resetAt: null, resetInHrs: null };
    try { chk = usage.checkDay(budgetKey, cap, budgetMode); } catch { /* fail open — budget unknown, not fatal */ }
    const snap = usage.snapshot(budgetKey);
    // guardHits works on both store impls (SQLite has countByUser; the JSON
    // ledger is filtered from list()).
    const guardHits = typeof guardProof.countByUser === 'function'
      ? guardProof.countByUser(userId)
      : guardProof.list({ limit: 100000 }).filter((e) => e.userId === userId).length;
    // Demo readiness: the shared demo-mom namespace, read live (recall only).
    let demoBlobs = 0;
    try {
      const ra = await recallAllMeta(clientFor('demo-mom').client, ALL_QUERIES, 25);
      demoBlobs = ra.facts.length;
    } catch { demoBlobs = 0; }
    const sess = sessionFromReq(req);
    res.json({
      user: userId,
      mode,
      demo: { userId: 'demo-mom', ready: demoBlobs > 0, blobCount: demoBlobs },
      personal: {
        memories: snap.memories || 0,
        turns: snap.turns || 0,
        budget: {
          used: chk.used || 0, cap,
          remaining: chk.remaining ?? Math.max(0, cap - (chk.used || 0)),
          reset: chk.reset || null,
          resetAt: chk.resetAt || null,
          resetInHrs: chk.resetInHrs ?? null,
        },
        guardHits,
        stale: !!view.degraded,
      },
      vault: { signedIn: !!sess, onboarded: !!view.isVault },
    });
  } catch (e) { fail(res, e); }
});

// Guard-proof ledger: human page + machine JSON. The JSON includes a chain
// verification so anyone can check the ledger was not edited after the fact.
app.get('/guard-proof', readLimiter, (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const verify = guardProof.verify();
    res.send(ledgerPage({ mode: MODE, entries: guardProof.list({ limit: 100 }), verify }));
  } catch (e) { console.error('page error:', String((e && e.message) || e).slice(0, 200)); res.status(500).send('<pre>Something went wrong loading this page. Please retry.</pre>'); }
});

app.get('/api/guard-proof', readLimiter, (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ count: guardProof.entries.length, verify: guardProof.verify(), entries: guardProof.list({ limit: 100 }) });
  } catch (e) { fail(res, e); }
});

// Proactive safety brief (on demand): morning med plan + a nightly-style
// interaction cross-check of the WHOLE namespace — the same interaction table
// as chat, catching pairs taught on different days. Read-only.
app.get('/api/proactive', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const view = await namespaceView(req, res);
    if (!view) return;
    const morning = morningBriefFromRecall(view.recalled);
    const interactionWarnings = nightlyCrossCheckFromRecall(view.recalled);
    res.json({ user: view.userId, mode: view.mode, degraded: view.degraded, morning, interactionWarnings });
  } catch (e) { fail(res, e); }
});

// The proactive tick, runnable on demand for judges (no Telegram token needed
// on the server): runs the full brief + cross-check per tracked user and logs
// the result. `hour` is overridable so the morning/evening split is demoable.
app.post('/api/nudge', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const hour = Number(req.body?.hour);
    const requested = Array.isArray(req.body?.users) ? req.body.users.map(String) : null;
    // Abuse-bound: unauthenticated fan-out must be small. Normalize BEFORE the
    // reserved check (same normaliser as the write/read paths) so junk prefixes
    // cannot slip past the guard.
    if (requested && requested.length > 5) return res.status(413).json({ error: 'too many users (max 5)' });
    const targets = requested ? requested.map((u) => normalizeUser(u)).filter((u) => u && !isReservedNs(u)) : null;
    const out = [];
    for (const u of targets || []) {
      const { client } = clientFor(u);
      const tick = await tickOnce(client, { hour: Number.isFinite(hour) ? hour : new Date().getUTCHours() });
      out.push({ user: u, items: tick?.items || [] });
      if (tick) console.log(`[nudge] ${u}: ${tick.items.map((i) => i.kind).join(', ')}`);
    }
    res.json({ mode: MODE, delivery: 'log (wire a channel to send these)', users: out });
  } catch (e) { fail(res, e); }
});

// Seed-status: blob count + agent id + whether the >=10 Mainnet bar is met.
app.get('/api/seed-status', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const view = await namespaceView(req, res);
    if (!view) return;
    // Real census (listNamespaces), scoped to THIS namespace — the listing is
    // account-wide, and unscoped sums misreport (plus recall is capped, so it
    // can't serve as the blob count a judge checks either).
    const census = view.mode === 'mainnet' ? await namespaceCensus(view.client, view.ns) : null;
    res.json({
      user: view.userId, mode: view.mode,
      agentId: process.env.MEMWAL_ACCOUNT_ID || null,
      recalledCount: view.recalled.length,
      blobCount: census ? census.totalBlobs : null,
      namespaceCount: census ? census.namespaceCount : null,
      censusAvailable: !!census,
      meetsMinimum: census ? census.totalBlobs >= 10 : view.recalled.length >= 10,
      stale: view.degraded,
    });
  } catch (e) { fail(res, e); }
});

// ---- OpenRouter free-model registry (the ONLY models the UI may pick) ----
// Live list from OpenRouter (pricing.prompt/completion == 0), minus Big-Two
// (openai/*, anthropic/* — Beyond-Big-Two rule) and non-chat endpoints.
// Cached 1h; offline/keyless falls back to the verified static snapshot.
const FREE_STATIC = [
  'inclusionai/ling-3.1-flash',
  'apodex/apodex-1.1-mini:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'thinkingmachines/inkling-small:free',
  'poolside/laguna-s-2.1:free',
  'thinkingmachines/inkling:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3.5-content-safety:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/free',
];
const FREE_DEFAULT = 'google/gemma-4-31b-it:free';
let freeCache = { at: 0, models: [] };
async function freeModels() {
  if (Date.now() - freeCache.at < 3_600_000 && freeCache.models.length) {
    return { models: freeCache.models, live: true };
  }
  try {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('no key');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`openrouter ${r.status}`);
    const d = await r.json();
    const ids = [];
    for (const m of d?.data || []) {
      const id = m?.id;
      const pr = m?.pricing || {};
      const free = (pr.prompt === 0 || pr.prompt === '0' || pr.prompt === '0.0') &&
        (pr.completion === 0 || pr.completion === '0' || pr.completion === '0.0');
      if (typeof id === 'string' && free && !id.startsWith('openai/') && !id.startsWith('anthropic/') && !id.includes('lyria')) {
        ids.push(id);
      }
    }
    if (!ids.length) throw new Error('empty free list');
    freeCache = { at: Date.now(), models: ids };
    return { models: ids, live: true };
  } catch {
    return { models: FREE_STATIC, live: false };
  }
}
async function isFreeModel(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+\/[a-z0-9_.\-]+(:free)?$/i.test(id)) return false;
  const { models } = await freeModels();
  return models.includes(id);
}

app.get('/api/models', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=300');
    const { models, live } = await freeModels();
    res.json({ models: models.map((id) => ({ id })), default: FREE_DEFAULT, live, freeOnly: true });
  } catch (e) { fail(res, e); }
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

app.post('/api/auth/logout', logoutLimiter, (req, res) => {
  const secure = req.secure || (app.get('trust proxy') && req.headers['x-forwarded-proto'] === 'https');
  const sess = sessionFromReq(req);
  if (sess?.jti) revokeSession(sess.jti); // server-side revocation, not just cookie clear
  res.setHeader('Set-Cookie', clearCookie({ secure }));
  res.json({ ok: true });
});

app.get('/api/wallet/status', readLimiter, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const sess = sessionFromReq(req);
    if (!sess) return res.json({ signedIn: false, staleSession: hasSessionCookie(req) });
    const status = await walletStatus(sess.address);
    res.json({ signedIn: true, ...status });
  } catch (e) { fail(res, e); }
});

// Onboarding step 1a (fresh users): tx bytes for create_account.
app.post('/api/wallet/onboard/create', onboardLimiter, async (req, res) => {
  try {
    const sess = sessionFromReq(req);
    if (!sess) return res.status(401).json({ error: 'sign in first' });
    // Fail closed: without SESSION_SECRET delegate keys would persist in
    // plaintext. Refuse to mint onboarding material outside local dev.
    if (!encryptionEnabled() && process.env.MEMWAL_MODE === 'mainnet') {
      const e = new Error('server misconfigured: SESSION_SECRET is required for wallet onboarding');
      e.status = 501; e.expose = true; throw e;
    }
    res.json(await prepareCreateAccount(sess.address));
  } catch (e) { fail(res, e); }
});

// Onboarding step 1b (fresh users after tx 1; existing users): link delegate.
app.post('/api/wallet/onboard/link', onboardLimiter, async (req, res) => {
  try {
    const sess = sessionFromReq(req);
    if (!sess) return res.status(401).json({ error: 'sign in first' });
    if (!encryptionEnabled() && process.env.MEMWAL_MODE === 'mainnet') {
      const e = new Error('server misconfigured: SESSION_SECRET is required for wallet onboarding');
      e.status = 501; e.expose = true; throw e;
    }
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

// Fresh start: abandon the signed-in wallet's own local vault row (retired
// deployment recovery). Memories live onchain, never in this row — but the
// old vault stays unreadable; the user re-teaches into the new one.
app.post('/api/wallet/reset', onboardLimiter, async (req, res) => {
  try {
    const sess = sessionFromReq(req);
    if (!sess) return res.status(401).json({ error: 'sign in first' });
    res.json(resetVault(sess.address));
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

// Health check (registered BEFORE the terminal 404 so it is reachable).
app.get('/healthz', (req, res) => res.json({ ok: true, mode: MODE, memory: memoryDegraded() ? 'degraded' : 'ok', registry: registryStatus(), time: new Date().toISOString() }));

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
  const expose = err?.expose === true;
  res.status(code >= 400 && code < 600 ? code : 500).json({ error: code >= 500 ? 'Internal error' : (expose ? String(err?.message || err) : 'request failed') });
});

const port = process.env.PORT || 3001;
if (process.env.VERCEL !== '1' && import.meta.url === `file://${process.argv[1]}`) {
  const server = app.listen(port, () => console.log(`Mediara on :${port}`));
  // Proactive loop: the memory reaches OUT on a schedule (every 6h) — morning
  // med plan + nightly interaction cross-check per tracked user. Off-switch:
  // DD_NUDGE=off. Runs only when the server actually listens (never under tests/Vercel).
  if (process.env.DD_NUDGE !== 'off') {
    const NUDGE_USERS = ['demo-mom', 'user-a', 'user-b'];
    const nudgeTimer = setInterval(() => {
      (async () => {
        for (const u of NUDGE_USERS) {
          try {
            const tick = await tickOnce(clientFor(u).client);
            if (tick) console.log(`[nudge] ${u}: ${tick.items.map((i) => i.kind).join(', ')}`);
          } catch (e) { console.error(`[nudge] ${u} failed:`, String((e && e.message) || e).slice(0, 120)); }
        }
      })();
    }, 6 * 60 * 60 * 1000);
    nudgeTimer.unref();
  }
  // A listen failure (EADDRINUSE) must not crash as an unhandled 'error' event.
  server.on('error', (e) => { console.error('listen error:', String((e && e.message) || e)); process.exit(1); });
  // Generous socket cap: per-upstream timeouts keep the handler bounded; a tight
  // socket timeout would kill legitimate requests with an empty reply (curl 52).
  server.setTimeout(120_000);
  // Graceful shutdown: stop accepting, drain, then force-exit.
  const shutdown = () => { console.log('shutting down…'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
// Last-resort visibility: never let a stray rejection/throw take the process
// down silently in a demo.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', String((e && e.message) || e).slice(0, 200)));
process.on('uncaughtException', (e) => console.error('uncaughtException:', String((e && e.message) || e).slice(0, 200)));
export default app;
