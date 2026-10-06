/* DoseDaughter client. Hand-written chat UI (no framework). */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function short(s) { return s ? String(s).slice(0, 6) + '\u2026' + String(s).slice(-4) : ''; }
  function b64ToBytes(b64) { var bin = atob(b64); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function utf8(s) { return new TextEncoder().encode(s); }
  function post(url, body) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); }); }
  function clock() { var d = new Date(); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  var root = $('dd-app');
  var MODE = root ? (root.dataset.mode || 'local') : 'local';
  var DEFAULT_USER = root ? (root.dataset.defaultUser || 'demo-mom') : 'demo-mom';

  function blobLink(id) {
    if (!id) return null;
    var isLocal = String(id).indexOf('local-') === 0 || MODE !== 'mainnet';
    var node = isLocal ? el('span', 'blobid local') : el('a', 'blobid');
    node.textContent = (isLocal ? '\u25CF ' : '\u26D3 ') + String(id).slice(0, 14) + '\u2026';
    if (!isLocal) { node.href = 'https://walruscan.com/mainnet/blob/' + encodeURIComponent(id); node.target = '_blank'; node.rel = 'noopener'; node.title = 'Verify this memory on walruscan'; }
    else { node.title = 'Local demo id — not a Mainnet blob'; }
    return node;
  }

  /* ---------------- chat ---------------- */
  var thread, typing;
  function scrollThread() { if (thread) thread.scrollTop = thread.scrollHeight; }
  function setTyping(on) { if (typing) typing.className = 'typing' + (on ? ' on' : ''); }

  function addRow(role, text, opts) {
    opts = opts || {};
    var row = el('div', 'row ' + (role === 'user' ? 'user' : role === 'stop' ? 'stop' : role === 'warn' ? 'warn' : 'ai'));
    var ava = el('div', 'ava', role === 'user' ? 'U' : role === 'stop' ? '!' : role === 'warn' ? '!' : 'DD');
    ava.setAttribute('aria-hidden', 'true');
    var body = el('div');
    var bubble = el('div', 'bubble', text);
    body.appendChild(bubble);
    if (opts.memories && opts.memories.length) {
      var chips = el('div', 'memchips');
      opts.memories.forEach(function (m) {
        var t = (m && m.text) || m;
        var chip = el('span', 'memchip', t);
        chip.title = t; chips.appendChild(chip);
      });
      body.appendChild(chips);
    }
    if (role !== 'user') {
      var meta = el('div', 'meta');
      meta.appendChild(el('span', null, role === 'stop' ? 'Safety stop' : 'DoseDaughter'));
      meta.appendChild(el('span', null, '\u00B7'));
      meta.appendChild(el('span', null, clock()));
      body.appendChild(meta);
      body.appendChild(el('div', 'disclaim', 'Confirm with your doctor \u2014 this is not medical advice.'));
    }
    row.appendChild(ava); row.appendChild(body);
    thread.appendChild(row); scrollThread();
    return row;
  }

  function currentUser() {
    var who = $('who');
    return (who && !who.disabled && who.value.trim()) || DEFAULT_USER;
  }

  function renderRail(j) {
    var list = $('memlist');
    if (list) {
      list.innerHTML = '';
      var metas = j.recalledMeta || (j.recalled || []).map(function (t) { return { text: t }; });
      if (!metas.length) { list.appendChild(el('li', 'none', 'No memories for this user yet \u2014 teach me a fact.')); }
      else metas.forEach(function (m) {
        var li = el('li', null, m.text || String(m));
        if (m.blob_id) li.appendChild(blobLink(m.blob_id));
        list.appendChild(li);
      });
    }
    var savedWrap = $('savedwrap'), saved = $('saved');
    if (savedWrap && saved) {
      saved.innerHTML = '';
      if (j.savedBlob) {
        savedWrap.style.display = '';
        saved.appendChild(document.createTextNode('\uD83E\uDDAD Remembered \u2192 '));
        var link = blobLink(j.savedBlob); if (link) saved.appendChild(link);
      } else if (j.memoryPersisted === false) {
        savedWrap.style.display = '';
        saved.appendChild(document.createTextNode('\u26A0 Not saved \u2014 this will NOT be remembered next time. Please write it down.'));
      } else savedWrap.style.display = 'none';
    }
    var scope = $('scope');
    if (scope) scope.textContent = (j.identity === 'wallet-owner' ? 'your vault \u00B7 ' : 'shared demo channel \u00B7 ') + (j.memoryScope || '') + ' \u00B7 mode: ' + (j.mode || MODE);
    var stop = $('stopbanner'), stopWrap = $('stopwrap');
    if (stop) {
      var safety = /^(STOP|CAUTION)\b/.test(j.reply || '');
      if (safety) { stop.textContent = j.reply; if (stopWrap) stopWrap.style.display = ''; stop.style.display = ''; }
      else { stop.textContent = ''; stop.style.display = 'none'; if (stopWrap) stopWrap.style.display = 'none'; }
    }
  }

  function send(message) {
    message = (message || '').trim();
    if (!message) return;
    addRow('user', message);
    setTyping(true);
    var sendBtn = $('send'); if (sendBtn) sendBtn.disabled = true;
    var memoff = $('memoff');
    fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: currentUser(), message: message, memory: (memoff && memoff.checked) ? 'off' : 'on' }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        setTyping(false); if (sendBtn) sendBtn.disabled = false;
        if (!res.ok || res.j.error) { addRow('stop', 'Couldn\u2019t reach memory \u2014 ' + ((res.j && res.j.error) || 'unknown error')); return; }
        var j = res.j;
        var isStop = /^STOP\b/.test(j.reply || '');
        var isWarn = /^CAUTION\b/.test(j.reply || '');
        addRow(isStop ? 'stop' : isWarn ? 'warn' : 'ai', j.reply, { memories: j.recalledMeta || j.recalled });
        renderRail(j);
      })
      .catch(function (e) { setTyping(false); if (sendBtn) sendBtn.disabled = false; addRow('stop', 'Network error \u2014 ' + String((e && e.message) || e)); });
  }

  function initChat() {
    if (!root) return;
    thread = $('thread'); typing = $('typing');
    var modeEl = $('chatmode'); if (modeEl) modeEl.textContent = MODE === 'mainnet' ? 'Walrus Mainnet' : 'local demo';
    addRow('ai', 'Hi \u2014 I\u2019m DoseDaughter. Teach me about the person you care for (meds, allergies, routines). I\u2019ll remember across sessions on Walrus' + (MODE === 'mainnet' ? ' Mainnet' : '') + ' and show you every receipt.');
    var composer = $('composer'), text = $('text');
    if (composer && text) {
      composer.addEventListener('submit', function (e) { e.preventDefault(); var v = text.value; text.value = ''; autoGrow(text); send(v); });
      text.addEventListener('input', function () { autoGrow(text); });
      text.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composer.requestSubmit ? composer.requestSubmit() : composer.dispatchEvent(new Event('submit', { cancelable: true })); } });
    }
    Array.prototype.forEach.call(document.querySelectorAll('.chip[data-msg]'), function (b) {
      b.addEventListener('click', function () { send(b.getAttribute('data-msg')); });
    });
    var memlink = $('memlink'), who = $('who');
    if (memlink && who) { var sync = function () { memlink.href = '/memory?user=' + encodeURIComponent(who.value.trim() || DEFAULT_USER); }; who.addEventListener('change', sync); sync(); }
  }
  function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }

  /* ---------------- wallet identity (nonce sign-in) ---------------- */
  function wireWallet() {
    var who2 = $('who2'), btn = $('connect'), vault = $('vaultlink'), ob = $('obsteps'), signnote = $('signnote'), whoInput = $('who');
    if (!btn) return;
    var account = null;
    function stepList(names) { ob.className = 'obsteps on'; ob.innerHTML = ''; names.forEach(function (n) { ob.appendChild(el('div', 'step', n)); }); }
    function stepMark(i, cls, text) { var d = ob.children[i]; if (!d) return; d.className = 'step ' + cls; if (text) d.textContent = text; }
    function stepErr(i, e) { stepMark(i, 'err', 'Failed: ' + ((e && e.error) ? e.error : (e && e.message) ? e.message : String(e))); }
    var logout = $('logout');
    if (logout) logout.addEventListener('click', function () { post('/api/auth/logout').then(function () { location.reload(); }); });
    function setSignedOut() { who2.textContent = 'Not signed in \u2014 using the shared demo channel'; btn.textContent = 'Connect Sui Wallet'; btn.style.display = ''; vault.style.display = 'none'; if (logout) logout.style.display = 'none'; }
    function setSignedIn(st) {
      who2.innerHTML = ''; who2.appendChild(document.createTextNode('Signed in as '));
      var b = el('b', null, short(st.address)); who2.appendChild(b);
      if (logout) logout.style.display = '';
      if (st.onboarded) {
        btn.style.display = 'none'; if (signnote) signnote.style.display = 'none';
        vault.href = 'https://suiscan.xyz/mainnet/account/' + st.accountId; vault.textContent = 'vault ' + short(st.accountId) + ' \u2197'; vault.style.display = '';
        if (whoInput) { whoInput.disabled = true; whoInput.value = 'my vault (wallet)'; }
      } else {
        btn.style.display = '';
        btn.textContent = st.pendingPhase ? 'Resume setup' : (st.needsRelink ? 'Re-link my vault' : 'Create my memory vault');
      }
    }
    // Wallet Standard discovery without a bundler: wallets register via the
    // `wallet-standard:register-wallet` event and respond to `wallet-standard:app-ready`.
    var discovered = [];
    function addWallets(list) { for (var i = 0; i < list.length; i++) if (list[i] && discovered.indexOf(list[i]) === -1) discovered.push(list[i]); }
    var registerApi = { register: function () { addWallets([].slice.call(arguments)); } };
    window.addEventListener('wallet-standard:register-wallet', function (e) { try { if (e && e.detail) e.detail(registerApi); } catch (_) {} });
    function announce() { try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registerApi })); } catch (_) {} }
    announce();
    function getWallets() { if (typeof window.getWallets === 'function') { try { return window.getWallets() || []; } catch (_) {} } return discovered; }
    function pickWallet() {
      var ws = getWallets();
      for (var i = 0; i < ws.length; i++) { var f = ws[i].features || {}; if (f['standard:connect'] && (f['sui:signPersonalMessage'] || f['sui:signTransaction'] || f['sui:signTransactionBlock'])) return ws[i]; }
      return ws[0] || null;
    }
    async function ensureConnected(w) { if (account) return account; var c = await w.features['standard:connect'].connect(); account = (c.accounts || [])[0] || null; if (!account) throw { message: 'wallet returned no account' }; return account; }
    async function signTx(w, acct, bytes) {
      var f = w.features || {};
      if (f['sui:signTransaction']) { var r1 = await f['sui:signTransaction'].signTransaction({ transaction: { toJSON: function () { return bytes; }, bytes: bytes }, account: acct, chain: 'sui:mainnet' }); return r1.signature; }
      if (f['sui:signTransactionBlock']) { var r2 = await f['sui:signTransactionBlock'].signTransactionBlock({ transactionBlockBytes: bytes, account: acct, chain: 'sui:mainnet' }); return r2.signature; }
      throw { message: 'wallet cannot sign transactions' };
    }
    async function signMsg(w, acct, msgBytes) { var f = w.features || {}; if (f['sui:signPersonalMessage']) { var r = await f['sui:signPersonalMessage'].signPersonalMessage({ message: msgBytes, account: acct }); return r.signature; } throw { message: 'wallet cannot sign personal messages' }; }

    btn.addEventListener('click', async function () {
      try {
        var w = pickWallet();
        if (!w) { alert('No Sui wallet detected. Install Sui Wallet / Slush / Nightly, then reload.'); return; }
        var acct = await ensureConnected(w);
        var status = await fetch('/api/wallet/status').then(function (r) { return r.json(); });
        if (!status.signedIn) {
          var m = await fetch('/api/auth/message').then(function (r) { return r.json(); });
          var sig = await signMsg(w, acct, utf8(m.message));
          var v = await post('/api/auth/verify', { address: acct.address, signature: sig, nonce: m.nonce });
          if (v.error) throw v;
          status = await fetch('/api/wallet/status').then(function (r) { return r.json(); });
        }
        if (status.onboarded) { setSignedIn(status); return; }
        await runOnboarding(w, acct, !status.needsRelink);
      } catch (e) { alert('Wallet error: ' + ((e && e.message) ? e.message : String(e))); }
    });
    async function runOnboarding(w, acct, needsCreate) {
      var names = needsCreate ? ['Create your vault (sign in wallet \u2014 you pay gas)', 'Link DoseDaughter (second signature)', 'Done \u2014 your memories, your account'] : ['Link DoseDaughter (sign in wallet)', 'Done \u2014 your memories, your account'];
      stepList(names);
      var i = 0;
      try {
        if (needsCreate) {
          stepMark(0, 'active', 'Preparing transaction\u2026');
          var p = await post('/api/wallet/onboard/create'); if (p.error) throw p;
          stepMark(0, 'active', 'Waiting for your signature\u2026');
          var s1 = await signTx(w, acct, b64ToBytes(p.txBytesBase64));
          var c1 = await post('/api/wallet/onboard/complete', { signature: s1 }); if (c1.error) throw c1;
          stepMark(0, 'done', 'Vault created \u2713 ' + short(c1.accountId)); i = 1;
        }
        stepMark(i, 'active', 'Preparing link transaction\u2026');
        var pl = await post('/api/wallet/onboard/link'); if (pl.error) throw pl;
        stepMark(i, 'active', 'Waiting for your signature\u2026');
        var s2 = await signTx(w, acct, b64ToBytes(pl.txBytesBase64));
        var c2 = await post('/api/wallet/onboard/complete', { signature: s2 }); if (c2.error) throw c2;
        stepMark(i, 'done', 'DoseDaughter linked \u2713');
        stepMark(i + 1, 'done', 'Your memories now live in your own on-chain vault');
        var st = await fetch('/api/wallet/status').then(function (r) { return r.json(); });
        setTimeout(function () { setSignedIn(st); ob.className = 'obsteps'; }, 2200);
      } catch (e) { stepErr(i, e); }
    }
    fetch('/api/wallet/status').then(function (r) { return r.json(); }).then(function (j) { if (j && j.signedIn) setSignedIn(j); else setSignedOut(); }).catch(setSignedOut);
  }

  function wireExtras() {
    var pb = $('printbtn'); if (pb) pb.addEventListener('click', function () { window.print(); });
    var play = $('rpPlay'); if (!play) return;
    var facts = document.querySelectorAll('#rpFacts li');
    var day = $('rpDay'), prog = $('rpProgress'), stop = $('rpStop'), cap = $('rpCaption');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var dayFor = function (idx, total) { if (total <= 1) return 90; return Math.round(1 + (89 * idx) / (total - 1)); };
    var playing = false;
    play.addEventListener('click', function () {
      if (playing) return; playing = true;
      Array.prototype.forEach.call(facts, function (li) { li.classList.remove('show'); li.setAttribute('aria-hidden', 'true'); });
      if (stop) stop.hidden = true; if (prog) prog.style.width = '0%'; if (day) day.textContent = 'Day 1';
      if (reduce) {
        Array.prototype.forEach.call(facts, function (li) { li.classList.add('show'); li.removeAttribute('aria-hidden'); });
        if (prog) prog.style.width = '100%'; if (day) day.textContent = 'Day 90';
        if (stop) stop.hidden = false; if (cap) cap.textContent = 'Memory complete.'; playing = false; return;
      }
      var i = 0, n = facts.length;
      (function step() {
        if (i >= n) { if (stop) stop.hidden = false; if (day) day.textContent = 'Day 90'; if (cap) cap.textContent = '\u2026and the day it stops a dangerous dose (Day ' + dayFor(Math.max(n - 1, 0), n) + ').'; playing = false; return; }
        facts[i].classList.add('show'); facts[i].removeAttribute('aria-hidden');
        if (prog) prog.style.width = Math.round(((i + 1) / n) * 100) + '%';
        if (day) day.textContent = 'Day ' + dayFor(i, n);
        i++; setTimeout(step, 420);
      })();
    });
  }

  function init() { initChat(); wireWallet(); wireExtras(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
