// Secret-at-rest crypto for DoseDaughter (delegate private keys, etc.).
// AES-256-GCM with a key derived via scrypt from SESSION_SECRET and a random
// per-value salt (stored alongside the ciphertext so decrypt works across
// restarts/cold starts). When SESSION_SECRET is unset, values pass through
// UNENCRYPTED (offline dev), and the registry marks that fact so audits can
// tell the two states apart.
// Stored shape (new): { enc: true, kdf: "scrypt", salt, v: "iv_b64.tag_b64.ct_b64" }
// Legacy rows:       { enc: true, v: "iv_b64.tag_b64.ct_b64" }  (SHA-256 key, no salt)
//                    | { enc: false, v }
import crypto from 'node:crypto';

// Interactive scrypt params: 128*N*r = 16 MiB < Node's 32 MiB default maxmem.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKeyScrypt(secret, salt) {
  return crypto.scryptSync(String(secret), salt, 32, SCRYPT);
}

// Legacy pre-salt derivation, kept ONLY so existing rows keep decrypting.
function deriveKeyLegacy(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

export function encryptionEnabled() {
  return Boolean(process.env.SESSION_SECRET);
}

export function encryptSecret(plain) {
  if (!encryptionEnabled()) return { enc: false, v: String(plain) };
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKeyScrypt(process.env.SESSION_SECRET, salt), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: true,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    v: `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`,
  };
}

// Returns the plaintext or throws (wrong secret / tampered data must never
// silently produce garbage keys that then fail relayer auth confusingly).
export function decryptSecret(stored) {
  if (stored == null) throw new Error('no secret stored');
  if (typeof stored === 'string') return stored; // legacy plaintext row
  if (stored.enc === false) return String(stored.v);
  if (stored.enc !== true || typeof stored.v !== 'string' || stored.v.split('.').length !== 3) {
    throw new Error('malformed encrypted secret');
  }
  const [ivB64, tagB64, ctB64] = stored.v.split('.');
  // New rows carry a salt + scrypt kdf; legacy rows did not (SHA-256 key).
  const key = typeof stored.salt === 'string' && stored.salt.length
    ? deriveKeyScrypt(process.env.SESSION_SECRET, Buffer.from(stored.salt, 'base64'))
    : deriveKeyLegacy(process.env.SESSION_SECRET);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
