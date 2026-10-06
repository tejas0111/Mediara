// One-command demo seeding for judges: populates the demo-day7 namespace via the
// LOCAL stand-in (no server, no keys, no network). Run: node src/seed-demo.js
// Then: npm run dev → open /demo for the populated AFTER side.
// Scope: 3-fact quickstart (Metformin/allergy/routine). Full 12-fact seed = seed10.js.
// For MAINNET seeding use seed10.js with MEMWAL_MODE=mainnet + owner keys instead.
import { createLocalClient } from './localClient.js';
import { namespaceFor, recallRelevant } from './memory.js';

const client = createLocalClient({ namespace: namespaceFor('demo-day7') });
const facts = [
  'User demo-day7: My mom takes Metformin 500mg at 8pm after food',
  'User demo-day7: She is allergic to ibuprofen, causes severe rash',
  'User demo-day7: Dinner at 7:30pm, bedtime 10pm',
];
for (const text of facts) {
  const job = await client.remember(text);
  const done = await client.waitForRememberJob(job.job_id);
  console.log('seeded:', done.blob_id);
}
const probe = await recallRelevant(client, 'medications allergies routine family', 20);
console.log(`recall probe: ${probe.length} relevant (expect 3)`);
if (probe.length < 3) process.exit(1);
console.log('DEMO-SEED-OK — open /demo');
