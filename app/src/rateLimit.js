// Minimal in-memory fixed-window rate limiter (per process).
// Right-sized for a hackathon deploy: protects the auth/onboarding/chat
// surfaces from scripts without adding a dependency. On serverless each
// instance keeps its own window — still caps abuse spikes per instance.
import crypto from 'node:crypto';

const buckets = new Map();

// Stable-ish rate-limit key: req.ip (trust-proxy aware) PLUS a hash of the
// User-Agent. Rotating X-Forwarded-For alone no longer resets the bucket, so a
// spoofable edge header cannot defeat the limiters.
export function clientKey(req) {
  const ip = (typeof req.ip === 'string' && req.ip) ? req.ip : (req.socket?.remoteAddress || 'unknown');
  const ua = String(req.headers['user-agent'] || '').slice(0, 160);
  return `${ip}|${crypto.createHash('sha256').update(ua).digest('base64url').slice(0, 10)}`;
}

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
    // Hard cap: never let the Map grow unbounded (a conditional sweep of expired
    // keys reclaims nothing when all keys are fresh).
    if (buckets.size > 5000) buckets.clear();
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

// Express middleware factory.
export function limiter({ limit, windowMs, keyFn }) {
  return (req, res, next) => {
    const r = rateLimit({ key: keyFn(req), limit, windowMs });
    if (!r.allowed) {
      res.setHeader('Retry-After', Math.ceil(r.retryAfterMs / 1000));
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    next();
  };
}
