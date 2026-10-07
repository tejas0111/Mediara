// Minimal in-memory fixed-window rate limiter (per process).
// Right-sized for a hackathon deploy: protects the auth/onboarding/chat
// surfaces from scripts without adding a dependency. On serverless each
// instance keeps its own window — still caps abuse spikes per instance.
const buckets = new Map();

// Rate-limit key = req.ip ONLY (trust-proxy aware). Do NOT include spoofable
// headers like User-Agent: rotating a client-controlled header would reset the
// bucket and defeat the limiter entirely. For authenticated abuse we add a
// separate, non-spoofable per-address limiter.
export function clientKey(req) {
  return (typeof req.ip === 'string' && req.ip) ? req.ip : (req.socket?.remoteAddress || 'unknown');
}

// Device-aware key for the chat/read limiters ONLY: one NAT room (judging day)
// shares a single IP, so IP-only buckets throttle innocent neighbours. The
// device id below is the SINGLE definition (server.js guestKeyFor imports it —
// client-rotatable, so this key is fairness, not a security boundary; the
// auth/onboard/nonce/logout limiters stay IP-only above for that reason).
export function deviceId(req) {
  const v = req.headers?.['x-device-id'];
  const s = Array.isArray(v) ? v[0] : v;
  const t = String(s == null ? '' : s).trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(t) ? t : 'anon';
}
export function deviceKey(req) {
  return `${clientKey(req)}|${deviceId(req)}`;
}

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
    // Bounded eviction of the OLDEST entries — never a global clear() (which
    // would reset everyone's window and let an attacker unlock their own bucket).
    if (buckets.size > 5000) {
      const it = buckets.keys();
      for (let i = 0; i < 1000; i++) { const k = it.next().value; if (k === undefined) break; buckets.delete(k); }
    }
  }
  b.count += 1;
  return {
    allowed: b.count <= limit,
    remaining: Math.max(0, limit - b.count),
    retryAfterMs: b.count > limit ? Math.max(1000, windowMs - (now - b.start)) : 0,
  };
}

// Determine the caller IP for rate-limit keys. X-Forwarded-For / X-Real-IP are
// CLIENT-CONTROLLED unless a trusted proxy sets them, so we never read them
// directly. Express computes `req.ip` from the socket + the `trust proxy`
// setting (configured in server.js): behind one edge proxy it is the real
// client, and with no proxy it is the socket address. Falling back to the raw
// headers here would let a client rotate them to get a fresh bucket per request.
export function clientIp(req) {
  if (typeof req.ip === 'string' && req.ip) return req.ip;
  return req.socket?.remoteAddress || 'unknown';
}

// Express middleware factory. `limit` may be a number or a () => number thunk;
// thunks resolve per request so DD_* env overrides take effect without a
// restart (judging-day tuning). Plain numbers behave exactly as before.
export function limiter({ limit, windowMs, keyFn }) {
  return (req, res, next) => {
    const lim = typeof limit === 'function' ? limit() : limit;
    const r = rateLimit({ key: keyFn(req), limit: lim, windowMs });
    if (!r.allowed) {
      res.setHeader('Retry-After', Math.ceil(r.retryAfterMs / 1000));
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    next();
  };
}
