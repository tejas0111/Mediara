// Wallet identity + session tokens (DoseDaughter).
// The browser signs a short-lived, server-issued nonce message with the
// visitor's Sui wallet; we verify the signature server-side (@mysten/sui/verify),
// consume the nonce (single-use), and issue an HMAC-signed session cookie. No
// password, no third-party auth — wallet IS identity. The nonce makes a captured
// signature useless (replay-resistant).
import crypto from 'node:crypto';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

// Kept for backwards compatibility / UI copy. The signed message is no longer
// this fixed string alone — it is authMessage(nonce), which embeds a fresh,
// single-use nonce issued per sign-in attempt.
export const AUTH_MESSAGE = 'DoseDaughter: sign in to your memory wallet.\nThis signature proves you own this address. No transaction, no fee.';

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory nonce store: nonce -> { expiresAt, used }. Single process; a
// serverless cold start invalidates outstanding nonces, which only forces a
// fresh sign-in — never a security hole. Entries are removed on use and swept
// periodically so the Map cannot grow unbounded.
const nonces = new Map();
function sweepNonces() {
  const now = Date.now();
  for (const [n, e] of nonces) if (e.used || now > e.expiresAt) nonces.delete(n);
}
const nonceSweeper = setInterval(sweepNonces, 60_000);
if (typeof nonceSweeper.unref === 'function') nonceSweeper.unref();

export function isValidSuiAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{64}$/.test(a);
}

// Deterministic text the wallet signs for a given nonce. The nonce binds the
// signature to this one sign-in attempt.
export function authMessage(nonce) {
  return `${AUTH_MESSAGE}\nNonce: ${String(nonce ?? '')}`;
}

// Issue a fresh single-use nonce + the exact message to sign. Optional ttlMs is
// used by tests (tiny TTL) and defaults to 5 minutes (or DD_NONCE_TTL_MS).
export function issueNonce(ttlMs) {
  sweepNonces();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : (Number(process.env.DD_NONCE_TTL_MS) || NONCE_TTL_MS);
  const expiresAt = Date.now() + ttl;
  nonces.set(nonce, { expiresAt, used: false });
  return { nonce, message: authMessage(nonce), expiresAt };
}

// Returns true only for a known, unexpired, unused nonce; consumes it so the
// same signature can never be replayed.
export function consumeNonce(nonce) {
  if (typeof nonce !== 'string' || !nonce) return false;
  const entry = nonces.get(nonce);
  if (!entry || entry.used || Date.now() > entry.expiresAt) {
    if (entry) nonces.delete(nonce);
    return false;
  }
  entry.used = true;
  nonces.delete(nonce);
  return true;
}

// Returns { address } on success, null on any failure. Never trusts the
// client-supplied address — the address is derived from the verified key.
// Verifies the signature over authMessage(nonce). The caller MUST have already
// validated + consumed the nonce (consumeNonce) so a captured signature cannot
// be replayed.
export async function verifyWalletSignature({ address, signature, nonce }) {
  try {
    if (!isValidSuiAddress(address) || typeof signature !== 'string' || signature.length < 50) return null;
    if (typeof nonce !== 'string' || !nonce) return null;
    const publicKey = await verifyPersonalMessageSignature(new TextEncoder().encode(authMessage(nonce)), signature, { address });
    if (!publicKey) return null;
    const derived = publicKey.toSuiAddress();
    // Case-insensitive compare: wallets serialize addresses differently.
    return derived.toLowerCase() === address.toLowerCase() ? { address: derived.toLowerCase() } : null;
  } catch {
    return null;
  }
}

function hmac(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

// Token format: base64url({address, exp}).hmac — stateless, no server store.
export function issueSession(address) {
  const body = Buffer.from(JSON.stringify({ a: address, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

export function readSession(token) {
  try {
    if (typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = hmac(body);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!isValidSuiAddress(data.a) || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    return { address: data.a };
  } catch {
    return null;
  }
}

// Cookie helpers (no cookie-parser dependency needed). Secure flag when the
// request is https (direct or behind a proxy) — sessions work on http localhost.
export function sessionCookie(token, { secure = false } = {}) {
  return `dd_session=${token}; Path=/; HttpOnly; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}
export function clearCookie() {
  return 'dd_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}
export function sessionFromReq(req) {
  // Never throw on a malformed cookie (a client can set `dd_session=%`): a bad
  // decode means "no session" (→ 401), not a 500.
  try {
    const raw = req.headers.cookie || '';
    const m = raw.match(/(?:^|;\s*)dd_session=([^;]+)/);
    if (!m) return null;
    let token;
    try { token = decodeURIComponent(m[1]); } catch { return null; }
    return readSession(token);
  } catch {
    return null;
  }
}
