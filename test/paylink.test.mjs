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

test('txPays: USDG payment detected via token balance delta', () => {
  const ref = P.generateReference();
  const keys = ['Sender1111111111111111111111111111111111', 'TokenAcct11111111111111111111111111111', ref];
  const postTok = [{ accountIndex: 1, mint: USDG, owner: KYLE, uiTokenAmount: { amount: '25000000', decimals: 6 } }];
  const tx = fakeTx({ keys, postTok });
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDG, decimals: 6, reference: ref }), true);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '25', mint: USDC, decimals: 6, reference: ref }), false);
  assert.equal(P.txPays(tx, { recipient: KYLE, amount: '26', mint: USDG, decimals: 6, reference: ref }), false);
});
