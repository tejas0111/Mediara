// npm run stats — per-user usage evidence, straight from Walrus.
//
// Judges can run one command and see: distinct users, memories per user, and
// every blob id with its walruscan link. With --live the numbers ARE Walrus's
// numbers (multi-angle recall per namespace). Without it, the locally recorded
// usage ledger (from the server) is rendered and labelled as such — never
// presenting a local count as a Walrus count.
//
// Usage:
//   npm run stats                        # ledger view (what the server recorded)
//   npm run stats -- --live              # query Walrus live per namespace (needs keys)
//   npm run stats -- --live --users=demo-mom,user-a,user-b
//   npm run stats -- --json              # machine-readable (feeds the article/submission)
//
// Exit codes: 0 = requirement met, 1 = not met / unreachable, 2 = usage error.
import 'dotenv/config';
import fs from 'node:fs';
import { UsageTracker, USERS } from './usage.js';
import { createClient, namespaceFor } from './memory.js';
import { createLocalClient } from './localClient.js';

const args = process.argv.slice(2);
const live = args.includes('--live');
const asJson = args.includes('--json');
const usersArg = args.find((a) => a.startsWith('--users='));
const users = usersArg ? usersArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : USERS;
const minMemories = Number(args.find((a) => a.startsWith('--min='))?.split('=')[1]) || 10;
const MIN_USERS = 3;

// Multi-angle recall: a listing is not a relevance query — union several angles
// by text (lowest distance wins) so a namespace listing under-reports nothing.
const ANGLES = [
  'medications allergies routine family',
  'takes taking take dose pill tablet prescription mg mcg daily',
  'allergic rash avoid reaction intolerance',
  'dinner bedtime morning reminder routine',
  'daughter son doctor pharmacy emergency contact',
  'blood sugar log target fasting',
  'warfarin sertraline statin nitrate blood thinner',
];

// The server writes into `user-<id>` namespaces; stats reads the SAME ones
// (not stats-specific names) so the count a judge sees is the count the app wrote.
function clientFor(userId, mode) {
  const ns = namespaceFor(userId);
  if (mode === 'mainnet') return createClient({ namespace: ns });
  return createLocalClient({ namespace: ns });
}

const LEDGER_PATH = new URL('./usage-ledger.json', import.meta.url);

// Load the server-recorded ledger (read-only view; the CLI never writes to it).
function ledgerTracker() {
  const t = new UsageTracker({ persistPath: null });
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    for (const [u, rec] of Object.entries(raw.users || {})) {
      t.touchUser(u);
      for (const [blobId, m] of Object.entries(rec.memories || {})) {
        t.recordMemory(u, { blobId, text: m.text });
      }
    }
  } catch { /* no ledger yet — honest empty view */ }
  return t;
}

async function countLive(userId, mode) {
  const client = clientFor(userId, mode);
  const byText = new Map();
  for (const q of ANGLES) {
    try {
      const { results } = await client.recall({ query: q, limit: 25 });
      for (const r of results || []) {
        const key = String(r.text || '').trim().toLowerCase();
        if (!key) continue;
        const dist = r.distance ?? 1;
        const prev = byText.get(key);
        if (!prev || dist < (prev.distance ?? 1)) byText.set(key, { text: r.text, blobId: r.blob_id || null, distance: dist });
      }
    } catch (e) {
      return { userId, namespace: namespaceFor(userId), error: String(e.message || e).slice(0, 160) };
    }
  }
  return {
    userId,
    namespace: namespaceFor(userId),
    memories: byText.size,
    meetsMinimum: byText.size >= minMemories,
    blobs: [...byText.values()].map((m) => ({
      blobId: m.blobId,
      text: String(m.text).replace(/^User\s+\S+:\s*/i, ''),
      link: m.blobId && !String(m.blobId).startsWith('local-')
        ? `https://walruscan.com/mainnet/blob/${m.blobId}`
        : null,
    })),
  };
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: npm run stats [-- --live] [--json] [--users=a,b,c] [--min=10]');
    process.exit(2);
  }
  const mode = process.env.MEMWAL_MODE === 'mainnet' ? 'mainnet' : 'local';
  let snap, source;
  if (live) {
    source = `Walrus ${mode === 'mainnet' ? 'Mainnet relayer' : 'local store'} — live recall per namespace`;
    snap = [];
    let hadError = false;
    for (const u of users) {
      const s = await countLive(u, mode);
      snap.push(s);
      if (s.error) { console.error(`  ! ${u}: ${s.error}`); hadError = true; }
    }
    if (hadError) {
      console.error('Live counts incomplete — the memory backend was unreachable for at least one namespace.');
      process.exit(1);
    }
  } else {
    source = 'local usage ledger (server-recorded writes)';
    const t = ledgerTracker();
    const allUsers = [...new Set(users.concat([...t.users.keys()].filter(Boolean)))];
    snap = allUsers.map((u) => t.snapshot(u));
  }

  const qualifying = snap.filter((s) => !s.error && (s.memories ?? 0) >= minMemories);
  const met = qualifying.length >= MIN_USERS;
  const generatedAt = new Date().toISOString();

  const json = {
    generatedAt, mode, source,
    requirement: { distinctUsers: MIN_USERS, memoriesPerUser: minMemories },
    distinctUsers: qualifying.length,
    meetsMinimum: met,
    totalMemories: snap.reduce((n, s) => n + (s.memories ?? 0), 0),
    users: snap,
  };

  if (asJson) {
    console.log(JSON.stringify(json, null, 2));
  } else {
    const okMark = (b) => (b ? '✅' : '❌');
    console.log(`# USAGE — ${source}`);
    console.log(`Generated: ${generatedAt} · mode: ${mode}`);
    console.log(`\nRequirement: ≥${MIN_USERS} distinct users × ≥${minMemories} memories each → ${met ? 'MET ✅' : `NOT MET (${qualifying.length}/${MIN_USERS} qualify)`}\n`);
    for (const s of snap) {
      if (s.error) { console.log(`  ❌ ${s.userId}: ERROR — ${s.error}`); continue; }
      console.log(`  ${okMark(s.meetsMinimum)} ${s.userId} (${s.namespace}): ${s.memories} memories${s.turns != null ? `, ${s.turns} turns` : ''}`);
      for (const b of (s.blobs || []).slice(0, 50)) {
        console.log(`     - ${b.blobId || '(no blob id)'} — ${b.text}`);
        if (b.link) console.log(`       ${b.link}`);
      }
      if ((s.blobs || []).length > 50) console.log(`     … +${s.blobs.length - 50} more`);
    }
    console.log('\nRe-run with --live to read these counts straight from Walrus.');
    const evidencePath = new URL('../../evidence/USAGE-LEDGER.md', import.meta.url);
    const lines = [
      `\n## ${generatedAt} — ${source}`,
      `Requirement: ≥${MIN_USERS} users × ≥${minMemories} memories → ${met ? 'MET' : 'NOT MET'} (${qualifying.length}/${MIN_USERS})`,
      ...snap.map((s) => s.error
        ? `- ❌ ${s.userId}: ERROR ${s.error}`
        : `- ${s.meetsMinimum ? '✅' : '❌'} ${s.userId} (${s.namespace}): ${s.memories} memories` +
          (s.blobs || []).map((b) => `\n  - \`${b.blobId || '?'}\` ${b.text}${b.link ? ` — ${b.link}` : ''}`).join('')),
      '',
    ];
    fs.appendFileSync(evidencePath, lines.join('\n'));
    console.log('Appended to evidence/USAGE-LEDGER.md');
  }

  process.exit(met ? 0 : 1);
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
