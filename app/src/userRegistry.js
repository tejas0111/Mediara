// User memory registry (DoseDaughter).
// Persistent JSON store mapping wallet address → MemWal account + delegate key.
// SERVICE metadata only — never memory content. All actual memory is
// Seal-encrypted blobs on Walrus, owned by each user's own MemWalAccount.
// Delegate private keys are encrypted at rest with AES-256-GCM whenever
// SESSION_SECRET is set; plaintext only exists in offline dev (and the file
// records that fact honestly via `keyEncrypted`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptSecret, decryptSecret, encryptionEnabled } from './cryptoUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable per-call (tests): set DD_REGISTRY_PATH to a temp file.
const storePath = () => process.env.DD_REGISTRY_PATH || path.join(__dirname, '..', '.wallet-registry.json');

function load() {
  try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return { users: {} }; }
}
function save(db) {
  const tmp = storePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, storePath());
}

export function getUser(address) {
  const db = load();
  const u = db.users[String(address).toLowerCase()];
  if (!u) return null;
  try {
    return { ...u, delegatePrivateKey: u.delegatePrivateKey ? decryptSecret(u.delegatePrivateKey) : u.delegatePrivateKey };
  } catch (e) {
    // Wrong SESSION_SECRET or corrupted row: fail loudly, never hand back garbage.
    console.error(`registry: cannot decrypt delegate key for ${String(address).slice(0, 10)}… — ${String(e?.message || e).slice(0, 80)}`);
    return null;
  }
}

export function upsertUser({ address, accountId, delegatePrivateKey, delegatePublicKey, delegateAddress, pendingPhase, pendingTxBytes }) {
  const db = load();
  const key = String(address).toLowerCase();
  const prev = db.users[key] || {};
  const row = {
    ...prev,
    address: key,
    accountId: accountId === undefined ? prev.accountId : accountId,
    delegatePublicKey: delegatePublicKey ?? prev.delegatePublicKey,
    delegateAddress: delegateAddress ?? prev.delegateAddress,
    pendingPhase: pendingPhase === undefined ? prev.pendingPhase : pendingPhase,
    pendingTxBytes: pendingTxBytes === undefined ? prev.pendingTxBytes : pendingTxBytes,
    keyEncrypted: encryptionEnabled(),
    onboardedAt: prev.onboardedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (delegatePrivateKey !== undefined) row.delegatePrivateKey = encryptSecret(delegatePrivateKey);
  db.users[key] = row;
  save(db);
  getUser(address); // fail fast at write time if decryption can't round-trip
  return row;
}

// Mark an account as linked. UPSERTS: if the registry row is missing (the exact
// recovery case this exists for — account lives onchain but the local row was
// lost, e.g. redeploy), a minimal row is created with address + accountId. The
// delegate key is NOT recoverable this way; callers that need one must run the
// link flow again.
export function markAccountLinked(address, accountId) {
  const db = load();
  const key = String(address).toLowerCase();
  const prev = db.users[key] || {};
  const now = new Date().toISOString();
  const row = {
    ...prev,
    address: key,
    accountId,
    pendingPhase: null,
    pendingTxBytes: null,
    // Only claim encryption when there is actually a secret on file.
    keyEncrypted: prev.delegatePrivateKey != null ? (prev.keyEncrypted ?? encryptionEnabled()) : false,
    onboardedAt: prev.onboardedAt || now,
    updatedAt: now,
  };
  db.users[key] = row;
  save(db);
  return row;
}
