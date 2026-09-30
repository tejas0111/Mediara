/* DoseDaughter client. Chat UI: Deep Chat (MIT, OvidijusParsiunas) — see /THIRD-PARTY-NOTICES.md */
(function () {
  'use strict';
  var root = document.getElementById('dd-app');
  if (!root) return;
  var MODE = root.dataset.mode || 'local';
  var MODEL = root.dataset.model || 'google/gemini-2.5-flash';
  var DEFAULT_USER = root.dataset.defaultUser || 'demo-mom';

  function $(id) { return document.getElementById(id); }
  function short(s) { return s ? String(s).slice(0, 6) + '\u2026' + String(s).slice(-4) : ''; }
  function b64ToBytes(b64) { var bin = atob(b64); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function utf8(s) { return new TextEncoder().encode(s); }
  function post(url, body) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); }); }
  function blobLink(id) {
    if (!id) return null;
    if (String(id).indexOf('local-') === 0 || MODE !== 'mainnet') {
      var span = document.createElement('span'); span.className = 'blobid local';
      span.textContent = 'LOCAL DEMO ' + String(id).slice(0, 14) + '\u2026'; return span;
    }
    var a = document.createElement('a'); a.className = 'blobid';
    a.href = 'https://walruscan.com/mainnet/blob/' + encodeURIComponent(id);
    a.target = '_blank'; a.rel = 'noopener'; a.textContent = String(id).slice(0, 12) + '\u2026 \u2197'; return a;
  }

  var AVATAR_AI = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#0f5d5a"/><text x="32" y="42" font-size="30" font-family="Arial" text-anchor="middle" fill="#fff">D</text></svg>');
  var AVATAR_USER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#cfe8e6"/><text x="32" y="42" font-size="30" font-family="Arial" text-anchor="middle" fill="#0b4341">U</text></svg>');
  var AVATAR_STOP = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#b91c1c"/><text x="32" y="44" font-size="34" font-family="Arial" font-weight="bold" text-anchor="middle" fill="#fff">!</text></svg>');

  function currentUser() {
    var who = $('who');
    return (who && !who.disabled && who.value.trim()) || DEFAULT_USER;
  }

  function renderReceipts(j) {
    var list = $('memlist');
    if (list) {
      list.innerHTML = '';
      var metas = j.recalledMeta || (j.recalled || []).map(function (t) { return { text: t }; });
      if (!metas.length) {
        var none = document.createElement('li'); none.className = 'none';
        none.textContent = 'No memories for this user yet \u2014 teach me a fact.'; list.appendChild(none);
      } else {
        metas.forEach(function (m) {
          var li = document.createElement('li');
          li.appendChild(document.createTextNode(m.text));
          if (m.blob_id) li.appendChild(blobLink(m.blob_id));
          list.appendChild(li);
        });
      }
    }
    var savedWrap = $('savedwrap'), saved = $('saved');
    if (savedWrap && saved) {
      saved.innerHTML = '';
      if (j.savedBlob) {
        savedWrap.style.display = '';
        saved.appendChild(document.createTextNode('\uD83E\uDDAD Remembered \u2192 '));
        var link = blobLink(j.savedBlob);
        if (link) saved.appendChild(link);
      } else { savedWrap.style.display = 'none'; }
    }
    var scope = $('scope');
    if (scope) {
      scope.textContent = (j.identity === 'wallet-owner' ? '\uD83D\uDD12 your vault \u00b7 ' : '\uD83D\uDC65 shared demo channel \u00b7 ')
        + (j.memoryScope || '') + ' \u00b7 mode: ' + (j.mode || MODE);
    }
    var stop = $('stopbanner'), stopWrap = $('stopwrap');
    if (stop) {
      if (/^STOP\b/.test(j.reply || '')) {
        stop.textContent = j.reply;
        if (stopWrap) stopWrap.style.display = ''; stop.style.display = '';
      } else {
        stop.textContent = ''; stop.style.display = 'none';
        if (stopWrap) stopWrap.style.display = 'none';
      }
    }
  }

  var chat = document.querySelector('deep-chat');
  function initChat() {
    if (!chat) return;
    chat.avatars = { ai: { src: AVATAR_AI }, user: { src: AVATAR_USER }, stop: { src: AVATAR_STOP } };
    chat.names = { ai: { text: 'DoseDaughter' }, user: { text: 'You' }, stop: { text: 'DoseDaughter \u26a0' } };
    chat.introMessage = { text: 'Hi \u2014 I\u2019m DoseDaughter. Teach me about the person you care for (meds, allergies, routines). I\u2019ll remember across sessions on Walrus' + (MODE === 'mainnet' ? ' Mainnet' : '') + ' \u2014 and show you every receipt.' };
    chat.browserStorage = false;
    chat.requestBodyLimits = { maxMessages: 1 };
    chat.displayLoadingBubble = true;
    chat.errorMessages = { displayServiceErrorMessages: true, overrides: { default: 'Something went wrong \u2014 please try again.' } };
    chat.textInput = { placeholder: { text: 'Say something\u2026 (e.g. \u201cMom takes Metformin 500mg at 8pm\u201d)' }, styles: { container: { borderRadius: '10px', border: '1.5px solid #dbe7e6' } } };
    chat.submitButtonStyles = { submit: { container: { backgroundColor: '#0f5d5a', borderRadius: '10px' } } };
    chat.messageStyles = {
      default: {
        ai: { bubble: { backgroundColor: '#ffffff', border: '1px solid #dbe7e6', color: '#1c2b2a' } },
        user: { bubble: { backgroundColor: '#0f5d5a', color: '#ffffff' } },
        stop: { bubble: { backgroundColor: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontWeight: '700' } }
      }
    };
    chat.connect = {
      handler: function (body, signals) {
        var msgs = (body && body.messages) || [];
        var last = msgs[msgs.length - 1] || {};
        var message = last.text || '';
        if (!message) { signals.onResponse({ error: 'Empty message' }); return; }
        fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: currentUser(), message: message }) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (!res.ok || res.j.error) { signals.onResponse({ error: (res.j && res.j.error) || 'Request failed' }); return; }
            renderReceipts(res.j);
            var isStop = /^STOP\b/.test(res.j.reply || '');
            signals.onResponse({ text: res.j.reply, role: isStop ? 'stop' : 'ai' });
          })
          .catch(function (e) { signals.onResponse({ error: String((e && e.message) || e) }); });
      }
    };
  }

  function wireQuick() {
    Array.prototype.forEach.call(document.querySelectorAll('.quick button[data-msg]'), function (b) {
      b.addEventListener('click', function () {
        if (chat && chat.submitUserMessage) chat.submitUserMessage({ text: b.getAttribute('data-msg') });
      });
    });
    var memlink = $('memlink'), who = $('who');
    if (memlink && who) {
      var sync = function () { memlink.href = '/memory?user=' + encodeURIComponent((who.value.trim() || DEFAULT_USER)); };
      who.addEventListener('change', sync); sync();
    }
  }

  /* ---- wallet identity (nonce-based sign-in) ---- */
  function wireWallet() {
    var who2 = $('who2'), btn = $('connect'), vault = $('vaultlink'), ob = $('obsteps'), signnote = $('signnote'), whoInput = $('who');
    if (!btn) return;
    var account = null;

    function stepList(names) { ob.className = 'obsteps on'; ob.innerHTML = ''; names.forEach(function (n) { var d = document.createElement('div'); d.className = 'step'; d.textContent = n; ob.appendChild(d); }); }
    function stepMark(i, cls, text) { var d = ob.children[i]; if (!d) return; d.className = 'step ' + cls; if (text) d.textContent = text; }
    function stepErr(i, e) { stepMark(i, 'err', 'Failed: ' + ((e && e.error) ? e.error : (e && e.message) ? e.message : String(e))); }
    function setSignedOut() { who2.textContent = 'Not signed in \u2014 using the shared demo channel'; btn.textContent = 'Connect Sui Wallet'; btn.style.display = ''; vault.style.display = 'none'; }
    function setSignedIn(st) {
      who2.innerHTML = '';
      who2.appendChild(document.createTextNode('Signed in as '));
      var b = document.createElement('b'); b.textContent = short(st.address); who2.appendChild(b);
      if (st.onboarded) {
        btn.style.display = 'none'; signnote.style.display = 'none';
        vault.href = 'https://suiscan.xyz/mainnet/account/' + st.accountId;
        vault.textContent = 'vault ' + short(st.accountId) + ' \u2197'; vault.style.display = '';
        whoInput.disabled = true; whoInput.value = 'my vault (wallet)';
      } else { btn.style.display = ''; btn.textContent = st.needsRelink ? 'Re-link my vault' : 'Create my memory vault'; }
    }
    function getWallets() { try { return (window.getWallets ? window.getWallets() : []) || []; } catch (e) { return []; } }
    function pickWallet() {
      var ws = getWallets();
      for (var i = 0; i < ws.length; i++) { var f = ws[i].features || {}; if (f['standard:connect'] && (f['sui:signPersonalMessage'] || f['sui:signTransactionBlock'] || f['standard:signTransaction'])) return ws[i]; }
      return ws[0] || null;
    }
    async function ensureConnected(w) { if (account) return account; var conn = await w.features['standard:connect'].connect(); account = (conn.accounts || [])[0] || null; if (!account) throw { message: 'wallet returned no account' }; return account; }
    async function signTx(w, acct, bytes) {
      var f = w.features || {};
      if (f['standard:signTransaction']) { var r1 = await f['standard:signTransaction'].signTransaction({ transaction: { bytes: bytes, chain: 'sui:mainnet' }, account: acct, chain: 'sui:mainnet' }); return r1.signature; }
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
      try {
        var i = 0;
        if (needsCreate) {
          stepMark(0, 'active', 'Preparing transaction\u2026');
          var p = await post('/api/wallet/onboard/create');
          if (p.error) throw p;
          stepMark(0, 'active', 'Waiting for your signature\u2026');
          var s1 = await signTx(w, acct, b64ToBytes(p.txBytesBase64));
          var c1 = await post('/api/wallet/onboard/complete', { signature: s1 });
          if (c1.error) throw c1;
          stepMark(0, 'done', 'Vault created \u2713 ' + short(c1.accountId)); i = 1;
        }
        stepMark(i, 'active', 'Preparing link transaction\u2026');
        var pl = await post('/api/wallet/onboard/link');
        if (pl.error) throw pl;
        stepMark(i, 'active', 'Waiting for your signature\u2026');
        var s2 = await signTx(w, acct, b64ToBytes(pl.txBytesBase64));
        var c2 = await post('/api/wallet/onboard/complete', { signature: s2 });
        if (c2.error) throw c2;
        stepMark(i, 'done', 'DoseDaughter linked \u2713');
        stepMark(i + 1, 'done', 'Your memories now live in your own on-chain vault');
        var st = await fetch('/api/wallet/status').then(function (r) { return r.json(); });
        setTimeout(function () { setSignedIn(st); ob.className = 'obsteps'; }, 2500);
      } catch (e) { stepErr(typeof i === 'number' ? i : 0, e); }
    }

    fetch('/api/wallet/status').then(function (r) { return r.json(); }).then(function (j) { if (j && j.signedIn) setSignedIn(j); else setSignedOut(); }).catch(setSignedOut);
  }

  function init() { initChat(); wireQuick(); wireWallet(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
