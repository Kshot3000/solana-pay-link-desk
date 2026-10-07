import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../paylink.js');

const KYLE = '9WMsvgpQQgtvfV4g2Mm7U6mHRGpVvEmFvQGAAu4aArU8';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDG = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH';

test('base58 round-trips a real address', () => {
  const bytes = P.bs58Decode(KYLE);
  assert.equal(bytes.length, 32);
  assert.equal(P.bs58Encode(bytes), KYLE);
});

test('base58 round-trips the all-zero (System Program) address', () => {
  // The all-zero 32-byte address is the System Program — the most famous
  // address on Solana. Encoding must emit exactly one '1' per zero byte;
  // an extra '1' makes a 33-char string that decodes to 33 bytes and is
  // rejected as an address, so encode/decode did not round-trip.
  const zero32 = new Array(32).fill(0);
  const SYS = '11111111111111111111111111111111';
  assert.equal(SYS.length, 32);
  assert.equal(P.bs58Encode(zero32), SYS);
  assert.deepEqual(P.bs58Decode(SYS), zero32);
  assert.equal(P.isValidSolanaAddress(SYS), true);
  // shorter all-zero payloads follow the same rule
  assert.equal(P.bs58Encode([0]), '1');
  assert.equal(P.bs58Encode([0, 0, 0]), '111');
  assert.deepEqual(P.bs58Decode('1'), [0]);
});

test('address validation', () => {
  assert.equal(P.isValidSolanaAddress(KYLE), true);
  assert.equal(P.isValidSolanaAddress(USDC), true);
  assert.equal(P.isValidSolanaAddress('not-an-address'), false);
  assert.equal(P.isValidSolanaAddress('0OIl'), false);
  assert.equal(P.isValidSolanaAddress(''), false);
  assert.equal(P.isValidSolanaAddress(KYLE.slice(0, 20)), false);
});

test('token presets carry the verified mints', () => {
  assert.equal(P.TOKENS.USDC.mint, USDC);
  assert.equal(P.TOKENS.USDG.mint, USDG);
  assert.equal(P.TOKENS.SOL.mint, null);
});

test('amount validation', () => {
  assert.equal(P.isValidAmount('25.00'), true);
  assert.equal(P.isValidAmount('0.5'), true);
  assert.equal(P.isValidAmount('0'), false);
  assert.equal(P.isValidAmount('0.00'), false);
  assert.equal(P.isValidAmount('-3'), false);
  assert.equal(P.isValidAmount('1e5'), false);
  assert.equal(P.isValidAmount('abc'), false);
  assert.equal(P.normalizeAmount('25.00'), '25');
  assert.equal(P.normalizeAmount('0.50'), '0.5');
});

test('build + parse round-trip', () => {
  const ref = P.generateReference();
  assert.equal(P.isValidSolanaAddress(ref), true);
  const url = P.buildPayUrl({
    recipient: KYLE, amount: '25.00', splToken: USDG,
    reference: ref, label: 'My Store', message: 'Order #7 thanks', memo: 'Order #7'
  });
  assert.ok(url.startsWith('solana:' + KYLE + '?'));
  assert.ok(url.includes('amount=25'));
  assert.ok(url.includes('spl-token=' + USDG));
  const parsed = P.parsePayUrl(url);
  assert.equal(parsed.recipient, KYLE);
  assert.equal(parsed.amount, '25');
  assert.equal(parsed.splToken, USDG);
  assert.deepEqual(parsed.references, [ref]);
  assert.equal(parsed.label, 'My Store');
  assert.equal(parsed.message, 'Order #7 thanks');
  assert.equal(parsed.memo, 'Order #7');
});

test('build + parse round-trip preserves multiple references', () => {
  // Solana Pay allows repeated reference params; wallets include all of
  // them in the payment transaction, so none may be lost in transit.
  const r1 = P.generateReference();
  const r2 = P.generateReference();
  const url = P.buildPayUrl({ recipient: KYLE, amount: '5', references: [r1, r2] });
  assert.equal(url.split('reference=').length - 1, 2);
  assert.deepEqual(P.parsePayUrl(url).references, [r1, r2]);
  // an invalid entry anywhere in the list is rejected, not dropped
  assert.throws(() => P.buildPayUrl({ recipient: KYLE, references: [r1, 'bad'] }), /Invalid reference/);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?reference=' + r1 + '&reference=bad'), null);
});

test('build rejects bad inputs', () => {
  assert.throws(() => P.buildPayUrl({ recipient: 'bad' }));
  assert.throws(() => P.buildPayUrl({ recipient: KYLE, amount: '-1' }));
  assert.throws(() => P.buildPayUrl({ recipient: KYLE, splToken: 'bad' }));
});

test('an explicit empty mint is rejected, never silently a SOL link', () => {
  // Regression: choosing "custom SPL mint" with the field left blank used
  // to build a native-SOL payment link — the wrong asset entirely.
  assert.throws(() => P.buildPayUrl({ recipient: KYLE, amount: '25', splToken: '' }), /Invalid SPL token mint/);
  // an absent mint (undefined / null) is still a plain SOL link
  assert.ok(!P.buildPayUrl({ recipient: KYLE, amount: '25' }).includes('spl-token'));
  assert.ok(!P.buildPayUrl({ recipient: KYLE, amount: '25', splToken: null }).includes('spl-token'));
  // and a valid custom mint still builds an SPL link
  assert.ok(P.buildPayUrl({ recipient: KYLE, amount: '25', splToken: USDG }).includes('spl-token=' + USDG));
});

test('an explicit empty reference is rejected, never silently dropped', () => {
  // Regression (shared pay view): a crafted ?reference= used to be dropped
  // by a truthiness check, rendering a payment request whose payment could
  // never be looked up. The builder must refuse an empty reference entry
  // outright — the pay view passes present-but-empty values through
  // verbatim and relies on this throw to show "Invalid payment link".
  assert.throws(() => P.buildPayUrl({ recipient: KYLE, amount: '25', references: [''] }), /Invalid reference/);
  assert.throws(() => P.buildPayUrl({ recipient: KYLE, amount: '25', reference: '' }), /Invalid reference/);
  // an absent reference is still a plain (unverifiable) link
  assert.ok(!P.buildPayUrl({ recipient: KYLE, amount: '25' }).includes('reference'));
  const ref = P.generateReference();
  assert.ok(P.buildPayUrl({ recipient: KYLE, amount: '25', references: [ref] }).includes('reference=' + ref));
});

test('parse rejects garbage', () => {
  assert.equal(P.parsePayUrl('https://example.com'), null);
  assert.equal(P.parsePayUrl('solana:bad'), null);
  assert.equal(P.parsePayUrl(''), null);
});

test('decimalToRaw precision', () => {
  assert.equal(P.decimalToRaw('25', 6), 25000000n);
  assert.equal(P.decimalToRaw('0.5', 9), 500000000n);
  assert.equal(P.decimalToRaw('1.000001', 6), 1000001n);
  assert.equal(P.decimalToRaw('1.0000001', 6), null); // too precise for 6 decimals
});

function fakeTx({ pre = [], post = [], preTok = [], postTok = [], keys = [], err = null }) {
  return {
    meta: { err, preBalances: pre, postBalances: post, preTokenBalances: preTok, postTokenBalances: postTok },
    transaction: { message: { accountKeys: keys } }
  };
}

test('txPays: SOL payment detected via balance delta', () => {
  const ref = P.generateReference();
  const keys = ['Sender1111111111111111111111111111111111', KYLE, ref];
  const tx = fakeTx({ keys, pre: [1000000000, 0, 0], post: [974000000, 25000000, 0] });
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '0.025', mint: null, reference: ref }), true);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '0.03', mint: null, reference: ref }), false);
  // wrong reference must fail even if balances moved
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '0.025', mint: null, reference: P.generateReference() }), false);
  // failed tx never counts
  const failed = fakeTx({ keys, err: { InstructionError: [0, 'x'] }, pre: [1000000000, 0, 0], post: [974000000, 25000000, 0] });
  assert.equal(P.txPays(failed, { recipient: KYLE, amount: '0.025', mint: null, reference: ref }), false);
});

test('build rejects amounts too precise for the token', () => {
  // USDC has 6 decimals: a 7th fractional digit can never be paid exactly
  assert.throws(() => P.buildPayUrl({ recipient: KYLE, amount: '1.0000001', splToken: USDC }), /too many decimal places/);
  // SOL has 9 decimals
  assert.throws(() => P.buildPayUrl({ recipient: KYLE, amount: '0.0000000001' }), /too many decimal places/);
  // an explicit decimals override is honoured for unknown mints
  assert.throws(() => P.buildPayUrl({ recipient: KYLE, amount: '1.001', splToken: USDC, decimals: 2 }), /too many decimal places/);
  // trailing zeros do not count against precision: 1.5000000 USDC is exactly 1.5
  const ok = P.buildPayUrl({ recipient: KYLE, amount: '1.5000000', splToken: USDC });
  assert.ok(ok.includes('amount=1.5'));
  // exactly at the limit is fine
  assert.ok(P.buildPayUrl({ recipient: KYLE, amount: '0.000001', splToken: USDC }).includes('amount=0.000001'));
  assert.equal(P.knownDecimals(null), 9);
  assert.equal(P.knownDecimals(USDC), 6);
  assert.equal(P.knownDecimals(KYLE), undefined); // a wallet address is not a known mint
});

test('parse rejects malformed encodings and invalid field values', () => {
  // malformed percent-encoding must return null, not throw URIError
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?label=%zz'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?label=100%'), null);
  // field values the builder would refuse are rejected here too
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?amount=abc'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?amount=-3'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?amount=0'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?spl-token=bad'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?reference=bad'), null);
  // a well-formed link with encoded text still parses
  const good = P.parsePayUrl('solana:' + KYLE + '?amount=2.5&label=My%20Store');
  assert.equal(good.amount, '2.5');
  assert.equal(good.label, 'My Store');
});

test('decimalToRaw returns null (never throws) on non-decimal input', () => {
  assert.equal(P.decimalToRaw('abc', 6), null);
  assert.equal(P.decimalToRaw('', 6), null);
  assert.equal(P.decimalToRaw('1.2.3', 6), null);
  const tx = fakeTx({ keys: [KYLE], pre: [0], post: [0] });
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: 'abc', mint: null }), false);
  // a too-precise SOL amount must never verify — not even when the
  // recipient gained funds (null raw amount compared as 0 before the fix)
  const rich = fakeTx({ keys: [KYLE], pre: [0], post: [5000000000] });
  assert.equal(P.txPays(rich, { recipient: KYLE, amount: '0.0000000001', mint: null }), false);
});

test('txPays: payment into a second token account for the same mint counts', () => {
  // A wallet can own several token accounts for one mint; the payment may
  // land in any of them. Verification must aggregate the owner's accounts,
  // not stop at the first matching balance entry.
  const ref = P.generateReference();
  const keys = ['Sender1111111111111111111111111111111111', ref];
  const preTok = [
    { accountIndex: 1, mint: USDG, owner: KYLE, uiTokenAmount: { amount: '7000000', decimals: 6 } },
    { accountIndex: 2, mint: USDG, owner: KYLE, uiTokenAmount: { amount: '0', decimals: 6 } }
  ];
  const postTok = [
    { accountIndex: 1, mint: USDG, owner: KYLE, uiTokenAmount: { amount: '7000000', decimals: 6 } },
    { accountIndex: 2, mint: USDG, owner: KYLE, uiTokenAmount: { amount: '25000000', decimals: 6 } }
  ];
  const tx = fakeTx({ keys, preTok, postTok });
  assert.equal(P.tokenDelta(tx, KYLE, USDG), 25000000n);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDG, decimals: 6, reference: ref }), true);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '26', mint: USDG, decimals: 6, reference: ref }), false);
  // a gain in another mint or another owner's account must not count
  const other = fakeTx({ keys, preTok, postTok: [
    { accountIndex: 1, mint: USDC, owner: KYLE, uiTokenAmount: { amount: '32000000', decimals: 6 } },
    { accountIndex: 2, mint: USDG, owner: 'SomeoneElse1111111111111111111111111111', uiTokenAmount: { amount: '25000000', decimals: 6 } }
  ] });
  assert.equal(P.txPays(other, { recipient: KYLE, amount: '25', mint: USDG, decimals: 6, reference: ref }), false);
});

test('txPays: every reference of a multi-reference link must be present', () => {
  // Regression: verification only checked the first reference, so a
  // transaction carrying just that one (e.g. a payment for a different
  // link sharing it) verified as paying a two-reference link.
  const r1 = P.generateReference();
  const r2 = P.generateReference();
  const sender = 'Sender1111111111111111111111111111111111';
  const balances = { pre: [1000000000, 0], post: [0, 5000000000] };
  const both = fakeTx({ keys: [sender, KYLE, r1, r2], ...balances });
  assert.equal(P.txPays(both, { recipient: KYLE, amount: '5', mint: null, references: [r1, r2] }), true);
  const onlyFirst = fakeTx({ keys: [sender, KYLE, r1], ...balances });
  assert.equal(P.txPays(onlyFirst, { recipient: KYLE, amount: '5', mint: null, references: [r1, r2] }), false);
  const onlySecond = fakeTx({ keys: [sender, KYLE, r2], ...balances });
  assert.equal(P.txPays(onlySecond, { recipient: KYLE, amount: '5', mint: null, references: [r1, r2] }), false);
  // singular and array forms combine: both are required
  assert.equal(P.txPays(onlyFirst, { recipient: KYLE, amount: '5', mint: null, reference: r1, references: [r2] }), false);
  assert.equal(P.txPays(both, { recipient: KYLE, amount: '5', mint: null, reference: r1, references: [r2] }), true);
});

test('pay-page links parse to the same request as their solana: form', () => {
  // The desk produces two link forms: the solana: URL and the hosted pay
  // page (Open pay page / saved links / embed snippet). People copy the
  // pay-page URL out of their browser, so the verifier must accept it —
  // previously parsePayUrl returned null for it and Verify rejected the
  // desk's own link as "not a valid Solana Pay link".
  const r1 = P.generateReference();
  const r2 = P.generateReference();
  const solanaUrl = P.buildPayUrl({
    recipient: KYLE, amount: '25.00', splToken: USDC,
    references: [r1, r2], label: 'My Store', message: 'Order #7 thanks', memo: 'Order #7'
  });
  const qs = new URLSearchParams({
    recipient: KYLE, amount: '25', 'spl-token': USDC, label: 'My Store', message: 'Order #7 thanks', memo: 'Order #7'
  });
  qs.append('reference', r1);
  qs.append('reference', r2);
  const pageUrl = 'https://kshot3000.github.io/solana-pay-link-desk/?' + qs.toString();
  assert.deepEqual(P.parsePayPageUrl(pageUrl), P.parsePayUrl(solanaUrl));
  // a plain SOL pay-page link (no spl-token) parses too
  const solPage = P.parsePayPageUrl('https://example.com/pay?recipient=' + KYLE + '&amount=0.5&reference=' + r1);
  assert.equal(solPage.recipient, KYLE);
  assert.equal(solPage.amount, '0.5');
  assert.equal(solPage.splToken, null);
  assert.deepEqual(solPage.references, [r1]);
});

test('pay-page parser rejects malformed links instead of dropping fields', () => {
  const ref = P.generateReference();
  const base = 'https://example.com/?recipient=' + KYLE;
  // no recipient at all is not a payment request
  assert.equal(P.parsePayPageUrl('https://example.com/?amount=5'), null);
  // invalid recipient / amount / mint / reference values the builder refuses
  assert.equal(P.parsePayPageUrl('https://example.com/?recipient=bad&amount=5'), null);
  assert.equal(P.parsePayPageUrl(base + '&amount=abc'), null);
  assert.equal(P.parsePayPageUrl(base + '&amount=0'), null);
  assert.equal(P.parsePayPageUrl(base + '&spl-token=bad'), null);
  assert.equal(P.parsePayPageUrl(base + '&reference=bad'), null);
  // present-but-empty fields are malformed, not absent (the pay view's rule)
  assert.equal(P.parsePayPageUrl(base + '&amount='), null);
  assert.equal(P.parsePayPageUrl(base + '&amount=5&spl-token='), null);
  assert.equal(P.parsePayPageUrl(base + '&amount=5&reference=' + ref + '&reference='), null);
  // not a pay-page URL at all
  assert.equal(P.parsePayPageUrl('solana:' + KYLE + '?amount=5'), null);
  assert.equal(P.parsePayPageUrl('not a url'), null);
  assert.equal(P.parsePayPageUrl(''), null);
});

test('txPays: an open-amount SOL link verifies on any positive payment', () => {
  // Regression: the generator's amount field is optional, so open-amount
  // links are a first-class product output — but verification punted on
  // them (checkPayment returned early and txPays fed the null amount to
  // decimalToRaw), so a real payment of such a link reported as unpaid.
  const ref = P.generateReference();
  const keys = ['Sender1111111111111111111111111111111111', KYLE, ref];
  const paid = fakeTx({ keys, pre: [1000000000, 0, 0], post: [974000000, 25000000, 0] });
  assert.equal(P.txPays(paid, { recipient: KYLE, amount: null, mint: null, reference: ref }), true);
  assert.equal(P.paymentDelta(paid, { recipient: KYLE, mint: null }), 25000000n);
  // nothing gained, or a loss (fees), is not a payment
  const flat = fakeTx({ keys, pre: [1000000000, 0, 0], post: [1000000000, 0, 0] });
  assert.equal(P.txPays(flat, { recipient: KYLE, amount: null, mint: null, reference: ref }), false);
  const loss = fakeTx({ keys, pre: [0, 5000, 0], post: [0, 0, 0] });
  assert.equal(P.txPays(loss, { recipient: KYLE, amount: null, mint: null, reference: ref }), false);
  // the reference requirement still applies, and failed txs never count
  assert.equal(P.txPays(paid, { recipient: KYLE, amount: null, mint: null, reference: P.generateReference() }), false);
  const failed = fakeTx({ keys, err: { InstructionError: [0, 'x'] }, pre: [1000000000, 0, 0], post: [974000000, 25000000, 0] });
  assert.equal(P.txPays(failed, { recipient: KYLE, amount: null, mint: null, reference: ref }), false);
});

test('txPays: an open-amount SPL link verifies without knowing the mint decimals', () => {
  // Any positive raw-unit gain of the right mint counts; comparing raw
  // units needs no decimals, so an unknown custom mint verifies too.
  const ref = P.generateReference();
  const keys = ['Sender1111111111111111111111111111111111', 'TokenAcct11111111111111111111111111111', ref];
  const postTok = [{ accountIndex: 1, mint: USDG, owner: KYLE, uiTokenAmount: { amount: '25000000', decimals: 6 } }];
  const tx = fakeTx({ keys, postTok });
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: null, mint: USDG, reference: ref }), true);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: null, mint: USDG, decimals: null, reference: ref }), true);
  // no gain of the requested mint is not a payment
  const empty = fakeTx({ keys });
  assert.equal(P.txPays(empty, { recipient: KYLE, amount: null, mint: USDG, reference: ref }), false);
  // a FIXED amount still requires decimals — unknown precision must not verify
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDG, decimals: null, reference: ref }), false);
});

test('parse rejects duplicated single-value parameters in solana: links', () => {
  // Regression: reference is the only repeatable Solana Pay parameter,
  // but parsePayUrl kept the LAST value of any other duplicated field
  // while the pay-page parser keeps the FIRST — amount=1&amount=999
  // verified as 999 in solana: form and as 1 in pay-page form, and a
  // duplicated spl-token flipped the asset the same way. A duplicated
  // single-value field is ambiguous and the builder never emits one,
  // so the parser must reject the link outright (either order, and
  // even when both copies carry the same value).
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?amount=1&amount=999'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?amount=999&amount=1'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?amount=5&amount=5'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?amount=5&spl-token=' + USDC + '&spl-token=' + USDG), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?label=First&label=Second'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?message=A&message=B'), null);
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?memo=A&memo=B'), null);
  // a percent-encoded key spelling still counts as the same field
  assert.equal(P.parsePayUrl('solana:' + KYLE + '?amount=5&%61mount=6'), null);
  // references may still repeat — that is the one legal repetition
  const r1 = P.generateReference();
  const r2 = P.generateReference();
  const ok = P.parsePayUrl('solana:' + KYLE + '?amount=5&reference=' + r1 + '&reference=' + r2);
  assert.deepEqual(ok.references, [r1, r2]);
  assert.equal(ok.amount, '5');
});

test('pay-page parser rejects duplicated single-value parameters', () => {
  // The pay-page form must apply the same rule as the solana: form —
  // URLSearchParams.get() alone would silently keep the first value,
  // which is exactly how the two forms came to disagree.
  const base = 'https://example.com/?recipient=' + KYLE;
  assert.equal(P.parsePayPageUrl(base + '&amount=1&amount=999'), null);
  assert.equal(P.parsePayPageUrl(base + '&amount=5&spl-token=' + USDC + '&spl-token=' + USDG), null);
  assert.equal(P.parsePayPageUrl('https://example.com/?recipient=' + KYLE + '&recipient=' + USDC + '&amount=5'), null);
  assert.equal(P.parsePayPageUrl(base + '&label=A&label=B'), null);
  // repeated references stay legal and intact
  const r1 = P.generateReference();
  const r2 = P.generateReference();
  const ok = P.parsePayPageUrl(base + '&amount=5&reference=' + r1 + '&reference=' + r2);
  assert.deepEqual(ok.references, [r1, r2]);
});

test('txPays: a v0 payment whose recipient arrived via a lookup table verifies', () => {
  // Regression: verification searched only the message's STATIC account
  // keys. In a versioned (v0) transaction the recipient can be loaded
  // from an address lookup table instead — the raw RPC JSON then lists
  // it under meta.loadedAddresses, and pre/postBalances align to the
  // combined order [static…, writable loads…, readonly loads…]. Such a
  // payment verified as unpaid: lamportsDelta found no index (null) and
  // a reference sitting in the readonly loads failed the key check.
  const ref = P.generateReference();
  const SENDER = 'Sender1111111111111111111111111111111111';
  const PROG = 'Token1111111111111111111111111111111111';
  const OTHER = 'OtherLoaded11111111111111111111111111111';
  // combined order: 0 SENDER, 1 PROG, 2 OTHER, 3 KYLE, 4 ref
  const tx = {
    meta: {
      err: null,
      preBalances: [1000000000, 0, 500, 0, 0],
      postBalances: [974995000, 0, 500, 25000000, 0],
      preTokenBalances: [], postTokenBalances: [],
      loadedAddresses: { writable: [OTHER, KYLE], readonly: [ref] }
    },
    transaction: { message: { accountKeys: [SENDER, PROG] } }
  };
  assert.deepEqual(P.allAccountKeys(tx), [SENDER, PROG, OTHER, KYLE, ref]);
  // the balance at KYLE's COMBINED index is the payment — not the gain
  // sitting at any other loaded address's index
  assert.equal(P.lamportsDelta(tx, KYLE), 25000000);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '0.025', mint: null, reference: ref }), true);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '0.03', mint: null, reference: ref }), false);
  // only the OTHER loaded account gained: the recipient gained nothing
  const otherGain = JSON.parse(JSON.stringify(tx));
  otherGain.meta.postBalances = [974995000, 0, 25500500, 0, 0];
  assert.equal(P.txPays(otherGain, { recipient: KYLE, amount: '0.025', mint: null, reference: ref }), false);
  // a legacy transaction (no loadedAddresses) is unaffected
  const legacy = fakeTx({ keys: [SENDER, KYLE, ref], pre: [100, 0, 0], post: [0, 25000000, 0] });
  assert.equal(P.txPays(legacy, { recipient: KYLE, amount: '0.025', mint: null, reference: ref }), true);
});

test('txPays: an SPL payment whose reference arrived via a lookup table verifies', () => {
  // The token-delta math never used account indexes, but the reference
  // presence check did — a v0 SPL payment carrying its reference in the
  // readonly loads was rejected before the balances were ever read.
  const ref = P.generateReference();
  const SENDER = 'Sender1111111111111111111111111111111111';
  const tx = {
    meta: {
      err: null, preBalances: [0], postBalances: [0],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 0, mint: USDC, owner: KYLE, uiTokenAmount: { amount: '25000000', decimals: 6 } }],
      loadedAddresses: { writable: [], readonly: [ref] }
    },
    transaction: { message: { accountKeys: [SENDER] } }
  };
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDC, decimals: 6, reference: ref }), true);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDC, decimals: 6, reference: P.generateReference() }), false);
});

const MEMO_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

test('txPays: a memo link requires a memo instruction with exactly that text', () => {
  // Regression: txPays ignored the link's memo entirely, so a payment
  // of the right amount carrying the reference verified as paid even
  // with no memo instruction at all — or a different memo. The memo is
  // part of the request (the spec has wallets include it on-chain, and
  // the official validateTransfer enforces an exact match).
  const ref = P.generateReference();
  const keys = ['Sender1111111111111111111111111111111111', KYLE, ref];
  const memoIx = (text) => ({ program: 'spl-memo', programId: MEMO_V2, parsed: text });
  function solTx(ixs, inner) {
    const tx = fakeTx({ keys, pre: [1000000000, 0, 0], post: [974000000, 25000000, 0] });
    tx.transaction.message.instructions = ixs;
    if (inner) tx.meta.innerInstructions = [{ index: 0, instructions: inner }];
    return tx;
  }
  const expect = { recipient: KYLE, amount: '0.025', mint: null, reference: ref, memo: 'Order #1234' };
  assert.equal(P.txPays(solTx([]), expect), false); // no memo instruction
  assert.equal(P.txPays(solTx([memoIx('Order #9999')]), expect), false); // wrong memo
  assert.equal(P.txPays(solTx([memoIx('Order #1234 ')]), expect), false); // near miss is not a match
  assert.equal(P.txPays(solTx([memoIx('Order #1234')]), expect), true);
  // the memo may sit among other instructions, or inside inner (CPI) ones
  assert.equal(P.txPays(solTx([{ program: 'system', parsed: { type: 'transfer' } }, memoIx('Order #1234')]), expect), true);
  assert.equal(P.txPays(solTx([], [memoIx('Order #1234')]), expect), true);
  assert.equal(P.txHasMemo(solTx([memoIx('Order #1234')]), 'Order #1234'), true);
  // a link WITHOUT a memo is unaffected — no memo instruction needed
  assert.equal(P.txPays(solTx([]), { recipient: KYLE, amount: '0.025', mint: null, reference: ref }), true);
  // and an SPL payment is held to the same rule
  const postTok = [{ accountIndex: 1, mint: USDC, owner: KYLE, uiTokenAmount: { amount: '25000000', decimals: 6 } }];
  const splTx = fakeTx({ keys: ['Sender1111111111111111111111111111111111', 'TokenAcct11111111111111111111111111111', ref], postTok });
  splTx.transaction.message.instructions = [memoIx('Order #1234')];
  const splExpect = { recipient: KYLE, amount: '25', mint: USDC, decimals: 6, reference: ref, memo: 'Order #1234' };
  assert.equal(P.txPays(splTx, splExpect), true);
  splTx.transaction.message.instructions = [];
  assert.equal(P.txPays(splTx, splExpect), false);
});

test('txPays: a memo in unparsed (programId + base58 data) form matches', () => {
  // jsonParsed leaves some instructions partially parsed: programId and
  // base58 data instead of program/parsed. The memo bytes are UTF-8 —
  // including non-ASCII text — and both memo program versions count.
  const ref = P.generateReference();
  const keys = ['Sender1111111111111111111111111111111111', KYLE, ref];
  const text = 'Order #1234 ✓';
  const data = P.bs58Encode(Array.from(new TextEncoder().encode(text)));
  function txWith(programId, ixData) {
    const tx = fakeTx({ keys, pre: [1000000000, 0, 0], post: [974000000, 25000000, 0] });
    tx.transaction.message.instructions = [{ programId, accounts: [], data: ixData }];
    return tx;
  }
  const expect = { recipient: KYLE, amount: '0.025', mint: null, reference: ref, memo: text };
  assert.equal(P.txPays(txWith(MEMO_V2, data), expect), true);
  assert.equal(P.txPays(txWith(MEMO_V1, data), expect), true);
  // the same bytes under a different program are not a memo
  assert.equal(P.txPays(txWith('11111111111111111111111111111111', data), expect), false);
  // undecodable data is not a memo either
  assert.equal(P.txPays(txWith(MEMO_V2, '!!!not-base58!!!'), expect), false);
});

test('txPays: USDG payment detected via token balance delta', () => {
  const ref = P.generateReference();
  const keys = ['Sender1111111111111111111111111111111111', 'TokenAcct11111111111111111111111111111', ref];
  const postTok = [{ accountIndex: 1, mint: USDG, owner: KYLE, uiTokenAmount: { amount: '25000000', decimals: 6 } }];
  const tx = fakeTx({ keys, postTok });
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDG, decimals: 6, reference: ref }), true);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDC, decimals: 6, reference: ref }), false);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '26', mint: USDG, decimals: 6, reference: ref }), false);
});
