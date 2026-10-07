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

test('txPays: USDG payment detected via token balance delta', () => {
  const ref = P.generateReference();
  const keys = ['Sender1111111111111111111111111111111111', 'TokenAcct11111111111111111111111111111', ref];
  const postTok = [{ accountIndex: 1, mint: USDG, owner: KYLE, uiTokenAmount: { amount: '25000000', decimals: 6 } }];
  const tx = fakeTx({ keys, postTok });
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDG, decimals: 6, reference: ref }), true);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDC, decimals: 6, reference: ref }), false);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '26', mint: USDG, decimals: 6, reference: ref }), false);
});
