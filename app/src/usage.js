// Usage evidence + novel safety features — one module, zero new dependencies.
//
// 1) UsageTracker — real-use evidence for the hackathon requirement
//    (≥3 distinct users × ≥10 memories each): per-user blob counts with
//    walruscan links, JSON + markdown export, LOCAL/MAINNET labelling.
//    Written AFTER the write gate, so only facts that actually landed on Walrus
//    are counted — the tracker never inflates a number.
// 2) GuardProof — a public, append-only /guard-proof ledger: every STOP/CAUTION
//    with the exact recalled fact and blob id that fired it. Receipts are
//    hash-linked (each entry carries sha256 of the previous entry) so any
//    tampering is detectable — verifiable safety, not vibes.
// 3) ProactiveBrief + daily tick — the memory reaches OUT: morning brief with
//    today's doses + any interaction/caution between a taught med and a taught
//    drug; evening refill check; the same interaction guard as chat, evaluated
//    nightly against the full namespace (catches pairs taught on different
//    days). No database: state rides on Walrus itself.
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { namespaceFor, recallAllMeta, findInteraction, classifyFacts } from './memory.js';
import { guardBody } from './guardBody.js';

export const USERS = ['demo-mom', 'user-a', 'user-b'];

const ALL_ANGLES = [
  'medications allergies routine family',
  'takes taking take dose pill tablet prescription mg mcg daily',
  'allergic rash avoid reaction intolerance',
  'dinner bedtime morning reminder routine',
  'daughter son doctor pharmacy emergency contact',
  'blood sugar log target fasting',
  'warfarin sertraline statin nitrate blood thinner',
];

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function isMainnetBlob(id) {
  return typeof id === 'string' && id.length >= 32 && !String(id).startsWith('local-');
}

function walruscanLink(blobId) {
  return isMainnetBlob(blobId) ? `https://walruscan.com/mainnet/blob/${blobId}` : null;
}

// ---------------------------------------------------------------------------
// UsageTracker
// ---------------------------------------------------------------------------
export class UsageTracker {
  constructor({ persistPath = null, now = Date.now } = {}) {
    this.persistPath = persistPath;
    this.now = now;
    this.users = new Map(); // userId -> { firstSeen, lastSeen, turns, memories: Map(blobId -> {text, at}) }
    this.startedAt = null;
    if (persistPath) this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const [u, rec] of Object.entries(raw.users || {})) {
        rec.memories = new Map(Object.entries(rec.memories || {}));
        if (!Array.isArray(rec.window)) rec.window = [];
        this.users.set(u, rec);
      }
      this.startedAt = raw.startedAt || null;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  #save() {
    if (!this.persistPath) return;
    const obj = { startedAt: this.startedAt, users: {} };
    for (const [u, rec] of this.users) {
      obj.users[u] = { ...rec, memories: Object.fromEntries(rec.memories) };
    }
    const tmp = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, this.persistPath);
  }

  touchUser(userId, { turn = false } = {}) {
    // Key normalisation stays exact here (no case folding): wallet keys arrive
    // already canonical and legacy case-variants heal in the read-time union
    // (server.js resolveUnionKeys) — never by rewriting these rows.
    const u = String(userId || '').slice(0, 64);
    if (!u) return;
    let rec = this.users.get(u);
    if (!rec) {
      rec = { firstSeen: new Date().toISOString(), lastSeen: null, turns: 0, memories: new Map() };
      this.users.set(u, rec);
    }
    if (turn) {
      rec.turns += 1;
      if (!Array.isArray(rec.window)) rec.window = [];
      let nowMs = Date.now();
      try { const n = this.now(); if (typeof n === 'number' && Number.isFinite(n)) nowMs = n; } catch { /* clock fallback */ }
      rec.window.push(nowMs);
      // Cap unknown on this path (server records turns via touchUser without
      // the budget cap): keep up to the safety bound, never pin at 50.
      if (rec.window.length > UsageTracker.WINDOW_KEEP_MAX) rec.window = rec.window.slice(-UsageTracker.WINDOW_KEEP_MAX);
      const today = UsageTracker.todayStr();
      if (!rec.day || rec.day.date !== today) rec.day = { date: today, count: 1 };
      else rec.day = { date: today, count: Number(rec.day.count || 0) + 1 };
    }
    rec.lastSeen = new Date().toISOString();
    this.#save();
  }

  recordMemory(userId, { blobId, text }) {
    if (!blobId) return false;
    const u = String(userId || '').slice(0, 64);
    if (!u) return false;
    let rec = this.users.get(u);
    if (!rec) this.touchUser(u);
    rec = this.users.get(u);
    const had = rec.memories.has(blobId);
    rec.memories.set(blobId, { text: String(text || '').slice(0, 500), at: new Date().toISOString() });
    rec.lastSeen = new Date().toISOString();
    this.#save();
    return !had;
  }

  // Rolling 24h sliding-window budget: abuse protection for the LLM + Walrus
  // write path. Spend today is $0 (sponsored Walrus writes + free OpenRouter
  // models), so these caps guard RATE (upstream throttles, relayer fairness),
  // not money.
  //
  // DEMO + ANON channels roll on a 24h sliding window: each key stores its turn
  // timestamps (ms epoch) and usedInWindow counts only timestamps within the
  // last 24h. Pruning keeps max(50, cap) rows wherever the cap is known
  // (checkDay): the old fixed-50 prune pinned `used` at 50, so any
  // rolling-mode cap above 50 silently never fired (fail-open). Where the cap
  // is NOT known at write time (touchUser/noteDay), history is kept up to the
  // WINDOW_KEEP_MAX safety bound, so growth stays bounded while no live turn
  // a real cap could count is ever dropped early. The WALLET channel (30 per
  // rolling 24h — owner cost cap) rolls on the same sliding window — pass
  // { mode: 'daily' } (or the legacy positional dayOverride string) to
  // checkDay/noteDay only for the legacy UTC-day bucket the stores retain as
  // a capability (no live channel uses it).
  //
  // checkDay(userId, cap, opts?) -> { ok, used, remaining, reset, resetAt, resetInHrs }
  //   opts: undefined (rolling now) | 'YYYY-MM-DD' (legacy daily override) |
  //         { mode: 'rolling'|'daily', now?, day? }
  //   reset = legacy UTC-day string (compat); resetAt = ISO of when the oldest
  //   in-window turn expires (null when empty); resetInHrs = ceiling hours to
  //   resetAt (null when empty).
  static todayStr(d = new Date()) {
    return d.toISOString().slice(0, 10); // UTC day bucket
  }
  static WINDOW_MS = 24 * 60 * 60 * 1000;
  static WINDOW_KEEP = 50;
  // Write-path safety bound (cap unknown at write time): ~300x the largest
  // real rolling cap (30) and covering the test-suite disable values, while
  // keeping per-key history bounded so unbounded growth is impossible.
  static WINDOW_KEEP_MAX = 10_000;
  // Prune target wherever the cap is known: the 50-row floor stands for small
  // caps, larger caps keep exactly what they may need to count.
  static #keepFor(cap, fallback) {
    return typeof cap === 'number' && Number.isFinite(cap) && cap >= 0
      ? Math.max(UsageTracker.WINDOW_KEEP, Math.ceil(cap))
      : fallback;
  }
  #nowMs(opts) {
    if (opts && typeof opts.now === 'number' && Number.isFinite(opts.now)) return opts.now;
    try {
      const n = this.now();
      return typeof n === 'number' && Number.isFinite(n) ? n : Date.now();
    } catch { return Date.now(); }
  }
  static #normOpts(modeOrDay) {
    if (typeof modeOrDay === 'string') return { mode: 'daily', day: modeOrDay };
    if (modeOrDay && typeof modeOrDay === 'object') {
      return {
        mode: modeOrDay.mode === 'daily' ? 'daily' : 'rolling',
        day: typeof modeOrDay.day === 'string' ? modeOrDay.day : null,
        now: modeOrDay.now,
      };
    }
    return { mode: 'rolling', day: null, now: undefined };
  }
  #prune(rec, nowMs, keep = UsageTracker.WINDOW_KEEP_MAX) {
    if (!Array.isArray(rec.window)) rec.window = [];
    const cutoff = nowMs - UsageTracker.WINDOW_MS;
    // Containment: only finite numbers are turns. Non-finite values (Infinity
    // from a corrupt ledger, strings/objects from hand-edited JSON) are
    // dropped, never counted — and an all-malformed window reads empty instead
    // of throwing on `new Date(Infinity)`. NaN was already excluded by `>` but
    // Infinity was not.
    rec.window = rec.window.filter((t) => typeof t === 'number' && Number.isFinite(t) && t > cutoff);
    if (rec.window.length > keep) {
      rec.window = rec.window.slice(-keep);
    }
    return rec.window;
  }
  #windowCheck(rec, cap, nowMs) {
    const live = rec ? this.#prune(rec, nowMs, UsageTracker.#keepFor(cap, UsageTracker.WINDOW_KEEP)) : [];
    const used = live.length;
    if (!used) {
      // Even an empty window consults the cap: a fail-closed 0 cap denies.
      return 0 < cap
        ? { ok: true, used: 0, remaining: cap, reset: UsageTracker.todayStr(new Date(nowMs)), resetAt: null, resetInHrs: null }
        : { ok: false, used: 0, remaining: 0, reset: UsageTracker.todayStr(new Date(nowMs)), resetAt: null, resetInHrs: null };
    }
    const oldest = Math.min(...live);
    const resetAt = new Date(oldest + UsageTracker.WINDOW_MS).toISOString();
    const resetInHrs = Math.max(1, Math.ceil((oldest + UsageTracker.WINDOW_MS - nowMs) / 3_600_000));
    return used < cap
      ? { ok: true, used, remaining: cap - used, reset: UsageTracker.todayStr(new Date(nowMs)), resetAt, resetInHrs }
      : { ok: false, used, remaining: 0, reset: UsageTracker.todayStr(new Date(nowMs)), resetAt, resetInHrs };
  }
  checkDay(userId, cap, modeOrDay) {
    // Fail-closed bound: a non-numeric (undefined/NaN/string/Infinity) or
    // negative cap can never open the gate — it coerces to 0, so every path
    // below denies with remaining:0. The empty-window branch used to return
    // ok:true without consulting the cap at all.
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) cap = 0;
    const u = String(userId || '').slice(0, 64);
    const opts = UsageTracker.#normOpts(modeOrDay);
    if (opts.mode === 'daily') {
      const today = opts.day || UsageTracker.todayStr();
      const rec = this.users.get(u);
      const used = rec && rec.day && rec.day.date === today ? Number(rec.day.count || 0) : 0;
      return used < cap
        ? { ok: true, used, remaining: cap - used, reset: today, resetAt: null, resetInHrs: null }
        : { ok: false, used, remaining: 0, reset: today, resetAt: null, resetInHrs: null };
    }
    const nowMs = this.#nowMs(opts);
    return this.#windowCheck(this.users.get(u), cap, nowMs);
  }
  #ensureRec(u) {
    let rec = this.users.get(u);
    if (!rec) {
      rec = { firstSeen: new Date().toISOString(), lastSeen: null, turns: 0, memories: new Map(), window: [] };
      this.users.set(u, rec);
    }
    if (!Array.isArray(rec.window)) rec.window = [];
    return rec;
  }
  #noteTurn(u, nowMs, keep = UsageTracker.WINDOW_KEEP_MAX) {
    const rec = this.#ensureRec(u);
    rec.window.push(nowMs);
    this.#prune(rec, nowMs, keep);
    const today = UsageTracker.todayStr(new Date(nowMs));
    if (!rec.day || rec.day.date !== today) rec.day = { date: today, count: 1 };
    else rec.day = { date: today, count: Number(rec.day.count || 0) + 1 };
  }
  noteDay(userId, modeOrDay) {
    const u = String(userId || '').slice(0, 64);
    if (!u) return;
    const opts = UsageTracker.#normOpts(modeOrDay);
    if (opts.mode === 'daily' && opts.day) {
      const rec = this.#ensureRec(u);
      if (!rec.day || rec.day.date !== opts.day) rec.day = { date: opts.day, count: 1 };
      else rec.day = { date: opts.day, count: Number(rec.day.count || 0) + 1 };
      return;
    }
    // The write path never knows the budget cap (no caller passes one — the
    // check-time cap was dead threading), so it always keeps the safety bound.
    this.#noteTurn(u, this.#nowMs(opts), UsageTracker.WINDOW_KEEP_MAX);
  }
  snapshot(userId) {
    // Slice to 64 exactly like the write paths (touchUser/recordMemory):
    // a 66-char wallet address is stored under its 64-char prefix, so the
    // read must normalise identically or it misses its own row.
    const id = String(userId).slice(0, 64);
    const rec = this.users.get(id);
    if (!rec) return { userId: id, namespace: namespaceFor(id), turns: 0, memories: 0, firstSeen: null, lastSeen: null, blobs: [] };
    return {
      userId: id,
      namespace: namespaceFor(id),
      firstSeen: rec.firstSeen,
      lastSeen: rec.lastSeen,
      turns: rec.turns,
      memories: rec.memories.size,
      meetsMinimum: rec.memories.size >= 10,
      blobs: [...rec.memories.entries()].map(([blobId, m]) => ({ blobId, ...m, link: walruscanLink(blobId) })),
    };
  }

  qualifies(snapshot, minUsers = 3, minMemories = 10) {
    const s = snapshot.filter((x) => x.memories >= minMemories);
    return {
      minUsers, minMemories,
      qualifyingUsers: s.length,
      meetsMinimum: s.length >= minUsers,
      totalMemories: snapshot.reduce((n, x) => n + x.memories, 0),
    };
  }

  // redactUser(userId) -> true hides blob TEXTS (counts + ids stay) in every
  // rendering of this summary (json rows, md). Same rule as the route layer.
  summary({ users = USERS, mode = 'local', minUsers = 3, minMemories = 10, redactUser = null } = {}) {
    const snap = users.map((u) => this.snapshot(u));
    const q = this.qualifies(snap, minUsers, minMemories);
    const generatedAt = new Date().toISOString();
    const json = {
      generatedAt, mode,
      requirement: { distinctUsers: minUsers, memoriesPerUser: minMemories },
      ...q,
      users: snap,
    };
    const rows = snap.map((s) => {
      const shown = (b) => (redactUser && redactUser(s.userId) ? '[redacted — not your namespace]' : b.text.replace(/^User\s+\S+:\s*/i, ''));
      const blobList = s.blobs.length
        ? s.blobs.map((b) => `\n     - ${b.blobId} — ${shown(b)}${b.link ? `\n       ${b.link}` : ''}`).join('')
        : '\n     - (none recorded)';
      const okMark = s.meetsMinimum ? '✅' : '❌';
      return `  ${okMark} ${s.userId}: ${s.memories} memories, ${s.turns} chat turns${s.firstSeen ? ` · since ${s.firstSeen}` : ''}${blobList}`;
    }).join('\n');
    const md = [
      '# USAGE — distinct real users × memories per user (hackathon requirement)',
      '',
      `Generated: ${generatedAt} · mode: **${mode}**`,
      '',
      `**Requirement: ≥${minUsers} distinct users × ≥${minMemories} memories each — currently ${q.qualifyingUsers >= minUsers ? 'MET ✅' : `NOT MET (${q.qualifyingUsers}/${minUsers} users qualify)`}.**`,
      '',
      ...snap.map((s) => `## ${s.userId} — ${s.memories} memories${s.meetsMinimum ? ' ✅' : ''}\n\n` +
        (s.blobs.length
          ? s.blobs.map((b) => `- \`${b.blobId}\` — ${redactUser && redactUser(s.userId) ? '[redacted — not your namespace]' : b.text.replace(/^User\s+\S+:\s*/i, '')}${b.link ? ` — [walruscan](${b.link})` : ' (local demo id, not Mainnet)'}`).join('\n')
          : '_no memories recorded_')),
      '',
      '_Every blob id above was returned by a real `rememberAndWait` after the write gate — nothing inferred, nothing padded._',
    ].join('\n');
    return { json, md, rows };
  }
}

// ---------------------------------------------------------------------------
// GuardProof — tamper-evident, append-only STOP/CAUTION ledger
// ---------------------------------------------------------------------------
// Guard body serialisation lives in ./guardBody.js — ONE shared definition
// with db.js (byte-identical hashes on both stores, so mixed chains verify).
export class GuardProof {
  constructor({ persistPath = null } = {}) {
    this.persistPath = persistPath;
    this.entries = [];
    if (persistPath) this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      this.entries = Array.isArray(raw.entries) ? raw.entries : [];
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  #save() {
    if (!this.persistPath) return;
    const tmp = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2));
    fs.renameSync(tmp, this.persistPath);
  }

  record({ userId, kind, substance, withSubstance, severity, reason, fact, blobId, message, ns }) {
    const prev = this.entries.length ? this.entries[this.entries.length - 1].hash : '';
    const f = String(fact || '').slice(0, 500);
    const m = String(message || '').slice(0, 500);
    const b = blobId || null;
    // Slice BEFORE hashing (same as SqliteGuards): verify() recomputes over
    // the stored (sliced) values, so >500-char receipts verify identically on
    // both stores. Short facts hash byte-identical to before (slice is a no-op).
    const body = guardBody({ userId, kind, substance, withSubstance, severity, reason, fact: f, blobId: b, message: m, ns, prev });
    const entry = {
      n: this.entries.length + 1,
      at: new Date().toISOString(),
      userId, kind, substance, withSubstance, severity, reason,
      fact: f,
      blobId: b,
      message: m,
      ...(ns != null ? { ns } : {}),
      prev,
      hash: hash(body),
    };
    this.entries.push(entry);
    this.#save();
    return entry;
  }

  list({ limit = 100 } = {}) {
    return this.entries.slice(-limit).reverse();
  }

  // Recompute the whole chain; returns { ok, brokenAt } — brokenAt = 1-based n of
  // the first entry whose hash (or prev-link) no longer verifies.
  // Migration fallback (reviewer wave-13): record() hashes the SLICED
  // fact/message, but pre-existing rows hashed the UNSLICED values. The sliced
  // body is tried first, then the legacy unsliced body — a row verifies under
  // either historically-real serialisation; anything else is still tamper
  // (the fallback never trusts: both attempts are full hash comparisons, and
  // the prev-link is always enforced).
  verify() {
    const sliced = (v) => (typeof v === 'string' ? v.slice(0, 500) : v);
    let prev = '';
    for (const e of this.entries) {
      const fields = { userId: e.userId, kind: e.kind, substance: e.substance, withSubstance: e.withSubstance, severity: e.severity, reason: e.reason, blobId: e.blobId, ns: e.ns };
      const bodyNow = guardBody({ ...fields, fact: sliced(e.fact), message: sliced(e.message), prev });
      if (e.prev === prev && e.hash === hash(bodyNow)) { prev = e.hash; continue; }
      const bodyLegacy = guardBody({ ...fields, fact: e.fact, message: e.message, prev });
      if (e.prev === prev && e.hash === hash(bodyLegacy)) { prev = e.hash; continue; }
      return { ok: false, brokenAt: e.n };
    }
    return { ok: true, brokenAt: null, count: this.entries.length };
  }

  // Vault-namespaced receipt count (server.js vaultGuardCount falls back to
  // list() filtering when this is absent — keep both in agreement).
  countByNs(ns) {
    return this.entries.filter((e) => e && e.ns === ns).length;
  }
}

// ---------------------------------------------------------------------------
// Proactive safety briefs + the daily tick
// ---------------------------------------------------------------------------

// Human morning brief from the user's OWN memories: today's meds, the allergy,
// and a gentle nudge toward the printable card. Deterministic, no LLM.
export function morningBriefFromRecall(facts) {
  if (!facts || !facts.length) return null;
  const g = classifyFacts(facts.map((r) => r.text ?? r));
  if (!g.medications.length) return null;
  const lines = [];
  lines.push('☀️ Good morning — here is today\'s plan, from memory:');
  for (const m of g.medications) lines.push(`• ${String(m).replace(/^User\s+\S+:\s*/i, '')}`);
  if (g.allergies.length) lines.push(`⚠️ Allergies on file: ${g.allergies.map((a) => String(a).replace(/^User\s+\S+:\s*/i, '')).join('; ')}`);
  lines.push('Your emergency card is ready any time: /print');
  return lines.join('\n');
}

// Nightly cross-check of the FULL namespace with the same interaction table the
// chat guard uses — catches pairs taught on different days. Deterministic.
export function nightlyCrossCheckFromRecall(facts) {
  if (!facts || !facts.length) return [];
  const texts = facts.map((r) => String(r.text ?? r));
  const findings = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = 0; j < texts.length; j++) {
      if (i === j) continue;
      const hit = findInteraction(`what about ${texts[i]}`, [texts[j] ? { text: texts[j], blob_id: facts[j]?.blob_id ?? null } : null].filter(Boolean));
      if (hit) findings.push({ ...hit, factB: texts[j], blobIdB: facts[j]?.blob_id ?? null });
    }
  }
  // One line per unordered substance pair (both scan directions collapse).
  const seen = new Set();
  return findings.filter((f) => {
    const key = [f.substance, f.withSubstance].sort().join('+');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// One scheduled pass for a user: morning brief + nightly cross-check, with the
// whole namespace read once. Returns null when there is nothing to send.
export async function tickOnce(client, { hour = new Date().getUTCHours() } = {}) {
  const ra = await recallAllMeta(client, ALL_ANGLES, 25);
  if (!ra.facts.length) return null;
  const out = [];
  if (hour < 12) {
    const brief = morningBriefFromRecall(ra.facts);
    if (brief) out.push({ kind: 'morning-brief', text: brief });
  }
  const issues = nightlyCrossCheckFromRecall(ra.facts);
  if (issues.length) {
    out.push({
      kind: 'interaction-check',
      text: `🌙 Evening safety check — ${issues.length} interaction warning${issues.length === 1 ? '' : 's'} found in your saved memories:\n` +
        issues.map((f) => `• ${f.substance} × ${f.withSubstance}${f.severity === 'high' ? ' (STOP-level)' : ''}: ${f.reason}`).join('\n'),
    });
  }
  if (!out.length) return null;
  return { hour, items: out, degraded: ra.degraded };
}

export { namespaceFor };
