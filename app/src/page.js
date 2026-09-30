// DoseDaughter — server-rendered page shells.
// Chat UI is the Deep Chat web component (MIT) vendored at /assets/deep-chat.bundle.js
// and wired by /assets/app.js; see /THIRD-PARTY-NOTICES.md for attribution.
// Pages are plain HTML (no build step): keeps `git clone && npm i && npm run dev` reproducible.
// Untrusted text is escaped server-side (esc).
const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Bump when public assets change so browsers don't serve a stale cached copy.
const ASSET_V = '4';

const TOP = (title, mode) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/assets/app.css?v=${ASSET_V}"></head><body>
<header class="top"><div class="wrap">
  <div><div class="brand"><span class="seal">&#129461;</span>DoseDaughter</div>
  <div class="tag">A caregiver chatbot that never re-asks a dose</div></div>
  <div style="text-align:right"><span class="badge ${mode === 'mainnet' ? 'mainnet' : 'local'}">${mode === 'mainnet' ? 'WALRUS MAINNET' : 'LOCAL DEMO'}</span>
  <div class="topnav"><a href="/">Chat</a><a href="/demo">Before/After</a></div></div>
</div></header>`;

const FOOT = (mode) => `<footer class="foot">
  Built on Walrus Memory &mdash; every remembered fact is a Seal-encrypted blob on Walrus${mode === 'mainnet' ? ' Mainnet' : ''}.
  ${mode === 'mainnet' ? 'Verify any fact on <a href="https://walruscan.com" target="_blank" rel="noopener">walruscan.com</a>.' : 'Set MEMWAL_MODE=mainnet with keys for real Mainnet storage.'}<br>
  Chat UI by <a href="https://deepchat.dev" target="_blank" rel="noopener">Deep Chat</a> (MIT) &middot; <a href="https://github.com/tejas0111/dosedaughter" target="_blank" rel="noopener">source</a><br>
  Confirm with your doctor &mdash; this is not medical advice.
</footer>`;

// ---------- chat widget ----------
export function chatPage({ mode, model }) {
  return TOP('DoseDaughter — chat', mode) + `
<div class="wrap" id="dd-app" data-mode="${esc(mode)}" data-model="${esc(model)}" data-default-user="demo-mom">
  <div class="authbar" id="authbar">
    <span class="who2" id="who2">Checking wallet&hellip;</span>
    <button class="btn connect" id="connect" style="display:none">Connect Sui Wallet</button>
    <a class="vault" id="vaultlink" style="display:none" target="_blank" rel="noopener"></a>
  </div>
  <div class="obsteps" id="obsteps"></div>
  <p class="signin-note" id="signnote">Your Sui wallet is your sign-in. Once connected, your memories live in <b>your own</b> on-chain vault (a MemWal account you create &amp; own) and DoseDaughter reads it with a delegate key you granted &mdash; revocable on the <a href="https://memory.walrus.xyz" target="_blank" rel="noopener">Walrus Memory dashboard</a>. Signature only &mdash; the sign-in itself costs nothing.</p>
  <div class="usertag"><label for="who">user id (no wallet? shared demo channel)</label>
    <input id="who" value="demo-mom" spellcheck="false" autocomplete="off"></div>
  <div class="layout">
    <div class="panel"><deep-chat id="chat"></deep-chat></div>
    <aside class="side">
      <div class="panel" id="stopwrap" style="display:none"><h3>Safety</h3><div class="stopbanner" id="stopbanner" style="display:none"></div></div>
      <div class="panel"><h3>Memory used</h3><ul class="memlist" id="memlist"><li class="none">Nothing yet &mdash; teach me a fact.</li></ul></div>
      <div class="panel" id="savedwrap" style="display:none"><h3>Just stored</h3><div class="toast" id="saved"></div></div>
      <div class="panel"><h3>Scope</h3><div class="scope" id="scope">&mdash;</div></div>
    </aside>
  </div>
  <div class="quick">
    <button data-msg="My mom takes Metformin 500mg at 8pm after food">1&middot; Teach: Metformin 8pm</button>
    <button data-msg="She is allergic to ibuprofen, causes rash">2&middot; Teach: ibuprofen allergy</button>
    <button data-msg="What meds does mom take?">3&middot; Ask: what meds?</button>
    <button data-msg="Can she take ibuprofen for her headache?">4&middot; Allergy trap &#9888;</button>
  </div>
  <div class="quick" style="margin-top:10px">
    <a class="btn ghost" id="memlink" href="/memory?user=demo-mom">See what it remembers</a>
    <a class="btn ghost" href="/demo">Day&nbsp;1 vs Day&nbsp;7</a>
    <a class="btn ghost" href="/api/summary?user=demo-mom">Doctor summary</a>
  </div>
</div>
${FOOT(mode)}
<script type="module" src="/assets/deep-chat.bundle.js?v=${ASSET_V}"></script>
<script type="module" src="/assets/app.js?v=${ASSET_V}"></script>
</body></html>`;
}

// ---------- memory receipts ----------
export function memoryPage({ user, mode, rows, agentShort }) {
  const items = rows.length
    ? rows.map((r) => {
        const bid = r.blob_id
          ? (String(r.blob_id).startsWith('local-') || mode === 'local'
            ? `<span class="bid loc" title="local demo id &#8212; never a Mainnet blob">LOCAL DEMO ${esc(String(r.blob_id).slice(0, 14))}&hellip;</span>`
            : `<a class="bid" href="https://walruscan.com/mainnet/blob/${encodeURIComponent(r.blob_id)}" target="_blank" rel="noopener" title="verify on walruscan">${esc(String(r.blob_id).slice(0, 12))}&hellip; &#8599;</a>`)
          : '';
        return `<li><span class="fact">${esc(r.text)}</span>${bid}</li>`;
      }).join('')
    : `<li><span class="fact"><i>Nothing remembered yet &#8212; say hi in the <a href="/">chat</a>.</i></span></li>`;
  const notice = mode === 'mainnet'
    ? `<div class="notice mainnet">All memory below is stored on <b>Walrus Mainnet</b> via Walrus Memory (Seal-encrypted). Every row links to its blob on walruscan &#8212; verify, don't trust.${agentShort ? ` Agent: <code>${esc(agentShort)}&hellip;</code>` : ''}</div>`
    : `<div class="notice local"><b>LOCAL DEMO</b> &#8212; file-backed stand-in memory, not Walrus Mainnet. The Mainnet path runs when MEMWAL_MODE=mainnet is set with keys.</div>`;
  return TOP('DoseDaughter — memory', mode) + `
<div class="wrap">
  <h1 class="pg">What DoseDaughter remembers &#8212; <code>${esc(user)}</code></h1>
  <p class="sub">${rows.length} fact${rows.length === 1 ? '' : 's'} &middot; recalled live from memory &middot; <a href="/">back to chat</a></p>
  ${notice}
  <ul class="receipts">${items}</ul>
</div>` + FOOT(mode) + `</body></html>`;
}

// ---------- before/after demo ----------
export function demoPage({ q, mode, before, after, afterNs, day7Empty }) {
  const list = (arr) => arr.length
    ? `<ul>${arr.map((m) => `<li>${esc(m.text)}<small>${esc(String(m.blob_id || '').slice(0, 12))}</small></li>`).join('')}</ul>`
    : `<ul><li class="none">no memories &#8212; generic answer, Day-1 amnesia</li></ul>`;
  return TOP('DoseDaughter — before/after', mode) + `
<div class="wrap">
  <h1 class="pg">Day 1 vs Day 7 &#8212; the same question, live recall</h1>
  <p class="sub">Both namespaces are queried live right now (mode: ${esc(mode)}). <a href="/">back to chat</a></p>
  <div class="qline">Q: &ldquo;${esc(q)}&rdquo;</div>
  <div class="two">
    <div class="panel dcard before">
      <h3>&#10005; BEFORE &#8212; Day 1 (never met you)</h3>
      <div class="count">${before.length} memor${before.length === 1 ? 'y' : 'ies'} in namespace <code>user-demo-day1</code></div>
      ${list(before)}
    </div>
    <div class="panel dcard after">
      <h3>&#10003; AFTER &#8212; Day 7 (remembers everything)</h3>
      <div class="count">${after.length} memor${after.length === 1 ? 'y' : 'ies'} in namespace <code>${esc(afterNs || 'user-demo-day7')}</code></div>
      ${list(after)}${day7Empty ? '<p class="sub"><i>Day-7 namespace is empty &#8212; teach it in the <a href="/">chat</a> as user <code>demo-day7</code>, then reload.</i></p>' : ''}
    </div>
  </div>
  <footer class="foot">This page runs <b>live recall</b> against both Walrus Memory namespaces &#8212; nothing is faked or cached.</footer>
</div>` + FOOT(mode) + `</body></html>`;
}
