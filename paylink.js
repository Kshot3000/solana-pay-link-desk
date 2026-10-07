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
  for (var d = digits.length - 1; d >= 0; d--) out += B58_ALPHABET[digits[d]];
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
  if (opts.splToken) {
    if (!isValidSolanaAddress(opts.splToken)) throw new Error('Invalid SPL token mint');
    params.push('spl-token=' + encodeURIComponent(opts.splToken));
  }
  var refs = opts.references || (opts.reference ? [opts.reference] : []);
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
  if (m[3]) {
    try {
      m[3].split('&').forEach(function (pair) {
        if (!pair) return;
        var idx = pair.indexOf('=');
        var k = decodeURIComponent(idx >= 0 ? pair.slice(0, idx) : pair);
        var v = idx >= 0 ? decodeURIComponent(pair.slice(idx + 1)) : '';
        if (k === 'reference') { (q.references = q.references || []).push(v); }
        else q[k] = v;
      });
    } catch (e) {
      return null; // malformed percent-encoding (e.g. a truncated paste)
    }
  }
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

/* ---------------- verification math (pure, testable) ---------------- */
/* Given a parsed transaction (jsonParsed RPC shape), decide whether it
 * pays `expect` = {recipient, amount (decimal string), mint|null}.
 * Uses balance deltas (pre/post) rather than instruction parsing so
 * inner instructions and token-program variants are covered. */
function lamportsDelta(tx, pubkey) {
  var keys = tx.transaction.message.accountKeys;
  var idx = -1;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if ((typeof k === 'string' ? k : k.pubkey) === pubkey) { idx = i; break; }
  }
  if (idx < 0 || !tx.meta) return null;
  return tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
}

function tokenDelta(tx, owner, mint) {
  if (!tx.meta) return null;
  var pre = tx.meta.preTokenBalances || [], post = tx.meta.postTokenBalances || [];
  function find(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].owner === owner && list[i].mint === mint) return list[i];
    }
    return null;
  }
  var a = find(pre), b = find(post);
  var av = a ? BigInt(a.uiTokenAmount.amount) : 0n;
  var bv = b ? BigInt(b.uiTokenAmount.amount) : 0n;
  return bv - av; // raw integer units (BigInt)
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

function txPays(tx, expect) {
  if (!tx || !tx.meta || tx.meta.err) return false;
  // The reference key must appear in the transaction's account keys
  // (Solana Pay verification requirement).
  if (expect.reference) {
    var keys = tx.transaction.message.accountKeys.map(function (k) {
      return typeof k === 'string' ? k : k.pubkey;
    });
    if (keys.indexOf(expect.reference) < 0) return false;
  }
  if (expect.mint) {
    var decimals = expect.decimals;
    if (decimals === undefined || decimals === null) return false;
    var need = decimalToRaw(expect.amount, decimals);
    if (need === null) return false;
    var got = tokenDelta(tx, expect.recipient, expect.mint);
    return got !== null && got >= need;
  }
  var needLamports = decimalToRaw(expect.amount, 9);
  if (needLamports === null) return false;
  var gotLamports = lamportsDelta(tx, expect.recipient);
  return gotLamports !== null && BigInt(gotLamports) >= needLamports;
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
  lamportsDelta: lamportsDelta,
  tokenDelta: tokenDelta,
  decimalToRaw: decimalToRaw,
  txPays: txPays
};

if (typeof module !== 'undefined' && module.exports) module.exports = PayLink;
if (typeof window !== 'undefined') window.PayLink = PayLink;
