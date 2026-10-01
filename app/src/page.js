// DoseDaughter — server-rendered page shells (hand-written UI, no framework/build).
// Untrusted text is escaped server-side (esc); the client uses textContent only.
const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ASSET_V = '7';

const TOP = (title, mode) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/assets/app.css?v=${ASSET_V}">
<script type="module" src="/assets/app.js?v=${ASSET_V}"></script></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="bar">
  <div class="brand"><span class="logo">&#129461;</span>
    <div><h1>DoseDaughter</h1><p>a caregiver chatbot that never re-asks a dose</p></div></div>
  <nav class="topnav" aria-label="Primary">
    <a href="/">Chat</a><a href="/demo">Before / After</a><a href="/memory?user=demo-mom">Memory</a><a href="/print?user=demo-mom">Print</a><a href="/replay?user=demo-mom">Replay</a>
    <span class="pill ${mode === 'mainnet' ? 'mainnet' : 'local'}"><span class="dot"></span>${mode === 'mainnet' ? 'Walrus Mainnet' : 'Local demo'}</span>
  </nav>
</div></header>`;

const FOOT = (mode) => `<footer class="foot">
  Every remembered fact is a Seal-encrypted blob on Walrus${mode === 'mainnet' ? ' Mainnet' : ''}. ${mode === 'mainnet' ? 'Verify any fact on <a href="https://walruscan.com" target="_blank" rel="noopener">walruscan.com</a>.' : 'Set <span class="mono">MEMWAL_MODE=mainnet</span> with keys for real Mainnet storage.'}<br>
  <a href="https://github.com/tejas0111/dosedaughter" target="_blank" rel="noopener">source</a> &middot; <a href="/healthz">health</a> &middot; built for Walrus Session 8<br>
  Confirm with your doctor &mdash; this is not medical advice.
</footer>`;

// ---------- chat ----------
export function chatPage({ mode }) {
  return TOP('DoseDaughter \u2014 chat', mode) + `
<main class="wrap" id="main"><div id="dd-app" data-mode="${esc(mode)}" data-default-user="demo-mom">
  <div class="walletbar" id="walletbar">
    <span class="who" id="who2">Checking wallet&hellip;</span>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <a class="vault" id="vaultlink" style="display:none" target="_blank" rel="noopener"></a>
      <button class="btn dark" id="connect" style="display:none" type="button">Connect Sui Wallet</button>
    </div>
  </div>
  <div class="obsteps" id="obsteps"></div>
  <p class="note" id="signnote">Your Sui wallet is your sign-in. Connect it to keep memories in <b>your own</b> on-chain vault (a MemWal account you create &amp; own), read with a delegate key you can revoke. Signature only \u2014 no fee to sign in.</p>
  <div class="identity"><label for="who">user id</label><input id="who" value="demo-mom" spellcheck="false" autocomplete="off"></div>

  <div class="grid">
    <section class="chat card" aria-label="Chat with DoseDaughter">
      <div class="chat-head">
        <div class="ava">DD</div>
        <div><div class="who">DoseDaughter</div>
          <div class="status"><span class="live"></span><span>memory on &middot; <span id="chatmode">local demo</span></span></div></div>
      </div>
      <div class="thread" id="thread" role="log" aria-live="polite" aria-relevant="additions"></div>
      <div class="typing" id="typing"><span class="dots"><i></i><i></i><i></i></span><span class="muted" style="font-size:12.5px">remembering&hellip;</span></div>
      <form class="composer" id="composer">
        <textarea id="text" rows="1" placeholder="Say something&hellip; (e.g. \u201cMom takes Metformin 500mg at 8pm\u201d)" aria-label="Message"></textarea>
        <button class="send" id="send" type="submit" aria-label="Send message">&#10148;</button>
      </form>
    </section>

    <aside class="rail">
      <div class="card railcard" id="stopwrap" style="display:none"><h3>Safety</h3><div class="safety" id="stopbanner" style="display:none"></div></div>
      <div class="card railcard"><h3>Memory used</h3><ul class="memlist" id="memlist"><li class="none">Nothing yet &mdash; teach me a fact.</li></ul></div>
      <div class="card railcard" id="savedwrap" style="display:none"><h3>Just stored</h3><div class="toast" id="saved"></div></div>
      <div class="card railcard"><h3>Scope</h3><div class="scope" id="scope">&mdash;</div></div>
    </aside>
  </div>

  <div class="chips">
    <button class="chip" data-msg="My mom takes Metformin 500mg at 8pm after food"><span class="n">1</span>Teach: Metformin 8pm</button>
    <button class="chip" data-msg="She is allergic to ibuprofen, causes rash"><span class="n">2</span>Teach: ibuprofen allergy</button>
    <button class="chip" data-msg="What meds does mom take?"><span class="n">3</span>Ask: what meds?</button>
    <button class="chip" data-msg="Can she take ibuprofen for her headache?"><span class="n">4</span>Allergy trap &#9888;</button>
  </div>
  <div class="chips">
    <a class="chip ghost" id="memlink" href="/memory?user=demo-mom">See what it remembers</a>
    <a class="chip ghost" href="/demo">Day&nbsp;1 vs Day&nbsp;7</a>
    <a class="chip ghost" href="/api/summary?user=demo-mom">Doctor summary</a>
  </div>
  ${FOOT(mode)}
</div></main>
</body></html>`;
}

// ---------- memory receipts ----------
export function memoryPage({ user, mode, rows, agentShort }) {
  const items = rows.length
    ? rows.map((r) => {
        const bid = r.blob_id
          ? (String(r.blob_id).startsWith('local-') || mode === 'local'
            ? `<span class="blobid local" title="local demo id \u2014 never a Mainnet blob">\u25CF ${esc(String(r.blob_id).slice(0, 14))}\u2026</span>`
            : `<a class="blobid" href="https://walruscan.com/mainnet/blob/${encodeURIComponent(r.blob_id)}" target="_blank" rel="noopener" title="verify on walruscan">\u26D3 ${esc(String(r.blob_id).slice(0, 12))}\u2026 &#8599;</a>`)
          : '';
        return `<li><span class="fact">${esc(r.text)}</span>${bid}</li>`;
      }).join('')
    : `<li><span class="fact"><i>Nothing remembered yet \u2014 say hi in the <a href="/">chat</a>.</i></span></li>`;
  const notice = mode === 'mainnet'
    ? `<div class="notice mainnet">All memory below is stored on <b>Walrus Mainnet</b> via Walrus Memory (Seal-encrypted). Every row links to its blob on walruscan \u2014 verify, don\u2019t trust.${agentShort ? ` Agent: <span class="mono">${esc(agentShort)}\u2026</span>` : ''}</div>`
    : `<div class="notice local"><b>Local demo</b> \u2014 file-backed stand-in memory, not Walrus Mainnet. The Mainnet path runs when <span class="mono">MEMWAL_MODE=mainnet</span> is set with keys.</div>`;
  return TOP('DoseDaughter \u2014 memory', mode) + `
<main class="wrap" id="main">
  <h1 class="pg">What DoseDaughter remembers \u2014 <span class="mono">${esc(user)}</span></h1>
  <p class="sub">${rows.length} fact${rows.length === 1 ? '' : 's'} &middot; recalled live from memory &middot; <a href="/">back to chat</a></p>
  ${notice}
  <ul class="receipts">${items}</ul>
  ${FOOT(mode)}
</main>
</body></html>`;
}

// ---------- before/after ----------
export function demoPage({ q, mode, before, after, afterNs, day7Empty }) {
  const list = (arr) => arr.length
    ? `<ul>${arr.map((m) => `<li>${esc(m.text)}<small>${esc(String(m.blob_id || '').slice(0, 12))}</small></li>`).join('')}</ul>`
    : `<ul><li class="none">no memories \u2014 generic answer, Day-1 amnesia</li></ul>`;
  return TOP('DoseDaughter \u2014 before/after', mode) + `
<main class="wrap" id="main">
  <h1 class="pg">Day 1 vs Day 7 \u2014 the same question, live recall</h1>
  <p class="sub">Both namespaces are queried live right now (mode: ${esc(mode)}). <a href="/">back to chat</a></p>
  <div class="qline">Q: \u201c${esc(q)}\u201d</div>
  <div class="two">
    <div class="card dcard before"><h3>\u2715 Before \u2014 Day 1 (never met you)</h3>
      <div class="count">${before.length} memor${before.length === 1 ? 'y' : 'ies'} in <span class="mono">user-demo-day1</span></div>${list(before)}</div>
    <div class="card dcard after"><h3>\u2713 After \u2014 Day 7 (remembers everything)</h3>
      <div class="count">${after.length} memor${after.length === 1 ? 'y' : 'ies'} in <span class="mono">${esc(afterNs || 'user-demo-day7')}</span></div>${list(after)}${day7Empty ? '<p class="sub"><i>Day-7 namespace is empty \u2014 teach it in the <a href="/">chat</a> as user <span class="mono">demo-day7</span>, then reload.</i></p>' : ''}</div>
  </div>
  <p class="sub" style="margin-top:16px">This page runs <b>live recall</b> against both Walrus Memory namespaces \u2014 nothing is faked or cached.</p>
  ${FOOT(mode)}
</main>
</body></html>`;
}

const blobTag = (id, mode) => !id ? '' : (String(id).startsWith('local-') || mode === 'local')
  ? `<span class="blobid local">\u25CF ${esc(String(id).slice(0, 12))}\u2026</span>`
  : `<a class="blobid" href="https://walruscan.com/mainnet/blob/${encodeURIComponent(id)}" target="_blank" rel="noopener">\u26D3 ${esc(String(id).slice(0, 12))}\u2026 &#8599;</a>`;

const section = (title, rows, mode) => `
  <section class="psec"><h3>${esc(title)}</h3>${rows.length
    ? `<ul>${rows.map((r) => `<li>${esc(String(r.text || r).replace(/^User\s+\S+:\s*/i, ''))}${blobTag(r.blob_id, mode)}</li>`).join('')}</ul>`
    : '<p class="muted"><i>None recorded</i></p>'}</section>`;

// ---------- printable emergency card + doctor summary ----------
export function printPage({ user, mode, facts, groups, agentShort }) {
  // Use the classifier's buckets (negation-aware) so "no known allergy" /
  // "not allergic to X" never print under Allergies on the emergency card.
  const allergyRows = groups.allergies || [];
  const medRows = groups.medications || [];
  const contactRows = groups.familyAndCare || [];
  return TOP('DoseDaughter \u2014 printable summary', mode) + `
<main class="wrap" id="main">
  <div class="print-actions">
    <button class="btn" id="printbtn" type="button">Print / Save as PDF</button>
    <a class="btn ghost" href="/">Back to chat</a>
    <a class="btn ghost" href="/memory?user=${encodeURIComponent(user)}">Memory receipts</a>
  </div>
  <div class="sheet">
    <div class="ecard">
      <div class="ecard-head"><span class="logo">&#129461;</span><div><b>Emergency card</b><div class="muted">DoseDaughter \u00b7 <span class="mono">${esc(user)}</span></div></div></div>
      <div class="ecard-sec allergy"><h4>Allergies</h4>${allergyRows.length ? `<ul>${allergyRows.map((r) => `<li>${esc(String(r.text).replace(/^User\s+\S+:\s*/i, ''))}</li>`).join('')}</ul>` : '<p class="muted">None recorded</p>'}</div>
      <div class="ecard-sec"><h4>Current medications</h4>${medRows.length ? `<ul>${medRows.map((r) => `<li>${esc(String(r.text).replace(/^User\s+\S+:\s*/i, ''))}</li>`).join('')}</ul>` : '<p class="muted">None recorded</p>'}</div>
      <div class="ecard-sec"><h4>Emergency contacts</h4>${contactRows.length ? `<ul>${contactRows.map((r) => `<li>${esc(String(r.text).replace(/^User\s+\S+:\s*/i, ''))}</li>`).join('')}</ul>` : '<p class="muted">None recorded</p>'}</div>
      <p class="ecard-foot">Not medical advice \u2014 confirm with the treating doctor.</p>
    </div>

    <div class="summary">
      <h2>Doctor-visit summary</h2>
      <p class="muted">Compiled from recalled memory only \u2014 every line is traceable to a Walrus blob. Generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>
      ${section('Medications', groups.medications || [], mode)}
      ${section('Allergies', groups.allergies || [], mode)}
      ${section('Routine', groups.routine || [], mode)}
      ${section('Family & care', groups.familyAndCare || [], mode)}
      ${(groups.unclassified && groups.unclassified.length) ? section('Other', groups.unclassified, mode) : ''}
    </div>
  </div>
  ${FOOT(mode)}
</main>
</body></html>`;
}

// ---------- Day 1 -> Day 90 replay ----------
export function replayPage({ user, mode, facts }) {
  const items = facts.map((f, i) => `<li data-i="${i}"><span class="rpf">${esc(String(f.text).replace(/^User\s+\S+:\s*/i, ''))}</span>${blobTag(f.blob_id, mode)}</li>`).join('');
  return TOP('DoseDaughter \u2014 90-day replay', mode) + `
<main class="wrap" id="main">
  <h1 class="pg">Day 1 \u2192 Day 90</h1>
  <p class="sub">Watch a caregiver's memory accumulate \u2014 and the day it stops a dangerous dose. Facts are recalled live from <span class="mono">${esc(user)}</span>.</p>
  <div class="replay card">
    <div class="replay-top">
      <div class="replay-day" id="rpDay">Day 1</div>
      <button class="btn" id="rpPlay" type="button">\u25B6 Play the 90 days</button>
    </div>
    <div class="replay-bar"><div class="replay-progress" id="rpProgress"></div></div>
    <ul class="replay-facts" id="rpFacts">${items}</ul>
    <div class="replay-stop" id="rpStop" hidden role="alert"><b>Day 87 \u2014 STOP</b><br>\u201cCan she take ibuprofen for her headache?\u201d \u2192 DoseDaughter refuses and cites the allergy blob. This is the moment the memory earns its keep.</div>
    <p class="sub" id="rpCaption" style="margin-top:14px">Press play.</p>
  </div>
  ${FOOT(mode)}
</main>
</body></html>`;
}
