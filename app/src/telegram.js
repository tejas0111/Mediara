// DoseDaughter Telegram bot (Walrus Sessions 8) — polling, no polyfills.
// Setup:
//   1. Chat BotFather on Telegram → /newbot → copy token.
//   2. Add to app/.env: TELEGRAM_BOT_TOKEN=<token> (plus OPENROUTER_API_KEY optional, MEMWAL_MODE=local default).
//   3. Install polling dep: npm i node-telegram-bot-api (from app/ dir).
//   4. Run: node src/telegram.js
// Notes: per-chat namespace user-tg-<chatId>; mainnet mode needs MEMWAL keys (not present — stays local).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  namespaceFor,
  createClient,
  shouldRemember,
  findConflict,
  findInteraction,
  classifyFacts,
  rememberAndWait,
  recallRelevant,
  buildSystemPrompt,
} from './memory.js';
import { createLocalClient } from './localClient.js';

const require = createRequire(import.meta.url);
let TelegramBot;
try {
  TelegramBot = require('node-telegram-bot-api');
} catch {
  console.error('Missing dependency: node-telegram-bot-api is not installed.');
  console.error('Run from app/: npm i node-telegram-bot-api  then  node src/telegram.js');
  process.exit(1);
}
TelegramBot = TelegramBot.default ?? TelegramBot;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env (ask BotFather for a token), then node src/telegram.js');
  process.exit(1);
}

const MODE = process.env.MEMWAL_MODE === 'mainnet' ? 'mainnet' : 'local';
const DISCLAIMER = 'Confirm with your doctor — this is not medical advice.';
const chatNamespace = (chatId) => namespaceFor(`tg-${chatId}`);

function clientFor(chatId) {
  const ns = chatNamespace(chatId);
  if (MODE === 'mainnet') return { client: createClient({ namespace: ns }), ns, mode: 'mainnet' };
  return { client: createLocalClient({ namespace: ns }), ns, mode: 'local' };
}

async function callLLM(system, userMessage) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.LLM_MODEL || 'google/gemini-2.5-flash';
  if (!apiKey) return `[no LLM key] system would inject ${system.length} chars of memory. You said: ${userMessage}`;
  const models = [model, 'inclusionai/ling-3.0-flash-vl:free', 'liquid/lfm-2.5-2.6b:free', 'nex-agi/nex-n2.5-mini:free'].filter((m, i, a) => a.indexOf(m) === i);
  for (const m of models) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, max_tokens: 400, messages: [{ role: 'system', content: system }, { role: 'user', content: userMessage }] }),
      });
      const data = await res.json();
      if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
    } catch { /* try next model */ }
  }
  return `[LLM unavailable — memory still works] You said: ${userMessage}`;
}

const START_TEXT =
  'Hi, I am DoseDaughter — I remember meds so you do not have to repeat them.\n' +
  'Tell me 3 facts to start:\n1) Daily meds with times (e.g. "I take Metformin 8pm after food")\n' +
  '2) Allergies (e.g. "Allergic to ibuprofen")\n3) Routine (e.g. "Mom dinner 7pm, bedtime 10pm").\n' +
  'Commands: /memory /summary /reset.';

function formatMemory(recalled) {
  if (!recalled.length) return `Nothing remembered yet. Send your 3 facts first.\n${DISCLAIMER}`;
  return recalled
    .map((r) => {
      const id = r.blob_id || 'pending';
      const tag = String(id).startsWith('local-') ? `LOCAL ${id}` : id;
      return `- ${r.text} [${tag}]`;
    })
    .join('\n');
}

// Reuse the shared, negation-aware classifier so Telegram and web agree.
function compileSummary(recalled) {
  return classifyFacts(recalled.map((r) => r.text));
}

function resetLocalNamespace(ns) {
  const store = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.local-memory.json');
  try {
    const db = JSON.parse(fs.readFileSync(store, 'utf8'));
    if (db.namespaces) delete db.namespaces[ns];
    const tmp = store + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, store);
    return true;
  } catch {
    return false;
  }
}

const bot = new TelegramBot(TOKEN, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const text = String(msg.text || '').trim();
  if (!chatId || !text) return;
  try {
    if (text.startsWith('/start')) return void (await bot.sendMessage(chatId, START_TEXT));
    if (text.startsWith('/memory')) {
      const { client } = clientFor(chatId);
      const recalled = await recallRelevant(client, 'all medications allergies routine family', 20);
      return void (await bot.sendMessage(chatId, `${formatMemory(recalled)}\n${DISCLAIMER}`));
    }
    if (text.startsWith('/summary')) {
      const { client } = clientFor(chatId);
      const recalled = await recallRelevant(client, 'medications allergies routine family doctor pharmacy', 20);
      const s = compileSummary(recalled);
      const sec = (name, arr) => `${name}: ${arr.length ? arr.join('; ') : '—'}`;
      return void (await bot.sendMessage(
        chatId,
        `${sec('medications', s.medications)}\n${sec('allergies', s.allergies)}\n${sec('routine', s.routine)}\n${sec('familyAndCare', s.familyAndCare)}\n${DISCLAIMER}`,
      ));
    }
    if (text.startsWith('/reset')) {
      const { ns } = clientFor(chatId);
      if (MODE === 'local') resetLocalNamespace(ns);
      return void (await bot.sendMessage(
        chatId,
        MODE === 'local'
          ? 'Local memory for this chat cleared. Fresh start — send your 3 facts again.'
          : 'Reset requested. Note: Walrus blobs persist till epoch expiry on mainnet; local rows only would be cleared.',
      ));
    }
    if (text.startsWith('/')) return void (await bot.sendMessage(chatId, 'Commands: /start /memory /summary /reset'));

    const { client } = clientFor(chatId);
    const recalled = await recallRelevant(client, text, 5);
    // Coded safety nets FIRST (identical to web): allergy conflict, then curated
    // drug–drug interaction. Neither must differ between channels.
    const conflict = findConflict(text, recalled);
    const interaction = conflict ? null : findInteraction(text, recalled);
    let reply;
    if (conflict) {
      reply = `STOP — do not give ${conflict.substance}. Recalled allergy: "${conflict.fact}"${conflict.blob_id ? ` (blob ${conflict.blob_id})` : ''}. ${DISCLAIMER}`;
    } else if (interaction) {
      const lead = interaction.severity === 'high' ? 'STOP' : 'CAUTION';
      reply = `${lead} — ${interaction.substance} may interact with ${interaction.withSubstance}${interaction.blob_id ? ` (blob ${interaction.blob_id})` : ''}: ${interaction.reason}. ${DISCLAIMER}`;
    } else {
      reply = await callLLM(buildSystemPrompt(recalled), text);
    }
    let savedNote = '';
    // Never persist a message a guard just blocked.
    if (!conflict && !interaction && shouldRemember(text)) {
      try {
        const saved = await rememberAndWait(client, `User tg-${chatId}: ${text}`);
        if (saved?.blob_id) savedNote = ` (saved ${saved.blob_id})`;
      } catch { /* best-effort: a failed write is not fatal */ }
    }
    await bot.sendMessage(chatId, `${reply}${savedNote}\n${DISCLAIMER}`);
  } catch (e) {
    try { await bot.sendMessage(chatId, `Error: ${String(e.message || e).slice(0, 300)}`); } catch { /* polling only */ }
  }
});

bot.on('polling_error', (e) => console.error('polling_error', String(e.message || e).slice(0, 200)));

console.log(`DoseDaughter Telegram bot polling (mode=${MODE}). Press Ctrl+C to stop.`);
