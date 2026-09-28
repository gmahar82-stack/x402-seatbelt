# Changelog

## 0.1.0 (2026-09-28)

First release.

- `createSeatbelt()` / `seatbelt.wrap(fetch)`: checks every x402 payment (v1 and v2) before it's sent
- `maxTotalUsd` (with reservations, so parallel payments can't overshoot), `maxPaymentUsd`, `maxPayments`, `stop()`
- Optional Pay Safe check (`paySafe: true`), with `paySafeBlock`, `paySafeFailClosed`, `paySafeUrl` and `paySafeTimeoutMs`
- `PaymentBlockedError` with a reason, and `seatbelt.report()`
- Works with `@x402/fetch`; ESM + CommonJS, zero dependencies
