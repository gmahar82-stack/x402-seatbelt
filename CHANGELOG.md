# Changelog

## 0.2.1 (unreleased)

Emergency stop: nothing further leaves after `stop()`.

- A resend of a payment whose answer was lost now stops too, both automatic resends and the program sending the same signed payment again (`reason: "stopped"`). The payment stays unconfirmed and keeps counting against the budget.
- README: new section on what emergency stop covers. Thanks to Chris Polaris for asking where the boundary is.

## 0.2.0 (2026-10-18)

- Lost answers: when a signed payment gets no answer (network error, timeout, 502/503/504/52x), the seatbelt resends
  the same signed payment (`lostAnswerRetries`, default 2; `lostAnswerRetryDelayMs`, default 1000) and never signs
  a new one
- Still no answer: the payment is "unconfirmed". It keeps counting against `maxTotalUsd`, is listed in
  `report().unconfirmed` / `unconfirmedUsd`, and a new signed payment for the same request is blocked
  (`reason: "unconfirmed_payment"`; turn off with `blockNewPaymentWhileUnconfirmed: false`)
- `seatbelt.resolveUnconfirmed(url, charged, method)` settles it by hand
- Behaviour change: a payment whose request threw used to be counted as "not charged"; it's now unconfirmed

## 0.1.0 (2026-09-28)

First release.

- `createSeatbelt()` / `seatbelt.wrap(fetch)`: checks every x402 payment (v1 and v2) before it's sent
- `maxTotalUsd` (with reservations, so parallel payments can't overshoot), `maxPaymentUsd`, `maxPayments`, `stop()`
- Optional Pay Safe check (`paySafe: true`), with `paySafeBlock`, `paySafeFailClosed`, `paySafeUrl` and `paySafeTimeoutMs`
- `PaymentBlockedError` with a reason, and `seatbelt.report()`
- Works with `@x402/fetch`; ESM + CommonJS, zero dependencies
