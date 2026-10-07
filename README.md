# Solana Pay Link Desk

**Create Solana Pay payment links + QR codes for SOL, USDC and USDG — and verify incoming
payments on-chain. Free, open source, zero backend, no custodian.**

Live: https://kshot3000.github.io/solana-pay-link-desk/

## What it does

1. **Create** — enter a recipient wallet, amount and token. The desk builds a standard
   [Solana Pay](https://docs.solanapay.com/) transfer-request URL
   (`solana:<recipient>?amount=…&spl-token=…&reference=…&label=…&message=…&memo=…`)
   with a fresh **reference key** per link, and renders it as a QR code in your browser.
2. **Share / embed** — every link has a hosted *pay page* (`index.html?recipient=…&amount=…&reference=…`)
   that shows the QR and a wallet deep-link, plus a copy-paste HTML embed snippet for any site.
3. **Verify** — paste a link back into the desk (either the `solana:` URL or the pay-page
   link copied from your browser) and it queries a public Solana RPC for
   transactions carrying the link's reference key, then checks pre/post balances:
   the recipient must have gained at least the requested amount of the requested token
   in a successful transaction (any positive amount, for open-amount links).
   No wallet connection, no signing — the desk can never move funds.

Saved links live only in your browser's local storage.

## Tokens

| Token | Mint (mainnet-beta) | Decimals |
|---|---|---|
| SOL | native | 9 |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| USDG | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` | 6 |

USDG mint per CoinDesk's supported-platforms table and RWA.xyz (verified 2026-10-04).
Custom SPL mints are supported in the generator and the verifier (decimals resolved via RPC).

## Tech

- Vanilla HTML/CSS/JS — no build step, no framework, no tracking.
- `paylink.js` — core logic (base58, Solana Pay URL build/parse, payment-verification math),
  shared between the browser and the Node test suite.
- QR rendering: vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
  (MIT, © Kazuhiko Arase) in `vendor/qrcode.js`.
- Verification runs entirely client-side against a configurable public RPC endpoint.

## Tests

```sh
node --test test/paylink.test.mjs
```

25 tests: base58 round-trip, address/amount validation, verified mint presets,
build/parse round-trip (including multi-reference links, which survive intact and
pay-page links parsing to exactly the same request as their `solana:` form),
verify only when *every* reference is present in the transaction), precision handling
(the generator refuses amounts a token cannot represent exactly, and the verifier can
never report such an amount as paid),
strict parse rejection of malformed links (including duplicated single-value
parameters — reference is the only repeatable field, and the two link forms must
never disagree on the amount or asset), an explicit-but-empty custom mint rejected
instead of silently building a SOL link, open-amount links (the generator's amount is
optional) verifying on any positive payment of the right asset — including SPL mints
whose decimals are unknown — and SOL + SPL payment detection
against synthetic `jsonParsed` transactions (including wrong-reference and failed-tx cases).

## Safety notes

- Always double-check the recipient address in your wallet before paying.
- A "paid ✓" result means a successful on-chain transaction moved at least the requested
  amount of the right token to the recipient with the link's reference attached.
  It does not identify the payer.
- This is a link generator/verifier, not a payment processor: no funds ever pass through it.

## License

MIT. Built by [@kshot9000](https://x.com/kshot9000) (GitHub: [Kshot3000](https://github.com/Kshot3000)).
Tips (SOL / USDC / USDG): `9WMsvgpQQgtvfV4g2Mm7U6mHRGpVvEmFvQGAAu4aArU8`
