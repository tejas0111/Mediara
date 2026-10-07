// SQLite usage + guard-proof store (zero new deps — node:sqlite, Node 22).
//
// Default DB path: `data/dosedughter.db` relative to this file (src/data/).
// NOTE: `data/` is NOT in .gitignore (only node_modules/.env/*.log etc. are),
// so the owner should add `data/` (or `src/data/`) to .gitignore to keep the
// local ledger out of git.
//
// Tables:
//   usage(userId PK, firstSeen, lastSeen, turns INT, dayDate TEXT, dayCount INT)
//   memories(userId, blobId, text, at; PK(userId,blobId))
//   guards(n PK AUTOINCREMENT + all columns of a GuardProof entry + hash/prev)
//
// Interface parity with usage.js (UsageTracker-compatible + GuardProof-
// compatible): snapshot/touchUser/recordMemory/checkDay/noteDay/summary/
// qualifies and guard record/list/verify (+ an `entries` getter, since
// server.js reads guardProof.entries.length). The guard hash chain uses the
// EXACT same body serialisation as GuardProof, so verify() recomputes over
// SQL-read rows identically.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { namespaceFor } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'dosedughter.db');

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function isMainnetBlob(id) {
  return typeof id === 'string' && id.length >= 32 && !String(id).startsWith('local-');
}

function walruscanLink(blobId) {
  return isMainnetBlob(blobId) ? `https://walruscan.com/mainnet/blob/${blobId}` : null;
}

export function openDb(dbPath = DEFAULT_DB_PATH) {
  const p = String(dbPath || DEFAULT_DB_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage(
      userId TEXT PRIMARY KEY,
      firstSeen TEXT, lastSeen TEXT,
      turns INTEGER NOT NULL DEFAULT 0,
      dayDate TEXT, dayCount INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memories(
      userId TEXT NOT NULL, blobId TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', at TEXT,
      PRIMARY KEY(userId, blobId)
    );
    CREATE TABLE IF NOT EXISTS guards(
      n INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT, userId TEXT, kind TEXT,
      substance TEXT, withSubstance TEXT, severity TEXT,
      reason TEXT, fact TEXT, blobId TEXT, message TEXT,
      prev TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

// UTC day bucket. Same rule as UsageTracker.todayStr; `dayOverride` (a
// 'YYYY-MM-DD' string) exists so tests can exercise persist+rollover without
// faking the clock — pass it to checkDay/noteDay.
export const todayStr = (d = new Date()) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// SqliteUsage — UsageTracker-compatible usage evidence over SQLite.
// ---------------------------------------------------------------------------
export class SqliteUsage {
  constructor({ dbPath = DEFAULT_DB_PATH, db = null } = {}) {
    this.dbPath = db ? null : String(dbPath || DEFAULT_DB_PATH);
    this.db = db || openDb(this.dbPath);
  }

  #row(userId) {
    return this.db.prepare('SELECT * FROM usage WHERE userId = ?').get(String(userId));
  }

  #ensure(userId, nowIso) {
    const u = String(userId || '').slice(0, 64);
    if (!u) return null;
    if (!this.#row(u)) {
      this.db.prepare(
        'INSERT INTO usage(userId, firstSeen, lastSeen, turns, dayDate, dayCount) VALUES(?,?,?,?,?,?)',
      ).run(u, nowIso, null, 0, null, 0);
    }
    return u;
  }

  touchUser(userId, { turn = false } = {}) {
    const nowIso = new Date().toISOString();
    const u = this.#ensure(userId, nowIso);
    if (!u) return;
    if (turn) {
      const today = todayStr();
      const r = this.#row(u);
      const sameDay = r && r.dayDate === today;
      this.db.prepare('UPDATE usage SET turns = turns + 1, lastSeen = ?, dayDate = ?, dayCount = ? WHERE userId = ?')
        .run(nowIso, today, sameDay ? Number(r.dayCount || 0) + 1 : 1, u);
    } else {
      this.db.prepare('UPDATE usage SET lastSeen = ? WHERE userId = ?').run(nowIso, u);
    }
  }

  recordMemory(userId, { blobId, text }) {
    if (!blobId) return false;
    const nowIso = new Date().toISOString();
    const u = this.#ensure(userId, nowIso);
    if (!u) return false;
    const had = this.db.prepare('SELECT 1 FROM memories WHERE userId = ? AND blobId = ?').get(u, blobId);
    this.db.prepare('INSERT OR REPLACE INTO memories(userId, blobId, text, at) VALUES(?,?,?,?)')
      .run(u, blobId, String(text || '').slice(0, 500), nowIso);
    this.db.prepare('UPDATE usage SET lastSeen = ? WHERE userId = ?').run(nowIso, u);
    return !had;
  }

  checkDay(userId, cap, dayOverride = null) {
    const u = String(userId || '').slice(0, 64);
    const today = dayOverride || todayStr();
    const r = u ? this.#row(u) : null;
    const used = r && r.dayDate === today ? Number(r.dayCount || 0) : 0;
    return used < cap
      ? { ok: true, used, remaining: cap - used, reset: today }
      : { ok: false, used, remaining: 0, reset: today };
  }

  noteDay(userId, dayOverride = null) {
    const nowIso = new Date().toISOString();
    const u = this.#ensure(userId, nowIso);
    if (!u) return;
    const today = dayOverride || todayStr();
    const r = this.#row(u);
    this.db.prepare('UPDATE usage SET dayDate = ?, dayCount = ? WHERE userId = ?')
      .run(today, r && r.dayDate === today ? Number(r.dayCount || 0) + 1 : 1, u);
  }

  snapshot(userId) {
    const id = String(userId);
    const r = this.#row(id);
    if (!r) return { userId: id, namespace: namespaceFor(id), turns: 0, memories: 0, firstSeen: null, lastSeen: null, blobs: [] };
    const mems = this.db.prepare('SELECT blobId, text, at FROM memories WHERE userId = ? ORDER BY rowid').all(id);
    return {
      userId: id,
      namespace: namespaceFor(id),
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      turns: r.turns,
      memories: mems.length,
      meetsMinimum: mems.length >= 10,
      blobs: mems.map((m) => ({ blobId: m.blobId, text: m.text, at: m.at, link: walruscanLink(m.blobId) })),
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

  // Tracked-user enumeration for summary(): default USERS list plus every
  // userId actually seen (mirrors stats.js ledger behaviour).
  #allUsers(defaultUsers) {
    const seen = this.db.prepare('SELECT userId FROM usage ORDER BY userId').all().map((r) => r.userId);
    return [...new Set([...(defaultUsers || []), ...seen])];
  }

  summary({ users = null, mode = 'local', minUsers = 3, minMemories = 10 } = {}) {
    // Default tracked set matches usage.js USERS (imported lazily to avoid a
    // hard module cycle at load time — usage.js never imports db.js).
    const list = users || this.#allUsers(['demo-mom', 'user-a', 'user-b']);
    const snap = list.map((u) => this.snapshot(u));
    const q = this.qualifies(snap, minUsers, minMemories);
    const generatedAt = new Date().toISOString();
    const json = {
      generatedAt, mode,
      requirement: { distinctUsers: minUsers, memoriesPerUser: minMemories },
      ...q,
      users: snap,
    };
    const md = [
      '# USAGE — distinct real users × memories per user (hackathon requirement)',
      '',
      `Generated: ${generatedAt} · mode: **${mode}**`,
      '',
      `**Requirement: ≥${minUsers} distinct users × ≥${minMemories} memories each — currently ${q.qualifyingUsers >= minUsers ? 'MET ✅' : `NOT MET (${q.qualifyingUsers}/${minUsers} users qualify)`}.**`,
      '',
      ...snap.map((s) => `## ${s.userId} — ${s.memories} memories${s.meetsMinimum ? ' ✅' : ''}\n\n` +
        (s.blobs.length
          ? s.blobs.map((b) => `- \`${b.blobId}\` — ${b.text.replace(/^User\s+\S+:\s*/i, '')}${b.link ? ` — [walruscan](${b.link})` : ' (local demo id, not Mainnet)'}`).join('\n')
          : '_no memories recorded_')),
      '',
      '_Every blob id above was returned by a real `rememberAndWait` after the write gate — nothing inferred, nothing padded._',
    ].join('\n');
    const rows = snap.map((s) => {
      const blobList = s.blobs.length
        ? s.blobs.map((b) => `\n     - ${b.blobId} — ${b.text.replace(/^User\s+\S+:\s*/i, '')}${b.link ? `\n       ${b.link}` : ''}`).join('')
        : '\n     - (none recorded)';
      const okMark = s.meetsMinimum ? '✅' : '❌';
      return `  ${okMark} ${s.userId}: ${s.memories} memories, ${s.turns} chat turns${s.firstSeen ? ` · since ${s.firstSeen}` : ''}${blobList}`;
    }).join('\n');
    return { json, md, rows };
  }
}

// ---------------------------------------------------------------------------
// SqliteGuards — GuardProof-compatible tamper-evident ledger over SQLite.
// ---------------------------------------------------------------------------
export class SqliteGuards {
  constructor({ dbPath = DEFAULT_DB_PATH, db = null } = {}) {
    this.dbPath = db ? null : String(dbPath || DEFAULT_DB_PATH);
    this.db = db || openDb(this.dbPath);
  }

  // server.js reads guardProof.entries.length — expose all rows, oldest first
  // (same order as the JSON GuardProof.entries array).
  get entries() {
    return this.db.prepare('SELECT * FROM guards ORDER BY n ASC').all().map(toEntry);
  }

  get count() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM guards').get().c;
  }

  record({ userId, kind, substance, withSubstance, severity, reason, fact, blobId, message }) {
    const last = this.db.prepare('SELECT hash FROM guards ORDER BY n DESC LIMIT 1').get();
    const prev = last ? last.hash : '';
    const f = String(fact || '').slice(0, 500);
    const m = String(message || '').slice(0, 500);
    const b = blobId || null;
    // Body serialisation MUST match GuardProof.record in usage.js exactly:
    // JSON.stringify drops undefined-valued keys, and a JSON persist/load
    // round-trip drops them too — so undefined stays undefined in the body
    // (NULL in the row, mapped back to undefined on read in toEntry()).
    const body = JSON.stringify({ userId, kind, substance, withSubstance, severity, reason, fact: f, blobId: b, message: m, prev });
    const h = hash(body);
    const at = new Date().toISOString();
    const info = this.db.prepare(
      'INSERT INTO guards(at, userId, kind, substance, withSubstance, severity, reason, fact, blobId, message, prev, hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(at, userId, kind, substance ?? null, withSubstance ?? null, severity ?? null, reason ?? null, f, b, m, prev, h);
    return {
      n: Number(info.lastInsertRowid), at, userId, kind, substance, withSubstance, severity, reason,
      fact: f, blobId: b, message: m, prev, hash: h,
    };
  }

  list({ limit = 100 } = {}) {
    return this.db.prepare('SELECT * FROM guards ORDER BY n DESC LIMIT ?').all(limit).map(toEntry);
  }

  countByUser(userId) {
    return this.db.prepare('SELECT COUNT(*) AS c FROM guards WHERE userId = ?').get(String(userId)).c;
  }

  // Recompute the whole chain over SQL-read rows; same contract as
  // GuardProof.verify(): { ok, brokenAt }.
  verify() {
    const rows = this.db.prepare('SELECT * FROM guards ORDER BY n ASC').all().map(toEntry);
    let prev = '';
    for (const e of rows) {
      const body = JSON.stringify({ userId: e.userId, kind: e.kind, substance: e.substance, withSubstance: e.withSubstance, severity: e.severity, reason: e.reason, fact: e.fact, blobId: e.blobId, message: e.message, prev });
      if (e.prev !== prev || e.hash !== hash(body)) return { ok: false, brokenAt: e.n };
      prev = e.hash;
    }
    return { ok: true, brokenAt: null, count: rows.length };
  }
}

function toEntry(r) {
  // Optional guard columns read back as NULL; map them to undefined so the
  // verify() body serialisation matches GuardProof exactly (a JSON round-trip
  // drops undefined keys, so the JSON impl verifies without them too).
  const opt = (v) => (v == null ? undefined : v);
  return {
    n: r.n, at: r.at, userId: r.userId, kind: r.kind,
    substance: opt(r.substance), withSubstance: opt(r.withSubstance),
    severity: opt(r.severity), reason: opt(r.reason),
    fact: r.fact, blobId: r.blobId, message: r.message,
    prev: r.prev, hash: r.hash,
  };
}

// One shared connection for both facades (same DB file, no lock contention
// between two DatabaseSync handles).
export function createStores({ dbPath = DEFAULT_DB_PATH } = {}) {
  const db = openDb(dbPath);
  return { usage: new SqliteUsage({ db }), guardProof: new SqliteGuards({ db }), db };
}
