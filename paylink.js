'use strict';
/*
 * Solana Pay Link Desk — core logic (no dependencies).
 * Implements the Solana Pay transfer-request spec:
 *   solana:<recipient>?amount=<n>&spl-token=<mint>&reference=<pk>&label=<s>&message=<s>&memo=<s>
 * Loaded as a plain browser script (window.PayLink) and as a CommonJS
 * module for the Node test suite.
 */

/* ---------------- base58 ---------------- */
var B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
var B58_MAP = {};
for (var bi = 0; bi < B58_ALPHABET.length; bi++) B58_MAP[B58_ALPHABET[bi]] = bi;

function bs58Encode(bytes) {
  if (!bytes || bytes.length === 0) return '';
  var zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  var digits = [0];
  for (var i = zeros; i < bytes.length; i++) {
    var carry = bytes[i];
    for (var j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  var out = '';
  for (var z = 0; z < zeros; z++) out += '1';
  // The digits accumulator starts at [0] and still holds exactly that when
  // the payload is ALL zero bytes (the digit loop never runs) — emitting
  // it would add a spurious extra '1' (the System Program address came
  // out as 33 ones instead of 32 and no longer round-tripped). A zero
  // value has no digits of its own; the leading '1's are the encoding.
  if (bytes.length > zeros) {
    for (var d = digits.length - 1; d >= 0; d--) out += B58_ALPHABET[digits[d]];
  }
  return out;
}

function bs58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) return null;
  var zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  var bytes = [0];
  for (var i = zeros; i < str.length; i++) {
    var v = B58_MAP[str[i]];
    if (v === undefined) return null;
    var carry = v;
    for (var j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  var out = [];
  for (var z2 = 0; z2 < zeros; z2++) out.push(0);
  for (var b = bytes.length - 1; b >= 0; b--) out.push(bytes[b]);
  // A lone "1...1" input decodes to all-zero bytes; drop the accumulator's
  // initial zero when the payload is empty.
  if (out.length > zeros && str === '1'.repeat(str.length)) return out.slice(0, zeros);
  return out;
}

/* ---------------- addresses ---------------- */
function isValidSolanaAddress(str) {
  if (typeof str !== 'string') return false;
  if (str.length < 32 || str.length > 44) return false;
  var decoded = bs58Decode(str);
  return !!decoded && decoded.length === 32;
}

function generateReference() {
  var bytes = new Uint8Array(32);
  var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
  if (!c || !c.getRandomValues) throw new Error('WebCrypto unavailable');
  c.getRandomValues(bytes);
  // Avoid the all-zero / System Program address edge (negligible odds,
  // but a reference must be a usable account key).
  bytes[31] = bytes[31] | 1;
  return bs58Encode(bytes);
}

/* ---------------- known tokens (mainnet-beta) ---------------- */
/* Mints verified 2026-10-04:
 * USDC — Circle USD Coin, canonical Solana mint (Solana token registry).
 * USDG — Paxos Global Dollar on Solana, per CoinDesk supported-platforms
 *        table and RWA.xyz (both list 2u1tsz…GWjGWH). */
var TOKENS = {
  SOL:  { symbol: 'SOL',  name: 'Solana (native)', mint: null, decimals: 9 },
  USDC: { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDG: { symbol: 'USDG', name: 'Global Dollar', mint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', decimals: 6 }
};

/* ---------------- amounts ---------------- */
function isValidAmount(str) {
  if (typeof str !== 'string') return false;
  var s = str.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s)) return false;
  // Must be > 0
  return /[1-9]/.test(s);
}

function normalizeAmount(str) {
  var s = String(str).trim();
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/* ---------------- build / parse ---------------- */
/* Decimals of a token this desk knows about: native SOL when there is no
 * mint, the preset table for known mints, undefined for an unknown mint
 * (its precision cannot be checked without an RPC lookup). */
function knownDecimals(mint) {
  if (!mint) return 9;
  var syms = Object.keys(TOKENS);
  for (var i = 0; i < syms.length; i++) {
    if (TOKENS[syms[i]].mint === mint) return TOKENS[syms[i]].decimals;
  }
  return undefined;
}

function buildPayUrl(opts) {
  if (!opts || !isValidSolanaAddress(opts.recipient)) {
    throw new Error('Invalid recipient address');
  }
  var params = [];
  if (opts.amount !== undefined && opts.amount !== null && String(opts.amount).trim() !== '') {
    if (!isValidAmount(String(opts.amount))) throw new Error('Invalid amount');
    // An amount the mint cannot represent exactly (more fractional digits
    // than the token has decimals, after trimming trailing zeros) can
    // never be paid or verified — refuse to build an unpayable link.
    var decimals = (opts.decimals !== undefined && opts.decimals !== null)
      ? opts.decimals : knownDecimals(opts.splToken || null);
    if (decimals !== undefined) {
      var frac = (normalizeAmount(String(opts.amount)).split('.')[1] || '');
      if (frac.length > decimals) {
        throw new Error('Amount has too many decimal places for this token (max ' + decimals + ')');
      }
    }
    params.push('amount=' + encodeURIComponent(normalizeAmount(String(opts.amount))));
  }
  // Presence-based, not truthiness-based: an explicitly supplied mint
  // (even an empty string, e.g. a custom-mint field left blank) must be
  // validated — silently dropping it would build a native-SOL link when
  // the user asked for an SPL token payment.
  if (opts.splToken !== undefined && opts.splToken !== null) {
    if (!isValidSolanaAddress(opts.splToken)) throw new Error('Invalid SPL token mint');
    params.push('spl-token=' + encodeURIComponent(opts.splToken));
  }
  // Presence-based like splToken above: an explicitly supplied reference
  // (even an empty string) must be validated — silently dropping it would
  // build a link whose payment can never be looked up by reference.
  var refs = opts.references ||
    (opts.reference !== undefined && opts.reference !== null ? [opts.reference] : []);
  refs.forEach(function (r) {
    if (!isValidSolanaAddress(r)) throw new Error('Invalid reference');
    params.push('reference=' + encodeURIComponent(r));
  });
  if (opts.label) params.push('label=' + encodeURIComponent(opts.label));
  if (opts.message) params.push('message=' + encodeURIComponent(opts.message));
  if (opts.memo) params.push('memo=' + encodeURIComponent(opts.memo));
  return 'solana:' + opts.recipient + (params.length ? '?' + params.join('&') : '');
}

function parsePayUrl(url) {
  if (typeof url !== 'string') return null;
  var m = /^solana:([1-9A-HJ-NP-Za-km-z]+)(\?(.*))?$/.exec(url.trim());
  if (!m) return null;
  var recipient = m[1];
  if (!isValidSolanaAddress(recipient)) return null;
  var q = {};
  // reference is the ONLY repeatable parameter in a Solana Pay request.
  // Every other field is single-value: a link carrying it twice is
  // ambiguous — this parser used to keep the LAST value while the
  // pay-page parser (URLSearchParams.get) keeps the FIRST, so the same
  // request written as amount=1&amount=999 verified as 999 in solana:
  // form and as 1 in pay-page form (and a duplicated spl-token flipped
  // the asset the same way). The builder never emits duplicates, so a
  // parsed link carrying one is not a link this desk could have built.
  var SINGLE_VALUE = { amount: 1, 'spl-token': 1, label: 1, message: 1, memo: 1 };
  var duplicate = false;
  if (m[3]) {
    try {
      m[3].split('&').forEach(function (pair) {
        if (!pair) return;
        var idx = pair.indexOf('=');
        var k = decodeURIComponent(idx >= 0 ? pair.slice(0, idx) : pair);
        var v = idx >= 0 ? decodeURIComponent(pair.slice(idx + 1)) : '';
        if (k === 'reference') { (q.references = q.references || []).push(v); }
        else {
          if (SINGLE_VALUE[k] && q[k] !== undefined) duplicate = true;
          q[k] = v;
        }
      });
    } catch (e) {
      return null; // malformed percent-encoding (e.g. a truncated paste)
    }
  }
  if (duplicate) return null;
  // A parsed link must be one this desk could have built: reject field
  // values the builder would refuse, instead of passing them downstream
  // where they surface as unrelated errors.
  if (q.amount !== undefined && !isValidAmount(q.amount)) return null;
  if (q['spl-token'] !== undefined && !isValidSolanaAddress(q['spl-token'])) return null;
  if (q.references) {
    for (var ri = 0; ri < q.references.length; ri++) {
      if (!isValidSolanaAddress(q.references[ri])) return null;
    }
  }
  return {
    recipient: recipient,
    amount: q.amount || null,
    splToken: q['spl-token'] || null,
    references: q.references || [],
    label: q.label || null,
    message: q.message || null,
    memo: q.memo || null
  };
}

/* Parse a pay-page link — this desk's own hosted form of a payment
 * request (index.html?recipient=…&amount=…&reference=…), as produced by
 * payPageUrl for the "Open pay page" button, saved links and the embed
 * snippet. People copy THAT URL out of their browser, so the verifier
 * must accept it as readily as the solana: form — with the same strict
 * rules: field values are presence-based (a present-but-empty amount,
 * spl-token or reference is malformed, not absent) and every value must
 * be one buildPayUrl would accept, which the rebuild below enforces.
 * Returns the same shape as parsePayUrl, or null. */
function parsePayPageUrl(url) {
  if (typeof url !== 'string') return null;
  var u;
  try { u = new URL(url.trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  var q = u.searchParams;
  if (!q.has('recipient')) return null;
  // Same duplicate rule as parsePayUrl: reference may repeat, every
  // other field is single-value. URLSearchParams.get() would silently
  // keep only the first of a duplicated amount/spl-token/recipient —
  // the opposite choice from parsePayUrl's old last-wins — so the two
  // link forms disagreed about what was being paid. Reject instead.
  var SINGLE_PAGE = ['recipient', 'amount', 'spl-token', 'label', 'message', 'memo'];
  for (var si = 0; si < SINGLE_PAGE.length; si++) {
    if (q.getAll(SINGLE_PAGE[si]).length > 1) return null;
  }
  var amount = q.has('amount') ? q.get('amount') : null;
  // buildPayUrl treats '' as "no amount" (the generator's optional field
  // relies on that), so a present-but-empty/invalid amount is rejected
  // here first — parsePayUrl rejects the same values in a solana: link.
  if (amount !== null && !isValidAmount(amount)) return null;
  var rebuilt;
  try {
    rebuilt = buildPayUrl({
      recipient: q.get('recipient'),
      amount: amount === null ? undefined : amount,
      splToken: q.has('spl-token') ? q.get('spl-token') : undefined,
      // getAll, not get: every reference belongs to the payment request;
      // an empty later one reaches buildPayUrl and is rejected there.
      references: q.has('reference') ? q.getAll('reference') : [],
      label: q.get('label') || undefined,
      message: q.get('message') || undefined,
      memo: q.get('memo') || undefined
    });
  } catch (e) {
    return null;
  }
  return parsePayUrl(rebuilt);
}

/* ---------------- verification math (pure, testable) ---------------- */
/* Given a parsed transaction (jsonParsed RPC shape), decide whether it
 * pays `expect` = {recipient, amount (decimal string), mint|null}.
 * Uses balance deltas (pre/post) rather than instruction parsing so
 * inner instructions and token-program variants are covered. */
/* Every account a transaction touches, in the order the RPC aligns
 * pre/postBalances (and token-balance accountIndexes) to: the message's
 * static accountKeys first, then the addresses a v0 transaction loaded
 * from lookup tables — writable loads first, readonly loads after —
 * which the raw JSON response reports separately as
 * meta.loadedAddresses. Searching only the static keys misses any
 * account that arrived via a lookup table. */
function allAccountKeys(tx) {
  var keys = tx.transaction.message.accountKeys.map(function (k) {
    return typeof k === 'string' ? k : k.pubkey;
  });
  var loaded = (tx.meta && tx.meta.loadedAddresses) || {};
  return keys.concat(loaded.writable || [], loaded.readonly || []);
}

function lamportsDelta(tx, pubkey) {
  if (!tx.meta) return null;
  var idx = allAccountKeys(tx).indexOf(pubkey);
  if (idx < 0) return null;
  return tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
}

function tokenDelta(tx, owner, mint) {
  if (!tx.meta) return null;
  var pre = tx.meta.preTokenBalances || [], post = tx.meta.postTokenBalances || [];
  // Sum across ALL of the owner's token accounts for this mint: a wallet
  // can hold several accounts for one mint (ATA plus legacy/program
  // accounts), and a payment may land in any of them. Taking only the
  // first matching entry misses payments to the others entirely.
  function sum(list) {
    var total = 0n;
    for (var i = 0; i < list.length; i++) {
      if (list[i].owner === owner && list[i].mint === mint) {
        total += BigInt(list[i].uiTokenAmount.amount);
      }
    }
    return total;
  }
  return sum(post) - sum(pre); // raw integer units (BigInt)
}

function decimalToRaw(amountStr, decimals) {
  var s = normalizeAmount(String(amountStr));
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s)) return null; // not a decimal string
  var parts = s.split('.');
  var whole = parts[0];
  var frac = (parts[1] || '');
  if (frac.length > decimals) return null; // more precision than the mint supports
  frac = frac + '0'.repeat(decimals - frac.length);
  return BigInt(whole) * (10n ** BigInt(decimals)) + (frac ? BigInt(frac) : 0n);
}

/* The recipient's gain, in raw units of the requested asset (lamports
 * for native SOL, smallest token units for an SPL mint), or null when
 * the transaction's balances say nothing about the recipient. */
function paymentDelta(tx, expect) {
  if (expect.mint) return tokenDelta(tx, expect.recipient, expect.mint);
  var lamports = lamportsDelta(tx, expect.recipient);
  return lamports === null ? null : BigInt(lamports);
}

function txPays(tx, expect) {
  if (!tx || !tx.meta || tx.meta.err) return false;
  // Every reference key must appear in the transaction's account keys
  // (Solana Pay verification requirement). A link may carry several
  // references; a wallet paying it includes all of them, so a transaction
  // carrying only some of them is not a payment of this link. Checking
  // only the first would verify payments made for a different link that
  // happens to share that one reference.
  var requiredRefs = expect.references ? expect.references.slice() : [];
  if (expect.reference && requiredRefs.indexOf(expect.reference) < 0) {
    requiredRefs.push(expect.reference);
  }
  if (requiredRefs.length) {
    // A reference may sit in the lookup-table loads rather than the
    // static keys (v0 transactions) — it still belongs to the payment.
    var keys = allAccountKeys(tx);
    for (var ri = 0; ri < requiredRefs.length; ri++) {
      if (keys.indexOf(requiredRefs[ri]) < 0) return false;
    }
  }
  var got = paymentDelta(tx, expect);
  if (got === null) return false;
  // Open-amount link (the request carries no amount): any positive gain
  // of the right asset by the recipient is a payment of it — that is
  // what the link asks for. Such links used to be unverifiable by
  // construction: the null amount fed decimalToRaw (null = unpaid), and
  // the SPL branch demanded decimals merely to compare. No decimals are
  // needed here: raw token units compare directly.
  if (expect.amount === null || expect.amount === undefined) {
    return got > 0n;
  }
  if (expect.mint) {
    var decimals = expect.decimals;
    if (decimals === undefined || decimals === null) return false;
    var need = decimalToRaw(expect.amount, decimals);
    if (need === null) return false;
    return got >= need;
  }
  var needLamports = decimalToRaw(expect.amount, 9);
  if (needLamports === null) return false;
  return got >= needLamports;
}

var PayLink = {
  bs58Encode: bs58Encode,
  bs58Decode: bs58Decode,
  isValidSolanaAddress: isValidSolanaAddress,
  generateReference: generateReference,
  TOKENS: TOKENS,
  isValidAmount: isValidAmount,
  normalizeAmount: normalizeAmount,
  knownDecimals: knownDecimals,
  buildPayUrl: buildPayUrl,
  parsePayUrl: parsePayUrl,
  parsePayPageUrl: parsePayPageUrl,
  allAccountKeys: allAccountKeys,
  lamportsDelta: lamportsDelta,
  tokenDelta: tokenDelta,
  paymentDelta: paymentDelta,
  decimalToRaw: decimalToRaw,
  txPays: txPays
};

if (typeof module !== 'undefined' && module.exports) module.exports = PayLink;
if (typeof window !== 'undefined') window.PayLink = PayLink;
