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

### Pointing Pay Safe at your own endpoint

Set `paySafeUrl` to any endpoint that implements the verdict protocol below, and the seatbelt consults it instead of the public Pay Safe. This is how third-party risk oracles plug in.

**Request.** `POST` with `Content-Type: application/json` and `User-Agent: x402-seatbelt`:

```json
{
  "url": "https://service.example/v1/thing",
  "method": "POST",
  "payment_required": {
    "x402Version": 2,
    "resource": { "url": "https://service.example/v1/thing" },
    "accepts": [
      { "scheme": "exact", "network": "eip155:8453", "amount": "30000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA4", "payTo": "0xabc..." }
    ]
  }
}
```

The `accepts` array carries the payment terms the seatbelt parsed (or reconstructed) from the 402 response: scheme, network, amount in base units as a string, asset contract and pay-to wallet. Only the service URL, the HTTP method and the payment terms are sent.

**Response.** JSON with a `verdict` of `"go"`, `"caution"` or `"stop"`, plus an optional human-readable `summary` and optional `findings`:

```json
{ "verdict": "caution", "summary": "Wallet differs from the service's usual one", "findings": ["payTo not seen before"] }
```

A non-2xx status or a missing/invalid verdict counts as "unavailable": the payment goes through unless `paySafeFailClosed` is set. `stop` always blocks; `caution` blocks only when `paySafeBlock` is `"caution"`. Answers are cached for 60 seconds per service URL and payment terms. The request times out after `paySafeTimeoutMs` (default 8000 ms).

## Also for Python

[`agentseatbelt`](https://pypi.org/project/agentseatbelt/) does the same for Python agents (httpx, requests and Coinbase's `x402` client), plus LLM cost budgets, rate limits and loop detection.

## License

MIT
