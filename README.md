# x402-seatbelt

**A seatbelt for AI agents that pay with [x402](https://www.x402.org).** Spending budgets, per-payment caps, an emergency stop and an optional **Pay Safe** check, applied to every payment **before it leaves your machine**.

Agents that pay for APIs can overspend, pay a service that's down, get charged more than the listed price, or pay a tampered wallet. x402-seatbelt wraps `fetch`, reads each signed payment as it's about to go out, and blocks it when it crosses a line you set. A blocked payment is never delivered, so **nothing is paid**.

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { createSeatbelt } from "x402-seatbelt";

const seatbelt = createSeatbelt({
  maxTotalUsd: 2.0,      // budget for all payments
  maxPaymentUsd: 0.05,   // no single payment above 5 cents
  paySafe: true,         // optional: check each payment with Pay Safe first
});

const fetchWithPayment = wrapFetchWithPayment(seatbelt.wrap(fetch), client);

await fetchWithPayment("https://api.example.com/paid-endpoint");
console.log(seatbelt.report()); // { payments: 1, spentUsd: 0.01, blocked: 0, ... }
```

The seatbelt goes **inside** the x402 client (`wrap(fetch)` is passed to `wrapFetchWithPayment`), so it sees the paid retry that the client sends.

## Install

```bash
npm install x402-seatbelt
```

No dependencies. It works anywhere `fetch` does: Node 18+, Deno, Bun, Cloudflare Workers and browsers. It ships as both ESM and CommonJS, with types.

## Options

| Option | What happens |
|---|---|
| `maxTotalUsd` | A payment that would push the total over the budget is never sent. Parallel payments reserve their amount, so they can't overshoot together. |
| `maxPaymentUsd` | Any single payment above the cap is blocked. Payments in other assets are blocked too, because their dollar value is unknown. |
| `maxPayments` | Blocks payments after this many. |
| `paySafe` | Checks each payment with Pay Safe (see below). Off by default. |
| `paySafeBlock` | `"stop"` (default) blocks STOP answers; `"caution"` also blocks CAUTION. |
| `paySafeFailClosed` | Blocks payments when Pay Safe can't be reached (default: let them through). |
| `paySafeUrl`, `paySafeTimeoutMs` | Endpoint (default: the public Pay Safe) and timeout (default 8000). |
| `onEvent` | A callback for every payment, block and Pay Safe answer. |

- `seatbelt.stop()` blocks every further payment (an emergency stop).
- `seatbelt.report()` returns payments, `spentUsd`, `pendingUsd`, blocked count, Pay Safe checks and the last 200 events.

A blocked payment throws **`PaymentBlockedError`** with a `reason`: `budget`, `max_payment`, `max_payments`, `unknown_value`, `pay_safe`, `pay_safe_unavailable` or `stopped`. The error also carries the `payment`, and Pay Safe's `verdict` when that was the cause.

Failed calls aren't counted: a payment only counts when the service accepted it (a `PAYMENT-RESPONSE` header or a 2xx answer). x402 v1 and v2 are both supported.

## Pay Safe (optional, off by default)

With `paySafe: true`, each payment is checked by [Pay Safe](https://agent-deals.gm-tools.workers.dev/trust) before it's sent. It returns **GO / CAUTION / STOP**:

- **Is the service working?** It's monitored continuously across ~25,000 paid agent APIs.
- **Is the price fair?** It compares the price with the service's own listing, what it charged before, and similar services.
- **Is the wallet safe?** It checks scam lists and burn addresses, and whether this is the same wallet the service normally uses. A different wallet can mean a tampered payment request.

**What is sent:** the service URL and the payment terms (amount, asset, network, pay-to wallet). **Never** the signature, your keys or your request content. Answers are cached for a minute. The check is free. Pay Safe is run by the author of this package, and its accuracy tests are [published](https://agent-deals.gm-tools.workers.dev/trust).

## Also for Python

[`agentseatbelt`](https://pypi.org/project/agentseatbelt/) does the same for Python agents (httpx, requests and Coinbase's `x402` client), plus LLM cost budgets, rate limits and loop detection.

## License

MIT
