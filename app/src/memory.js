// DoseDaughter memory layer — thin wrapper over @mysten-incubation/memwal.
// Rules: hosted relayer pays WAL/SUI; we only need MEMWAL_ACCOUNT_ID + MEMWAL_PRIVATE_KEY.
// Every fact <= 500 bytes (MemWal INSERT fails after paid upload otherwise).
// Always use rememberAndWait (async-accept + index lag), filter recall by distance.
import { MemWal } from '@mysten-incubation/memwal';

const SERVER_URL = process.env.MEMWAL_SERVER_URL || 'https://relayer.memory.walrus.xyz';
const MAX_FACT_BYTES = 500;
export const MAX_DISTANCE = 0.7;

export function namespaceFor(userId) {
  if (userId == null) return 'user-anon';
  return `user-${String(userId).toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 48) || 'anon'}`;
}

export function createClient({ namespace } = {}) {
  const key = process.env.MEMWAL_PRIVATE_KEY;
  const accountId = process.env.MEMWAL_ACCOUNT_ID;
  if (!key || !accountId) throw new Error('Missing MEMWAL_PRIVATE_KEY / MEMWAL_ACCOUNT_ID in .env');
  return MemWal.create({ key, accountId, serverUrl: SERVER_URL, namespace: namespace || 'dosedughter-prod' });
}

// Per-user client: acts AS THE USER via their registered delegate key.
// Memory written here lands in the user's OWN MemWalAccount (they own it);
// the app wallet is never involved and holds no access to their namespace.
export function createDelegateClient({ delegatePrivateKey, accountId, namespace } = {}) {
  if (!delegatePrivateKey || !accountId) throw new Error('Missing delegate key / account ID for user client');
  return MemWal.create({ key: delegatePrivateKey, accountId, serverUrl: SERVER_URL, namespace: namespace || 'dosedughter-prod' });
}

export function truncateFact(text) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= MAX_FACT_BYTES) return s;
  // Byte-budgeted walk over code points: subarray-style cuts can split a
  // multi-byte char and decode as U+FFFD (and even exceed 500 bytes).
  let out = '', bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > MAX_FACT_BYTES) break;
    out += ch;
    bytes += b;
  }
  return out;
}

// ---- Substance knowledge (deterministic; no LLM key needed) ---------------
// Canonical drug -> drug class. Same-class substances are interchangeable for an
// allergy check (an ibuprofen allergy must block Aleve/naproxen and Excedrin/
// aspirin), while paracetamol stays a SEPARATE class (Tylenol must NOT block).
export const DRUG_CLASS = {
  ibuprofen: 'nsaid',
  naproxen: 'nsaid',
  aspirin: 'nsaid',
  diclofenac: 'nsaid',
  indomethacin: 'nsaid',
  celecoxib: 'nsaid',
  meloxicam: 'nsaid',
  ketoprofen: 'nsaid',
  etoricoxib: 'nsaid',
  paracetamol: 'paracetamol',
};
// Brand/OTC name -> canonical drug.
export const BRAND_SYNONYMS = new Map(Object.entries({
  advil: 'ibuprofen', motrin: 'ibuprofen', nurofen: 'ibuprofen', brufen: 'ibuprofen',
  aleve: 'naproxen', naprosyn: 'naproxen',
  excedrin: 'aspirin',
  disprin: 'aspirin', ecotrin: 'aspirin', bayer: 'aspirin',
  voltaren: 'diclofenac', cataflam: 'diclofenac',
  tylenol: 'paracetamol', panadol: 'paracetamol', calpol: 'paracetamol', acetaminophen: 'paracetamol',
}));
const KNOWN_DRUG_WORDS = [...new Set([...Object.keys(DRUG_CLASS), ...BRAND_SYNONYMS.keys()])];
const DRUG_ALT = KNOWN_DRUG_WORDS.join('|');
const NO_DRUG_RE = new RegExp(`\\bno\\s+(?:more\\s+)?(?:${DRUG_ALT})\\b`, 'i');

// Singularize so plural variants ('ibuprofens') still match ('ibuprofen').
const singular = (w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
// Resolve a token to a canonical drug, or null. ONLY real drugs/substances
// resolve — symptom words ("rash", "swelling", "reaction") never do, so the
// safety net can never report "STOP — do not give rash."
function resolveSubstance(word) {
  const t = singular(String(word || '').toLowerCase().replace(/[^a-z]/g, ''));
  if (!t) return null;
  if (BRAND_SYNONYMS.has(t)) return BRAND_SYNONYMS.get(t);
  if (DRUG_CLASS[t]) return t;
  return null;
}
function substancesIn(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)) {
    const s = resolveSubstance(w);
    if (s) out.add(s);
  }
  return out;
}
function classesIn(text) {
  const out = new Set();
  for (const s of substancesIn(text)) if (DRUG_CLASS[s]) out.add(DRUG_CLASS[s]);
  if (/\bnsaids?\b/i.test(text)) out.add('nsaid');
  return out;
}
// Negated allergy facts must never block ("not allergic", "no known allergy").
function isNegatedAllergy(text) {
  return /\b(?:not|isn'?t|aren'?t|wasn'?t|weren'?t|never|no|denies|without)\b[^.!?]{0,25}\ballerg/i.test(String(text || ''));
}

// Write gate: only new, durable, user-stated facts are saved. Chit-chat,
// questions, and model guesses are never written.
export function shouldRemember(text) {
  if (typeof text !== 'string' || !text || text.length > 500) return false;
  const t = text.toLowerCase();
  if (/\?\s*$/.test(t)) return false; // questions are never facts
  // Durable safety/care facts — natural allergy phrasing must not be missed.
  if (/\ballerg/.test(t)) return true;
  if (/\bavoid(?:s|ed|ing)?\b/.test(t)) return true;
  if (/\bcan(?:no|'?t|not)\s+(?:have|take)\b/.test(t)) return true;
  if (/\bintoleran/.test(t)) return true;
  if (/\breaction\s+to\b|\bhad\s+a\s+reaction\b/.test(t)) return true;
  if (/\bmakes?\s+(?:me|her|him|them|us|mom|dad|mother|father)\s+sick\b/.test(t)) return true;
  if (/\b(?:gives?|gave)\s+(?:me|her|him|them|us|mom|dad|mother|father)\s+a\s+rash\b/.test(t)) return true;
  if (/\b(?:rash|hives|swelling)\b/.test(t)) return true;
  if (/\bstops?\s+taking\b|\bstopped\s+taking\b/.test(t)) return true;
  if (/\bswitch(?:ed|es|ing)?\s+from\b/.test(t)) return true;
  if (NO_DRUG_RE.test(t)) return true;
  // Meds / caregiver facts / routines. Bare meal words are deliberately NOT
  // enough ("dinner was nice" is chit-chat); a time/context is required.
  return /i take|\btakes?\b|\btaking\b|my (mom|dad|dose|routine|mother|father)|\bevery day\b|\bdaily\b|\bmedication\b|prescription|\bmeds?\b|\bpill|remind|\bmg\b|\d\s?mg|\d:\d|\d\s?(am|pm)\b|\b(?:dinner|breakfast|lunch)\b.*\bat\s+\d|\bbedtime\b|\broutine\b/.test(t);
}

// Coded safety net: if the user asks about giving/taking something matching a
// recalled allergy fact, block with a warning citing the source blob — BEFORE the
// LLM. Substance-aware: same drug OR same drug class (ibuprofen allergy blocks
// Aleve/naproxen and Excedrin/aspirin; paracetamol/Tylenol is a separate class).
// Negated allergies never block, and only real drugs are ever returned (never a
// symptom word like "rash"). Deterministic: works with no LLM key.
// Returns { substance, class, fact, blob_id } or null.
export function findConflict(message, recalled) {
  if (!message || !recalled || !Array.isArray(recalled)) return null;
  const msgSubs = substancesIn(message);
  if (!msgSubs.size) return null;
  // A statement that TEACHES an allergy is not an administration question: never
  // STOP on "She is allergic to ibuprofen" / "avoid X" / "no ibuprofen". Only
  // skip non-questions, so "Should I avoid giving her ibuprofen?" still blocks.
  const isStatement = !/\?\s*$/.test(String(message).trim()) && (
    /\ballerg|intoleran|\bavoid(?:s|ed|ing)?\b|\bcan(?:no|'?t|not)\s+(?:have|take)\b|\breaction\s+to\b|\bmakes?\s+\w+\s+sick\b/i.test(message)
    || NO_DRUG_RE.test(message)
  );
  if (isStatement) return null;
  for (const r of recalled) {
    if (!r || typeof r.text !== 'string') continue;
    if (!/allerg|reaction|intoleran|avoid/i.test(r.text)) continue;
    if (isNegatedAllergy(r.text)) continue;
    const factSubs = substancesIn(r.text);
    const factClasses = classesIn(r.text);
    if (!factSubs.size && !factClasses.size) continue;
    for (const s of msgSubs) {
      if (factSubs.has(s)) {
        return { substance: s, class: DRUG_CLASS[s] || null, fact: r.text, blob_id: r.blob_id || null };
      }
    }
    for (const s of msgSubs) {
      const cls = DRUG_CLASS[s];
      if (cls && factClasses.has(cls)) {
        return { substance: s, class: cls, fact: r.text, blob_id: r.blob_id || null };
      }
    }
  }
  return null;
}

export async function rememberAndWait(client, text) {
  const job = await client.remember(truncateFact(text));
  const done = await client.waitForRememberJob(job.job_id);
  return done; // { blob_id, owner, namespace }
}

export async function rememberBulkAndWait(client, texts) {
  const items = texts.map((t) => ({ text: truncateFact(t) }));
  // SDK bulk API name varies by version; fall back to sequential if missing.
  if (typeof client.rememberBulkAndWait === 'function') return client.rememberBulkAndWait(items);
  const out = [];
  for (const it of items) out.push(await rememberAndWait(client, it.text));
  return out;
}

// Transient-safe recall: the relayer can abort a request while the index settles
// (just-seeded namespaces, congestion). Retry once, then degrade to empty — the bot
// must NEVER 500 on a flaky relayer moment (judges hit the demo at arbitrary times).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function safeRecall(client, params, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await client.recall(params);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (/abort|timeout|503|504|429|unavailable|ECONN/i.test(msg) && i < tries - 1) {
        await sleep(3000 * (i + 1));
        continue;
      }
      break;
    }
  }
  console.error(`recall failed after ${tries} tries:`, String(lastErr?.message || lastErr).slice(0, 120));
  return { results: [] };
}

// Allergy facts are a hard safety requirement: the normal message query may not
// rank them (audit H3), so we ALWAYS run a dedicated allergy-oriented recall and
// merge it in. Normal results keep the <0.7 distance filter; allergy facts from
// the dedicated query are surfaced even if their distance is higher, and are
// force-kept inside the final cap so the STOP path can fire.
const ALLERGY_QUERY = 'allergies drug reactions avoid intolerance';
const ALLERGY_RE = /allerg|reaction|intoleran|avoid/i;

export async function recallRelevant(client, query, limit = 5) {
  let n = Number(limit);
  if (!Number.isFinite(n)) n = 5;
  n = Math.max(0, Math.floor(n));
  if (n === 0) return [];

  const { results } = await safeRecall(client, { query, limit: n });
  let safety = [];
  try {
    const { results: sr } = await safeRecall(client, { query: ALLERGY_QUERY, limit: Math.max(n, 10) });
    safety = sr || [];
  } catch { safety = []; }

  // Merge by normalized text, dedup keeping the best (lowest) distance.
  const byText = new Map();
  const consider = (r, fromSafety) => {
    if (!r || typeof r.text !== 'string' || !r.text.trim()) return;
    const key = r.text.trim().toLowerCase();
    const dist = r.distance ?? 1;
    const safetyFact = fromSafety && ALLERGY_RE.test(r.text);
    if (!safetyFact && dist >= MAX_DISTANCE) return; // normal filter stays
    const prev = byText.get(key);
    if (!prev || dist < (prev.distance ?? 1)) byText.set(key, { ...r, distance: dist });
  };
  for (const r of results || []) consider(r, false);
  for (const r of safety || []) consider(r, true);

  const ordered = [...byText.values()].sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1));
  const out = ordered.slice(0, n);
  // Force-include allergy facts that fell past the cap by evicting the worst
  // non-allergy entries.
  const missing = ordered.filter((r) => ALLERGY_RE.test(r.text) && !out.includes(r));
  if (missing.length) {
    const res = out.slice();
    for (const m of missing) {
      let idx = -1;
      for (let i = res.length - 1; i >= 0; i--) {
        if (!ALLERGY_RE.test(res[i].text)) { idx = i; break; }
      }
      if (idx >= 0) res[idx] = m;
      else if (res.length < n) res.push(m);
    }
    return res.sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1));
  }
  return out;
}

// Multi-angle union recall: several query phrasings merged by text (lowest distance
// wins). A receipts page / summary must see the whole namespace — one phrasing can
// score every fact above the 0.7 cutoff and wrongly show an empty memory.
export async function recallAll(client, queries, limit = 20) {
  const byText = new Map();
  for (const q of queries) {
    try {
      const { results } = await safeRecall(client, { query: q, limit: 25 });
      for (const r of results || []) {
        if ((r.distance ?? 1) >= MAX_DISTANCE) continue;
        const key = String(r.text || '').trim().toLowerCase();
        if (!key) continue;
        const prev = byText.get(key);
        if (!prev || (r.distance ?? 1) < (prev.distance ?? 1)) byText.set(key, r);
      }
    } catch { /* one angle failing must not empty the page */ }
  }
  return [...byText.values()].sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1)).slice(0, limit);
}

// Fact classifier for doctor summaries: score-based (not first-regex-hit) so
// "daughter Priya manages weekend doses" lands in family, not medications.
// Allergies ALWAYS win — misfiling an allergy is a safety bug.
const CLASS_RULES = {
  medications: [/metformin/i, /amlodipine/i, /\bmg\b/i, /\bpill/i, /tablet/i, /insulin/i, /\btakes?\b/i, /\btaking\b/i, /\bdose/i, /medicati/i, /prescript/i],
  routine: [/dinner/i, /bedtime/i, /breakfast/i, /\blunch\b/i, /reminder/i, /morning/i, /at \d/i, /\d\s?(am|pm)\b/i, /\bwalk/i],
  familyAndCare: [/daughter/i, /\bson\b/i, /\bmom\b/i, /\bdad\b/i, /doctor/i, /pharmacy/i, /emergency/i, /contact/i, /\bcall/i, /visit/i, /priya|arjun|\brao\b/i, /hindi/i, /whatsapp/i],
};
export function classifyFacts(facts) {
  const out = { medications: [], allergies: [], routine: [], familyAndCare: [], unclassified: [] };
  for (const raw of facts || []) {
    const text = String(raw).replace(/^User\s+\S+:\s*/i, '');
    if (/allerg/i.test(text)) { out.allergies.push(raw); continue; }
    let best = 'unclassified', bestScore = 0;
    for (const [cat, rules] of Object.entries(CLASS_RULES)) {
      const score = rules.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
      if (score > bestScore) { best = cat; bestScore = score; }
    }
    out[best].push(raw);
  }
  return out;
}

export function buildSystemPrompt(recalled) {
  const base = `You are DoseDaughter, a caregiver helper. You remember meds, allergies, routines, family names across sessions. Rules: (1) If asked "can I take X?", first check recalled allergies/meds for conflicts and warn. (2) Cite what you remember naturally ("you told me..."). (3) Never adjust dosage — only remind and flag; always add: "Confirm with your doctor — this is not medical advice."`;
  if (!recalled || recalled.length === 0) return base + `\nNo prior memories for this user yet. Ask for 3 facts: daily meds with times, allergies, routine.`;
  const lines = recalled.map((r) => `- ${r.text}`).join('\n');
  return `${base}\nWhat you remember about this user:\n${lines}`;
}
