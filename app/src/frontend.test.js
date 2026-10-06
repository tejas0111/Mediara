// Frontend honesty smoke: static guards for the user-visible client + print/replay.
// No DOM runner needed — these assert the shipped files keep the honesty fixes:
// blob receipts printable, replay facts hidden from AT until played, day labels
// proportional (not fictional), no innerHTML-user-data, single esc definition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('print keeps blob receipts visible (the whole point of /print)', () => {
  assert.ok(!/@media print\{[^}]*\.blobid\{display:none/.test(css), 'print stylesheet must not hide .blobid');
  assert.ok(/\.blobid\{display:inline/.test(css), 'print stylesheet shows blob ids on paper');
});

test('replay facts are hidden from assistive tech until played', () => {
  assert.ok(page.includes('aria-hidden="true"'), 'server-rendered replay items carry aria-hidden');
  assert.ok(js.includes("setAttribute('aria-hidden'") && js.includes("removeAttribute('aria-hidden')"), 'client toggles aria-hidden on play');
  assert.ok(css.includes('.replay-facts li:not(.show){visibility:hidden}'), 'hidden facts are visibility:hidden, not opacity-only');
});

test('replay day labels are proportional, not a fictional fixed array', () => {
  assert.ok(!js.includes('var days = [1, 7, 14,'), 'fictional fixed day array is gone');
  assert.ok(js.includes('dayFor'), 'proportional dayFor(idx, total) mapping exists');
  assert.ok(!page.includes('Day 87 \\u2014 STOP') && !page.includes('Day 87 — STOP'), 'hardcoded Day-87 STOP caption is gone');
});

test('client never injects user data via innerHTML', () => {
  const hits = [...js.matchAll(/innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(hits.every((h) => h === "''" || h === '""'), `innerHTML only clears, never renders data: ${JSON.stringify(hits)}`);
  assert.ok(js.includes('textContent') && js.includes('createTextNode'), 'client renders via textContent/createTextNode');
});

test('single HTML-escape definition (no esc drift)', () => {
  assert.ok(page.includes('export const esc'), 'page.js exports the single esc');
  assert.ok(server.includes("ledgerPage, esc } from './page.js'") || server.includes(", esc } from './page.js'"), 'server imports esc from page.js');
  assert.equal((server.match(/const esc = \(s\) =>/g) || []).length, 0, 'server has no duplicate esc definition');
});

// ------------------------------------------------- React SPA contract ---
// The / route serves app/web/dist. These guard the bundle contract and the
// honesty properties ported from the legacy UI (blob receipts on paper,
// replay a11y, no raw-HTML user rendering).
import { fileURLToPath as __f } from 'node:url';
const WEB = path.join(path.dirname(__f(import.meta.url)), '..', 'web');
const wread = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

test('SPA bundle is built and CSP-compatible (no inline scripts)', () => {
  const html = wread('dist/index.html');
  assert.ok(html.includes('/app/assets/'), 'bundle assets served under /app/');
  assert.ok(!/<script>/.test(html), 'no inline <script> (CSP script-src self holds)');
  assert.ok(!/dangerouslySetInnerHTML/.test(wread('src/App.tsx') + wread('src/ChatView.tsx')), 'chat/shell never inject raw HTML');
  const srcs = ['src/App.tsx', 'src/ChatView.tsx', 'src/WalletView.tsx', 'src/api.ts', 'src/ui.tsx', 'src/chat.ts',
    'src/views/MemoryView.tsx', 'src/views/DemoView.tsx', 'src/views/ReplayView.tsx', 'src/views/CompareView.tsx',
    'src/views/GuardProofView.tsx', 'src/views/StatsView.tsx', 'src/views/PrintView.tsx'].map(wread).join('\n');
  assert.equal((srcs.match(/dangerouslySetInnerHTML/g) || []).length, 0, 'no view renders raw HTML anywhere');
});

test('SPA replay keeps a11y + honest day labels', () => {
  const v = wread('src/views/ReplayView.tsx');
  assert.ok(v.includes('aria-hidden'), 'unrevealed facts hidden from AT');
  assert.ok(v.includes('dayFor'), 'proportional day labels');
  assert.ok(!v.includes('Day 87'), 'no hardcoded Day-87 caption');
  assert.ok(v.includes('prefers-reduced-motion') || v.includes('reduce'), 'reduced-motion honored');
});

test('SPA print keeps blob receipts and hides only chrome', () => {
  const css = wread('src/views/PrintView.css');
  assert.ok(css.includes('.sidebar') && css.includes('.topbar'), 'print hides the app chrome');
  assert.ok(!/\.pr-blobids\s*\{[^}]*display:\s*none/.test(css), 'blob receipts stay visible on paper');
  const app = wread('src/App.tsx');
  assert.ok(app.includes('"sidebar"') || app.includes("'sidebar'") || app.includes('sidebar'), 'shell sidebar class exists for print-hiding');
  assert.ok(wread('src/views/PrintView.tsx').includes('shortBlob'), 'print cites blob ids per fact');
});

test('SPA chat renders STOPs as safety cards with receipts', () => {
  const c = wread('src/ChatView.tsx');
  assert.ok(c.includes('STOP') && c.includes('#/proof'), 'STOP links to guard proof');
  assert.ok(c.includes('shortBlob'), 'STOP cites the firing blob');
  assert.ok(c.includes('500'), 'composer enforces the 500-char contract');
  assert.ok(c.includes('Confirm with your doctor'), 'disclaimer always rendered');
});

test('SPA api client covers every JSON route the views need', () => {
  const api = wread('src/api.ts');
  for (const p of ['/api/chat', '/api/summary', '/api/export', '/api/seed-status', '/api/guard-proof',
    '/api/proactive', '/api/usage', '/api/auth/message', '/api/auth/verify', '/api/auth/logout',
    '/api/wallet/status', '/api/wallet/onboard/create', '/api/wallet/onboard/link',
    '/api/wallet/onboard/complete', '/api/wallet/relink']) {
    assert.ok(api.includes(`'${p}'`) || api.includes(`\`${p}`), `api.ts covers ${p}`);
  }
});

test('SPA shell layout: features above history, account at bottom, topbar always on', () => {
  const app = wread('src/App.tsx');
  const css = wread('src/App.css');
  assert.ok(app.indexOf('Features') < app.indexOf('Chats'), 'Features nav renders above chat history');
  assert.ok(app.includes('className="acct"') && app.includes('Account'), 'sidebar bottom has the account block + dialog');
  assert.ok(app.includes('VIEW_TITLES[view]'), 'topbar shows the current view title');
  assert.ok(app.includes('top-right') && app.includes('Connect wallet'), 'topbar right cluster has the wallet action');
  assert.ok(/\.topbar \{\s*\n?\s*display: flex/.test(css), 'topbar is always visible, not mobile-only');
  assert.ok(css.includes('.side-grow') && css.includes('.acct'), 'history grows+scrolls, account styles exist');
});

test('SPA print still hides only chrome after the reshuffle', () => {
  const css = wread('src/views/PrintView.css');
  assert.ok(css.includes('.sidebar') && css.includes('.topbar'), 'print hides sidebar + topbar');
  assert.ok(!/\.pr-blobids\s*\{[^}]*display:\s*none/.test(css), 'blob receipts stay visible on paper');
});

test('SPA wallet uses Sui dAppKit (server verifies Sui signatures only)', () => {
  const srcs = ['src/App.tsx', 'src/ChatView.tsx', 'src/WalletView.tsx', 'src/main.tsx', 'src/api.ts', 'src/ui.tsx', 'src/chat.ts',
    'src/views/MemoryView.tsx', 'src/views/DemoView.tsx', 'src/views/ReplayView.tsx', 'src/views/CompareView.tsx',
    'src/views/GuardProofView.tsx', 'src/views/StatsView.tsx', 'src/views/PrintView.tsx'].map(wread).join('\n');
  assert.equal((srcs.match(/window\.ethereum/g) || []).length, 0, 'no ethereum signing path (it can never verify)');
  const main = wread('src/main.tsx');
  assert.ok(main.includes('SuiClientProvider') && main.includes('WalletProvider'), 'dAppKit providers mounted');
  const wv = wread('src/WalletView.tsx');
  assert.ok(wv.includes('useSignPersonalMessage') && wv.includes('ConnectButton'), 'sign-in via dAppKit personal message');
});

test('SPA shell copy is self-explanatory (no mystery badges)', () => {
  const app = wread('src/App.tsx');
  assert.ok(!app.includes("'local?'") && !app.includes('"local?"'), 'no bare "local?" badge text');
  assert.ok(app.includes('Local demo') && app.includes('stand-in'), 'mode badge explains the backend');
  const css = wread('src/App.css') + wread('src/tokens.css');
  assert.ok(css.includes('#ffffff') && css.includes('#f3f4f6'), 'topbar white-to-grey tone present');
});

test('SPA wallet connects in one click (no double prompt)', () => {
  const app = wread('src/App.tsx');
  assert.ok(app.includes('connectText="Connect wallet"'), 'topbar opens the chooser directly');
  assert.ok(app.includes('@mysten/dapp-kit'), 'topbar uses dAppKit state, not navigation-only');
});

test('SPA views share one aligned scroll column + env toggle wiring', () => {
  const shell = wread('src/App.css');
  for (const root of ['.mem-wrap', '.demo-wrap', '.replay-wrap', '.cmp-wrap', '.gp-wrap', '.st-wrap']) {
    assert.ok(shell.includes(root), `shell aligns ${root} in the shared column`);
  }
  assert.ok(shell.includes('overflow-y: auto') && shell.includes('max-width: 860px'), 'shared column scrolls centered');
  const api = wread('src/api.ts');
  assert.ok(api.includes('getApiBase') && api.includes('setApiBase') && api.includes('checkHealth'), 'api base routing exists');
  const app = wread('src/App.tsx');
  assert.ok(app.includes('Mainnet server URL') && app.includes('Environment'), 'Demo/Mainnet toggle + URL setting exist');
});
