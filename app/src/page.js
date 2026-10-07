// Mediara — server-rendered page shells (hand-written UI, no framework/build).
// Untrusted text is escaped server-side (esc); the client uses textContent only.
export const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __pdir = path.dirname(fileURLToPath(import.meta.url));
let ASSET_V = '10';
try { ASSET_V = String(Math.floor(fs.statSync(path.join(__pdir, '..', 'public', 'app.css')).mtimeMs)); } catch {}

const TOP = (title, mode) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/assets/app.css?v=${ASSET_V}">
<style>
/* Compat-view charcoal shim: these server pages are shareable legacy views
   (kept because tests + evidence link them); the app lives at /app. The
   file stylesheet is var-driven, so forcing the Mediara charcoal vars here
   re-skins every page at once. !important: the file's own dark-mode block
   outranks plain :root on dark-OS browsers. */
:root{
  color-scheme:dark !important;
  --bg:#0c0d10 !important; --surface:#14151b !important; --surface-2:#1a1c23 !important; --surface-3:#23262f !important;
  --border:rgb(255 255 255/.12) !important; --border-strong:rgb(255 255 255/.22) !important;
  --text:#f4f4f5 !important; --text-2:#d4d4d8 !important; --muted:#a1a1aa !important;
  --primary:#f4f4f5 !important; --primary-hover:#ffffff !important; --primary-active:#d4d4d8 !important;
  --primary-soft:#1a1c23 !important; --primary-contrast:#0c0d10 !important;
  --success:#4ade80 !important; --success-soft:rgb(74 222 128/.1) !important;
  --warning:#fbbf24 !important; --warning-soft:rgb(251 191 36/.1) !important;
  --danger:#f87171 !important; --danger-soft:rgb(248 113 113/.1) !important; --danger-border:rgb(248 113 113/.4) !important;
  --focus:#f4f4f5 !important;
}
body{background:#0c0d10 !important;background-image:none !important;color:#f4f4f5 !important;}
.top{background:#101116 !important;border-bottom:1px solid rgb(255 255 255/.08);}
select,option,optgroup{color-scheme:dark;background-color:#1a1c23;color:#f4f4f5;}
.legacy-note{font-size:12.5px;color:#a1a1aa;text-align:center;padding:8px 20px;border-bottom:1px solid rgb(255 255 255/.08);}
.legacy-note a{color:#f4f4f5;}
</style>
<script type="module" src="/assets/app.js?v=${ASSET_V}"></script></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="bar">
  <div class="brand"><span class="logo">M</span>
    <div><h1>Mediara</h1><p>a caregiver chatbot that never re-asks a dose</p></div></div>
  <nav class="topnav" aria-label="Primary">
    <a href="/app">Chat</a><a href="/app#/demo">Demo chat</a><a href="/app#/memory">Memory</a><a href="/app#/proof">Guard&nbsp;proof</a><a href="/app#/print">Print</a><a href="/app#/replay">Replay</a><a href="/app#/compare">Isolation</a>
    <span class="pill ${mode === 'mainnet' ? 'mainnet' : 'local'}"><span class="dot"></span>${mode === 'mainnet' ? 'Walrus Mainnet' : 'Local demo'}</span>
  </nav>
</div></header>
<div class="legacy-note">Shareable legacy view — the full app lives at <a href="/app">/app</a>.</div>`;

const FOOT = (mode) => `<footer class="foot">
  Every remembered fact is a Seal-encrypted blob on Walrus${mode === 'mainnet' ? ' Mainnet' : ''}. ${mode === 'mainnet' ? 'Verify any fact on <a href="https://walruscan.com" target="_blank" rel="noopener">walruscan.com</a>.' : 'Set <span class="mono">MEMWAL_MODE=mainnet</span> with keys for real Mainnet storage.'}<br>
  <a href="https://github.com/tejas0111/mediara" target="_blank" rel="noopener">source</a> &middot; <a href="/healthz">health</a> &middot; <a href="/app">open the app</a> &middot; built for Walrus Session 8<br>
  Confirm with your doctor &mdash; this is not medical advice.
</footer>`;

// ---------- chat ----------
export function chatPage({ mode }) {
  return TOP('Mediara \u2014 chat', mode) + `
<main class="wrap" id="main"><div id="dd-app" data-mode="${esc(mode)}" data-default-user="demo-mom">
  <div class="walletbar" id="walletbar">
    <span class="who" id="who2">Checking wallet&hellip;</span>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <a class="vault" id="vaultlink" style="display:none" target="_blank" rel="noopener"></a>
      <button class="btn dark" id="connect" style="display:none" type="button">Connect Sui Wallet</button>
      <button class="iconbtn" id="logout" style="display:none" type="button">Sign out</button>
    </div>
  </div>
  <div class="obsteps" id="obsteps"></div>
  <p class="note" id="signnote">Your Sui wallet is your sign-in. Connect it to keep memories in <b>your own</b> on-chain vault (a MemWal account you create &amp; own), read with a delegate key you can revoke. Signature only \u2014 no fee to sign in.</p>
  <div class="identity"><label for="who">user id</label><input id="who" value="demo-mom" spellcheck="false" autocomplete="off">
    <label class="memtoggle"><input type="checkbox" id="memoff"> memory off (amnesia mode)</label></div>

  <div class="grid">
    <section class="chat card" aria-label="Chat with Mediara">
      <div class="chat-head">
        <div class="ava">M</div>
        <div><div class="who">Mediara</div>
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
    <a class="chip ghost" id="memlink" href="/app#/memory">See what it remembers</a>
    <a class="chip ghost" href="/app#/demo">Demo chat</a>
    <a class="chip ghost" href="/api/summary?user=demo-mom">Doctor summary</a>
  </div>
  ${FOOT(mode)}
</div></main>
</body></html>`;
}

// ---------- landing (GET /) ----------
// Premium dark hero for Mediara. Server-rendered, zero JS (CSP script-src
// 'self' holds: no inline <script>). Dynamic numbers are escaped server-side.
export function landingPage({ mode, demoBlobs, guardCount }) {
  // Unknown (null/undefined/NaN) renders as an em-dash, never a refuting 0; a
  // genuinely-known zero stays numeric. Signature and markup unchanged.
  // (Number(null) is 0, so null needs an explicit guard — not just isFinite.)
  const toCount = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const blobs = toCount(demoBlobs);
  const guards = toCount(guardCount);
  const modeLabel = mode === 'mainnet' ? 'Walrus Mainnet' : 'Local demo';
  const demoNote = mode === 'mainnet'
    ? 'Live on Walrus Mainnet — memories are Seal-encrypted blobs you can verify on walruscan.'
    : 'Demo runs on a local stand-in (no chain). Set MEMWAL_MODE=mainnet with keys for real Mainnet storage.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="description" content="Mediara — a caregiver chatbot that never re-asks a dose.">
<title>Mediara — never re-asks a dose</title><link rel="icon" href="data:,">
<style>
:root{color-scheme:dark;--lbg:#0c0d10;--lsurf:#14151b;--lbrd:rgb(255 255 255/.08);--ltx:#f4f4f5;--lmut:#a1a1aa;--lhi:#fafafa;--llo:#52525b;--lr:12px;--le:cubic-bezier(.32,.72,0,1)}
*{box-sizing:border-box}body{margin:0;background:var(--lbg);color:var(--ltx);font:15px/1.6 Inter,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}.skip{position:absolute;left:-9999px;top:0;background:#f4f4f5;color:#0c0d10;padding:8px 14px;border-radius:0 0 10px 0;z-index:100}.skip:focus{left:0}
.hero{max-width:860px;margin:0 auto;padding:72px 20px 28px;text-align:center}
.mark{width:52px;height:52px;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;border-radius:16px;background:linear-gradient(135deg,var(--lhi),var(--llo));color:#0c0d10;font-weight:800;font-size:24px}
.kicker{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--lmut);margin:0 0 10px}
h1{margin:0 0 10px;font-size:clamp(30px,6vw,46px);line-height:1.08;letter-spacing:-.03em}
.promise{margin:0 auto 26px;max-width:52ch;color:var(--lmut);font-size:16px}
.cta{display:inline-block;background:#f4f4f5;color:#0c0d10;font-weight:650;font-size:15px;padding:11px 26px;border-radius:10px;text-decoration:none;transition:background .15s var(--le)}
.cta:hover{background:#fff}.cta:focus-visible{outline:2px solid #f4f4f5;outline-offset:3px}
.ghost{display:inline-block;margin-left:10px;color:var(--lmut);font-size:14px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;max-width:860px;margin:34px auto 0;padding:0 20px;text-align:left}
.step{background:var(--lsurf);border:1px solid var(--lbrd);border-radius:var(--lr);padding:16px}
.step b{display:block;font-size:13px;margin-bottom:6px}.step p{margin:0;font-size:13.5px;color:var(--lmut)}
.strip{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;max-width:860px;margin:26px auto 0;padding:0 20px}
.pill{font-size:12.5px;font-weight:600;border:1px solid var(--lbrd);border-radius:999px;padding:4px 12px;color:var(--ltx);background:var(--lsurf);font-variant-numeric:tabular-nums}
.note{max-width:860px;margin:26px auto 0;padding:0 20px 60px;color:var(--lmut);font-size:13px;text-align:center}
.foot{border-top:1px solid var(--lbrd);padding:18px 20px 34px;text-align:center;color:var(--lmut);font-size:12.5px}
@media(max-width:640px){.steps{grid-template-columns:1fr}.hero{padding-top:52px}}
@media(prefers-reduced-motion:reduce){*{animation-duration:.001ms!important;transition-duration:.001ms!important}}
@media print{:root{color-scheme:light}body{background:#fff!important;color:#111!important}.hero,.steps,.strip,.note,.foot{color:#111}.step,.pill{background:#fff!important;border-color:#ccc!important}}
</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<main class="hero" id="main">
<div class="mark" aria-hidden="true">M</div>
<p class="kicker">Mediara &middot; ${esc(modeLabel)}</p>
<h1>A caregiver chatbot that never re-asks a dose</h1>
<p class="promise">Tell it once — meds, allergies, routines — and every future answer is checked against that memory before it speaks.</p>
<a class="cta" href="/app">Launch app</a><a class="ghost" href="/app#/demo">see the live demo chat</a>
<div class="steps">
<div class="step"><b>1 · Teach it once</b><p>Medications with times, allergies, routines — stored as encrypted Walrus blobs, not chat logs.</p></div>
<div class="step"><b>2 · Guards run first</b><p>Every question is checked for allergy conflicts and drug interactions before any model answers.</p></div>
<div class="step"><b>3 · Proof, not vibes</b><p>Every STOP cites its blob; the guard ledger is hash-chained and publicly verifiable.</p></div>
</div>
<div class="strip" aria-label="Live evidence">
<span class="pill">12/12 A/B memory checks</span>
<span class="pill">30/30 eval gate</span>
<span class="pill">${esc(blobs == null ? '—' : String(blobs))} demo memories live</span>
<span class="pill">${esc(guards == null ? '—' : String(guards))} guard stops on record</span>
</div>
<p class="note">${esc(demoNote)} Guests chat instantly with personal memory — no wallet needed; sign in later for your own vault and a bigger budget.</p>
</main>
<footer class="foot">Mediara · built for Walrus Session 8 · Confirm with your doctor — this is not medical advice.</footer>
</body></html>`;
}

// ---------- guard-proof ledger ----------
export function ledgerPage({ mode, entries, verify }) {
  const badge = (b) => (b ? '<span class="pill mainnet"><span class="dot"></span>high</span>' : '<span class="pill local"><span class="dot"></span>moderate</span>');
  const rows = entries.length
    ? entries.map((e) => `<tr>
        <td class="mono">#${e.n}</td><td>${esc(e.at)}</td><td class="mono">${esc(e.userId)}</td>
        <td>${badge(e.severity === 'high')}</td>
        <td><b>${esc(String(e.kind) === 'interaction' ? `${e.substance} × ${e.withSubstance}` : e.substance)}</b>${e.reason ? ` — ${esc(e.reason)}` : ''}<br><small>${esc(e.message)}</small></td>
        <td><small>fact: “${esc(e.fact)}”</small>${e.blobId ? `<br><small class="mono">blob ${esc(String(e.blobId).slice(0, 16))}…</small>` : ''}</td>
        <td class="mono"><small>${esc(String(e.hash).slice(0, 12))}…</small></td>
      </tr>`).join('')
    : '<tr><td colspan="7"><i>No guard has fired yet — teach an allergy, then ask the trap question.</i></td></tr>';
  const chain = verify.ok
    ? '<span class="pill mainnet"><span class="dot"></span>chain intact</span>'
    : `<span class="pill local"><span class="dot"></span>CHAIN BROKEN at #${verify.brokenAt}</span>`;
  return TOP('Mediara — guard proof', mode) + `
<main class="wrap" id="main">
  <h1 class="pg">Guard proof — every STOP, on the record</h1>
  <p class="sub">Append-only ledger of every safety block, with the recalled fact and blob id that fired it. Each entry carries the hash of the previous one — any edit after the fact breaks the chain.</p>
  <p class="sub">${chain} · ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · machine-readable: <a href="/api/guard-proof">/api/guard-proof</a> · <a href="/">back to chat</a></p>
  <div class="notice ${mode === 'mainnet' ? 'mainnet' : 'local'}">Live receipt: ask “Can she take ibuprofen for her headache?” in the <a href="/">chat</a> (demo persona knows the ibuprofen allergy), then reload this page — the STOP that just fired is already on it, with the Walrus blob that caused it.</div>
  <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13.5px">
    <thead><tr style="text-align:left;border-bottom:1px solid currentColor;opacity:.7"><th>#</th><th>when (UTC)</th><th>user</th><th>severity</th><th>what was blocked</th><th>evidence</th><th>hash</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${FOOT(mode)}
</main>
</body></html>`;
}

// ---------- memory receipts ----------
export function memoryPage({ user, mode, rows, agentShort, stale }) {
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
  return TOP('Mediara \u2014 memory', mode) + `
<main class="wrap" id="main">
  <h1 class="pg">What Mediara remembers \u2014 <span class="mono">${esc(user)}</span></h1>
  <p class="sub">${rows.length} fact${rows.length === 1 ? '' : 's'} &middot; recalled live from memory &middot; <a href="/">back to chat</a></p>
  ${stale ? '<div class="notice local"><b>Memory temporarily unreachable</b> \u2014 this list may be incomplete. Retry shortly.</div>' : ''}
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
  return TOP('Mediara \u2014 before/after', mode) + `
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

const section = (title, rows, mode, stale) => `
  <section class="psec"><h3>${esc(title)}</h3>${rows.length
    ? `<ul>${rows.map((r) => `<li>${esc(String(r.text || r).replace(/^User\s+\S+:\s*/i, ''))}${blobTag(r.blob_id, mode)}</li>`).join('')}</ul>`
    : (stale ? '<p class="stale"><b>UNKNOWN \u2014 memory unreachable.</b></p>' : '<p class="muted"><i>None recorded</i></p>')}</section>`;

// ---------- printable emergency card + doctor summary ----------
export function printPage({ user, mode, facts, groups, agentShort, stale }) {
  // Use the classifier's buckets (negation-aware) so "no known allergy" /
  // "not allergic to X" never print under Allergies on the emergency card.
  const allergyRows = groups.allergies || [];
  const medRows = groups.medications || [];
  const contactRows = groups.familyAndCare || [];
  // FAIL CLOSED: while memory is unreachable, "None recorded" is an affirmative
  // (and potentially lethal) claim. Say UNKNOWN instead.
  const cell = (rows) => stale
    ? '<p class="stale"><b>UNKNOWN \u2014 memory unreachable.</b> Do not assume none.</p>'
    : rows.length
      ? `<ul>${rows.map((r) => `<li>${esc(String(r.text).replace(/^User\s+\S+:\s*/i, ''))}</li>`).join('')}</ul>`
      : '<p class="muted">None recorded</p>';
  return TOP('Mediara \u2014 printable summary', mode) + `
<main class="wrap" id="main">
  <div class="print-actions">
    <button class="btn" id="printbtn" type="button">Print / Save as PDF</button>
    <a class="btn ghost" href="/">Back to chat</a>
    <a class="btn ghost" href="/memory?user=${encodeURIComponent(user)}">Memory receipts</a>
  </div>
  ${stale ? '<div class="notice local"><b>Memory temporarily unreachable</b> \u2014 this card may be incomplete. Do not rely on it for medication decisions until it reloads.</div>' : ''}
  <div class="sheet">
    <div class="ecard">
      <div class="ecard-head"><span class="logo">&#129461;</span><div><b>Emergency card</b><div class="muted">Mediara \u00b7 <span class="mono">${esc(user)}</span></div></div></div>
      <div class="ecard-sec allergy"><h4>Allergies</h4>${cell(allergyRows)}</div>
      <div class="ecard-sec"><h4>Current medications</h4>${cell(medRows)}</div>
      <div class="ecard-sec"><h4>Emergency contacts</h4>${cell(contactRows)}</div>
      <p class="ecard-foot">Not medical advice \u2014 confirm with the treating doctor.</p>
    </div>

    <div class="summary">
      <h2>Doctor-visit summary</h2>
      <p class="muted">Compiled from recalled memory only \u2014 every line is traceable to a Walrus blob. Generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>
      ${section('Medications', groups.medications || [], mode, stale)}
      ${(groups.stopped && groups.stopped.length) ? section('Stopped / discontinued', groups.stopped, mode, stale) : ''}
      ${(groups.superseded && groups.superseded.length) ? section('Superseded (older dose)', groups.superseded, mode, stale) : ''}
      ${section('Allergies', groups.allergies || [], mode, stale)}
      ${section('Routine', groups.routine || [], mode, stale)}
      ${section('Family & care', groups.familyAndCare || [], mode, stale)}
      ${(groups.unclassified && groups.unclassified.length) ? section('Other', groups.unclassified, mode, stale) : ''}
    </div>
  </div>
  ${FOOT(mode)}
</main>
</body></html>`;
}

// ---------- cross-user isolation proof ----------
export function comparePage({ q, mode, a, b, aFacts, bFacts }) {
  const list = (arr) => arr.length
    ? `<ul>${arr.map((m) => `<li>${esc(String(m.text).replace(/^User\s+\S+:\s*/i, ''))}${blobTag(m.blob_id, mode)}</li>`).join('')}</ul>`
    : '<ul><li class="none">no memories in this namespace</li></ul>';
  return TOP('Mediara \u2014 isolation', mode) + `
<main class="wrap" id="main">
  <h1 class="pg">Cross-user isolation \u2014 the same question, two namespaces</h1>
  <p class="sub">Per-user namespaces keep one family member's memory out of another's. Queried live now (mode: ${esc(mode)}).</p>
  <div class="qline">Q: \u201c${esc(q)}\u201d</div>
  <div class="two">
    <div class="card dcard"><h3>Namespace A \u2014 <span class="mono">${esc(a)}</span></h3><div class="count">${aFacts.length} facts</div>${list(aFacts)}</div>
    <div class="card dcard"><h3>Namespace B \u2014 <span class="mono">${esc(b)}</span></h3><div class="count">${bFacts.length} facts</div>${list(bFacts)}</div>
  </div>
  <p class="sub" style="margin-top:16px">Nothing from A appears under B \u2014 isolation is enforced by the namespace, not by the prompt.</p>
  ${FOOT(mode)}
</main>
</body></html>`;
}

// ---------- Day 1 -> Day 90 replay ----------
export function replayPage({ user, mode, facts, stale }) {
  const items = facts.map((f, i) => `<li data-i="${i}" aria-hidden="true"><span class="rpf">${esc(String(f.text).replace(/^User\s+\S+:\s*/i, ''))}</span>${blobTag(f.blob_id, mode)}</li>`).join('');
  return TOP('Mediara \u2014 90-day replay', mode) + `
<main class="wrap" id="main">
  <h1 class="pg">Day 1 \u2192 Day 90</h1>
  <p class="sub">Watch a caregiver's memory accumulate \u2014 and the day it stops a dangerous dose. Facts are recalled live from <span class="mono">${esc(user)}</span>.</p>
  ${stale ? '<div class="notice local"><b>Memory temporarily unreachable</b> \u2014 this replay may be incomplete.</div>' : ''}
  <div class="replay card">
    <div class="replay-top">
      <div class="replay-day" id="rpDay">Day 1</div>
      <button class="btn" id="rpPlay" type="button">\u25B6 Play the 90 days</button>
    </div>
    <div class="replay-bar"><div class="replay-progress" id="rpProgress"></div></div>
    <ul class="replay-facts" id="rpFacts">${items}</ul>
    <div class="replay-stop" id="rpStop" hidden role="alert"><b>Final day \u2014 STOP</b><br>\u201cCan she take ibuprofen for her headache?\u201d \u2192 Mediara refuses and cites the allergy blob. This is the moment the memory earns its keep.</div>
    <p class="sub" id="rpCaption" style="margin-top:14px">Press play.</p>
  </div>
  ${FOOT(mode)}
</main>
</body></html>`;
}
