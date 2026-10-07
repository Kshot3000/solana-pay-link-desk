'use strict';
/* Solana Pay Link Desk — UI wiring. Core logic lives in paylink.js. */
(function () {
  var P = window.PayLink;
  var $ = function (id) { return document.getElementById(id); };

  function tokenChoice() {
    var sel = $('f-token').value;
    if (sel === 'CUSTOM') {
      // Decimals of an arbitrary mint are unknown without an RPC lookup;
      // do not guess — the precision check is skipped for custom mints.
      return { mint: $('f-mint').value.trim(), decimals: null, symbol: 'SPL' };
    }
    var t = P.TOKENS[sel];
    return { mint: t.mint, decimals: t.decimals, symbol: t.symbol };
  }

  function qrInto(el, text) {
    el.innerHTML = '';
    try {
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 12, scalable: true });
    } catch (e) {
      el.innerHTML = '<p class="error">QR rendering failed — use the link text instead.</p>';
    }
  }

  /* ---------- generator ---------- */
  var lastGenerated = null;
  $('f-token').addEventListener('change', function () {
    $('mint-row').classList.toggle('hidden', $('f-token').value !== 'CUSTOM');
  });

  $('gen-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('gen-error').textContent = '';
    try {
      var tok = tokenChoice();
      var reference = P.generateReference();
      var url = P.buildPayUrl({
        recipient: $('f-recipient').value.trim(),
        amount: $('f-amount').value,
        // null mint (native SOL) means "no token"; a custom mint is passed
        // through verbatim — even when blank — so buildPayUrl rejects it
        // instead of silently building a SOL link for an SPL request.
        splToken: tok.mint === null ? undefined : tok.mint,
        decimals: tok.decimals,
        reference: reference,
        label: $('f-label').value.trim() || undefined,
        message: $('f-message').value.trim() || undefined,
        memo: $('f-memo').value.trim() || undefined
      });
      lastGenerated = { url: url, reference: reference, createdAt: Date.now() };
      $('r-url').textContent = url;
      $('r-ref').textContent = reference;
      qrInto($('r-qr'), url);
      var pageUrl = payPageUrl(url);
      $('r-page').href = pageUrl;
      $('r-embed').textContent =
        '<a href="' + pageUrl + '" target="_blank" rel="noopener">Pay with Solana</a>';
      $('gen-result').classList.remove('hidden');
      $('gen-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      $('gen-error').textContent = e.message;
    }
  });

  function payPageUrl(payUrl) {
    var parsed = P.parsePayUrl(payUrl);
    var base = window.location.origin + window.location.pathname;
    var qs = new URLSearchParams();
    qs.set('recipient', parsed.recipient);
    if (parsed.amount) qs.set('amount', parsed.amount);
    if (parsed.splToken) qs.set('spl-token', parsed.splToken);
    if (parsed.references[0]) qs.set('reference', parsed.references[0]);
    if (parsed.label) qs.set('label', parsed.label);
    if (parsed.message) qs.set('message', parsed.message);
    if (parsed.memo) qs.set('memo', parsed.memo);
    return base + '?' + qs.toString();
  }

  function copyText(text, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(function () { btn.textContent = old; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); done();
    }
  }
  $('r-copy').addEventListener('click', function () { if (lastGenerated) copyText(lastGenerated.url, this); });
  $('r-copy-embed').addEventListener('click', function () { copyText($('r-embed').textContent, this); });
  $('r-save').addEventListener('click', function () {
    if (!lastGenerated) return;
    var list = loadSaved();
    list.unshift(lastGenerated);
    localStorage.setItem('spld.saved', JSON.stringify(list.slice(0, 50)));
    renderSaved();
  });

  /* ---------- saved ---------- */
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem('spld.saved') || '[]'); }
    catch (e) { return []; }
  }
  function renderSaved() {
    var list = loadSaved();
    var ul = $('saved-list');
    ul.innerHTML = '';
    $('saved-empty').style.display = list.length ? 'none' : '';
    list.forEach(function (item, i) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = payPageUrl(item.url);
      a.textContent = item.url;
      a.className = 'mono break';
      var del = document.createElement('button');
      del.textContent = 'Delete';
      del.className = 'btn ghost small-btn';
      del.addEventListener('click', function () {
        var l = loadSaved(); l.splice(i, 1);
        localStorage.setItem('spld.saved', JSON.stringify(l));
        renderSaved();
      });
      li.appendChild(a); li.appendChild(del);
      ul.appendChild(li);
    });
  }
  renderSaved();

  /* ---------- RPC verification ---------- */
  function rpc(endpoint, method, params) {
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message || 'RPC error');
      return j.result;
    });
  }

  function decimalsFor(parsed) {
    if (!parsed.splToken) return 9;
    var syms = Object.keys(P.TOKENS);
    for (var i = 0; i < syms.length; i++) {
      if (P.TOKENS[syms[i]].mint === parsed.splToken) return P.TOKENS[syms[i]].decimals;
    }
    return null; // unknown mint: caller must resolve via getTokenSupply/getAccountInfo
  }

  function checkPayment(parsed, endpoint, statusEl, detailEl) {
    statusEl.textContent = 'Checking on-chain…';
    detailEl.textContent = '';
    var reference = parsed.references[0];
    if (!reference) {
      statusEl.textContent = 'This link has no reference key — payments to it cannot be looked up automatically.';
      return;
    }
    if (!parsed.amount) {
      statusEl.textContent = 'This link has no fixed amount — any payment amount counts; enter the link with an amount to verify a specific sum.';
      return;
    }
    var decimals = decimalsFor(parsed);
    var chain = Promise.resolve(decimals);
    if (decimals === null) {
      chain = rpc(endpoint, 'getTokenSupply', [parsed.splToken]).then(function (res) {
        return res.value.decimals;
      });
    }
    chain.then(function (dec) {
      return rpc(endpoint, 'getSignaturesForAddress', [reference, { limit: 10 }]).then(function (sigs) {
        return { dec: dec, sigs: sigs || [] };
      });
    }).then(function (ctx) {
      if (!ctx.sigs.length) {
        statusEl.textContent = '⏳ Not paid yet — no transaction carries this reference.';
        return null;
      }
      var expect = {
        recipient: parsed.recipient, amount: parsed.amount,
        mint: parsed.splToken, decimals: ctx.dec, reference: reference
      };
      var seq = Promise.resolve(null);
      ctx.sigs.forEach(function (s) {
        seq = seq.then(function (found) {
          if (found) return found;
          return rpc(endpoint, 'getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }])
            .then(function (tx) { return (tx && P.txPays(tx, expect)) ? s.signature : null; })
            .catch(function () { return null; });
        });
      });
      return seq.then(function (foundSig) {
        if (foundSig) {
          statusEl.textContent = '✅ Paid — verified on-chain.';
          detailEl.innerHTML = 'Transaction: <a class="mono" target="_blank" rel="noopener" href="https://explorer.solana.com/tx/' +
            foundSig + '">' + foundSig + '</a>';
        } else {
          statusEl.textContent = '⏳ Transactions reference this link, but none yet matches the requested amount/token for the recipient.';
        }
      });
    }).catch(function (e) {
      statusEl.textContent = 'RPC lookup failed: ' + e.message;
    });
  }

  $('ver-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var parsed = P.parsePayUrl($('v-link').value.trim());
    if (!parsed) { $('ver-status').textContent = 'That is not a valid Solana Pay link.'; return; }
    checkPayment(parsed, $('v-rpc').value.trim(), $('ver-status'), $('ver-detail'));
  });

  /* ---------- pay view (shared link landing) ---------- */
  (function payView() {
    var q = new URLSearchParams(window.location.search);
    if (!q.get('recipient')) return;
    var parsed = {
      recipient: q.get('recipient'),
      amount: q.get('amount'),
      splToken: q.get('spl-token'),
      references: q.get('reference') ? [q.get('reference')] : [],
      label: q.get('label'), message: q.get('message'), memo: q.get('memo')
    };
    if (!P.isValidSolanaAddress(parsed.recipient)) return;
    var url;
    try {
      url = P.buildPayUrl({
        recipient: parsed.recipient, amount: parsed.amount || undefined,
        splToken: parsed.splToken || undefined, references: parsed.references,
        label: parsed.label || undefined, message: parsed.message || undefined,
        memo: parsed.memo || undefined
      });
    } catch (e) {
      // A shared link with unbuildable fields (bad amount, bad mint,
      // over-precise amount…) must show an honest error, not die as an
      // uncaught exception that leaves a blank pay view.
      $('pv-title').textContent = 'Invalid payment link';
      $('pv-detail').textContent = 'This shared link is not valid: ' + e.message;
      $('payview').classList.remove('hidden');
      window.scrollTo(0, 0);
      return;
    }
    var tokenName = 'SOL';
    Object.keys(P.TOKENS).forEach(function (k) {
      if (P.TOKENS[k].mint === parsed.splToken) tokenName = k;
    });
    if (parsed.splToken && tokenName === 'SOL') tokenName = 'SPL token';
    $('pv-title').textContent = parsed.label || 'Payment request';
    $('pv-detail').textContent =
      (parsed.amount ? parsed.amount + ' ' + tokenName + ' → ' : 'Payment → ') + parsed.recipient +
      (parsed.message ? ' · ' + parsed.message : '');
    $('pv-url').textContent = url;
    $('pv-open').href = url;
    qrInto($('pv-qr'), url);
    $('payview').classList.remove('hidden');
    $('pv-verify').addEventListener('click', function () {
      checkPayment(P.parsePayUrl(url), 'https://api.mainnet-beta.solana.com', $('pv-status'), $('pv-status'));
    });
    window.scrollTo(0, 0);
  })();
})();
