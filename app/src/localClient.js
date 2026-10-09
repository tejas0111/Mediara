// Local stand-in for MemWal — SAME interface, zero network, for offline development and demos.
// Mainnet path (memory.js) is untouched and used when MEMWAL_MODE=mainnet + keys present.
// Local blobs: `local-<sha1>` persisted to .local-memory.json (gitignored). NEVER presented as Mainnet.
// Scoring: normalized word-overlap (light stemming + synonym canonicalization so it
// approximates semantic recall) → distance in 0..1. Any topical hit scores <= 0.65 so the
// shared MAX_DISTANCE=0.7 cutoff in memory.js behaves like vector recall; ranking by overlap.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable for tests (DD_LOCAL_STORE) so route tests never mutate the demo store.
// Read dynamically (not once at import) so selftest/eval pick up a temp store
// even when the env var is set after import.
const storePath = () => process.env.DD_LOCAL_STORE || path.join(__dirname, '..', '.local-memory.json');

function load() {
  // Distinguish "empty" from "unreadable": a corrupt store must fail LOUD so the
  // guard fails closed, not silently return no memories.
  let raw;
  try { raw = fs.readFileSync(storePath(), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { namespaces: {} }; throw e; }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`local store is corrupt (${storePath()}): ${e.message}`); }
}
// Atomic write: serialize to a unique tmp file, then rename. rename() is atomic
// on the same filesystem, so a concurrent reader or a crash never observes a
// half-written / corrupt .local-memory.json.
function save(db) {
  const tmp = `${storePath()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, storePath());
}
// In-process mutex: every mutation across all local clients shares one promise
// chain, so read-modify-write sequences cannot interleave and lose facts when
// concurrent requests hit the same file.
let writeChain = Promise.resolve();
function withLock(fn) {
  const run = writeChain.then(fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}

// Synonym groups canonicalize to the first entry (approximates semantic match).
const GROUPS = [
  ['med', 'meds', 'medication', 'medications', 'pill', 'pills', 'dose', 'doses', 'dosage', 'tablet', 'tablets', 'prescription', 'rx'],
  ['take', 'takes', 'taking', 'took'],
  ['allergy', 'allergies', 'allergic', 'alergic', 'alergie', 'alergies', 'alergy'],
  ['routine', 'dinner', 'bedtime', 'breakfast', 'lunch', 'reminder', 'reminders', 'morning', 'evening', 'walk', 'sleep'],
  ['mom', 'mother', 'mum', 'mummy'],
  ['dad', 'father'],
  ['doctor', 'dr', 'clinic', 'visit', 'appointment'],
  ['family', 'daughter', 'son', 'priya', 'arjun'],
];
const CANON = new Map();
for (const g of GROUPS) for (const w of g) CANON.set(w, g[0]);
// Common drug names + "<n>mg" dosages count as med mentions.
const DRUGS = new Set(['metformin', 'amlodipine', 'ibuprofen', 'paracetamol', 'aspirin', 'insulin']);

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function norm(tok) {
  if (DRUGS.has(tok)) return 'med';
  if (/\d/.test(tok) && /(mg|mcg|ml|iu|units?)/.test(tok)) return 'med';
  if (/\b(?:tablet|pill|dose|prescription|medication|mcg)\b/.test(tok)) return 'med';
  if (CANON.has(tok)) return CANON.get(tok);
  return stem(tok);
}

const words = (s) => {
  const out = new Set();
  for (const tok of String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
    if (!tok || (tok.length <= 2 && !/\d/.test(tok))) continue;
    out.add(norm(tok));
  }
  return out;
};
export function overlap(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return { score: 0, hit: 0 };
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return { score: 0, hit: 0 };
  let hit = 0; for (const w of A) if (B.has(w)) hit++;
  return { score: hit / Math.sqrt(A.size * B.size), hit };
}

export function createLocalClient({ namespace }) {
  const ns = namespace || 'dosedughter-local';
  return {
    async health() { return { ok: true, mode: 'local' }; },
    async remember(text) {
      text = String(text ?? '');
      return withLock(() => {
        const db = load();
        db.namespaces[ns] = db.namespaces[ns] || [];
        const blob_id = `local-${crypto.createHash('sha1').update(`${ns}:${text}`).digest('hex').slice(0, 12)}`;
        const job_id = `job-${blob_id}`;
        db.namespaces[ns] = db.namespaces[ns].filter((m) => m.text !== text);
        db.namespaces[ns].push({ text, blob_id, job_id, at: new Date().toISOString() });
        save(db);
        return { job_id };
      });
    },
    async waitForRememberJob(job_id) {
      const db = load();
      const m = (db.namespaces[ns] || []).find((x) => x.job_id === job_id);
      return { blob_id: m?.blob_id || null, owner: 'local', namespace: ns };
    },
    async recall({ query, limit = 5, signal } = {}) {
      // Test-only fault injection (mirrors DD_LOCAL_STORE / DD_REGISTRY_PATH).
      if (process.env.DD_FAULT_RECALL === 'throw') throw new Error('relayer 503 Service Unavailable');
      if (process.env.DD_FAULT_RECALL === 'hang') return new Promise(() => {});
      // Abort cooperation (E): a pre-aborted signal does no work; an abort
      // landing mid-slow-recall resolves promptly instead of serving the full
      // 1.5s window to a gone client.
      const abortErr = () => Object.assign(new Error('recall aborted'), { code: 'ABORT_ERR' });
      if (signal?.aborted) throw abortErr();
      // Test-only slow-recall window for the pre-first-token-abort pin: recall
      // resolves normally, but well after a test abort lands mid-flight.
      if (process.env.DD_FAULT_RECALL === 'slow') {
        await new Promise((res, rej) => {
          const t = setTimeout(res, 1500);
          if (signal) {
            if (signal.aborted) { clearTimeout(t); rej(abortErr()); }
            else signal.addEventListener('abort', () => { clearTimeout(t); rej(abortErr()); }, { once: true });
          }
        });
      }
      let n = Number(limit);
      if (!Number.isFinite(n)) n = 5;
      n = Math.max(0, Math.floor(n));
      const db = load();
      const mems = db.namespaces[ns] || [];
      return {
        results: mems
          .map((m) => {
            const { score, hit } = overlap(query, m.text);
            // Any topical hit passes the shared 0.7 cutoff; more hits rank first.
            const distance = hit > 0 ? 1 - Math.max(score, 0.35 + 0.05 * Math.min(hit, 3)) : 1;
            return { ...m, distance };
          })
          .sort((a, b) => a.distance - b.distance)
          .slice(0, n),
      };
    },
  };
}
