import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSeatbelt, PaymentBlockedError } from "../src/index.ts";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x1111111111111111111111111111111111111111";
const URL_ = "https://paid.example.com/v1/data";
const PAY_SAFE = "https://pay-safe.test/v1/preflight";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const terms = (amount = "10000", asset = USDC) => ({ scheme: "exact", network: "eip155:8453", amount, asset, payTo: SELLER, maxTimeoutSeconds: 60 });

/** A fake network: an x402 v2 seller (402 without payment, 200 with one) plus an optional Pay Safe answer. */
function network(opts: { amount?: string; asset?: string; paidStatus?: number; verdict?: string | null } = {}) {
  const log = { paid: 0, paySafeBodies: [] as any[] };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === PAY_SAFE) {
      if (opts.verdict === null) throw new TypeError("fetch failed");
      log.paySafeBodies.push(await req.json());
      return Response.json({ verdict: opts.verdict ?? "go", summary: `test says ${opts.verdict ?? "go"}` });
    }
    if (!req.headers.get("payment-signature")) {
      const quote = { x402Version: 2, resource: { url: req.url }, accepts: [terms(opts.amount, opts.asset)] };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(quote) } });
    }
    log.paid++;
    if ((opts.paidStatus ?? 200) !== 200) return new Response("{}", { status: opts.paidStatus });
    return new Response('{"data":1}', { status: 200, headers: { "PAYMENT-RESPONSE": b64({ success: true }) } });
  }) as typeof fetch;
  return { fetchImpl, log };
}

/** What an x402 client does: ask, read the price, resend with a signed payment. */
async function pay(f: typeof fetch) {
  const first = await f(URL_);
  const accepted = JSON.parse(Buffer.from(first.headers.get("payment-required")!, "base64").toString()).accepts[0];
  return f(URL_, { headers: { "PAYMENT-SIGNATURE": b64({ x402Version: 2, accepted, payload: { signature: "0xSIGNED" } }) } });
}

test("payments are counted and the budget is never crossed", async () => {
  const { fetchImpl, log } = network();
  const seatbelt = createSeatbelt({ maxTotalUsd: 0.025 });
  const f = seatbelt.wrap(fetchImpl);
  await pay(f);
  await pay(f);
  await assert.rejects(pay(f), (e: any) => e instanceof PaymentBlockedError && e.reason === "budget");
  const r = seatbelt.report();
  assert.equal(log.paid, 2);
  assert.equal(r.payments, 2);
  assert.equal(r.spentUsd, 0.02);
  assert.equal(r.blocked, 1);
});

test("parallel payments can't overshoot the budget", async () => {
  const { fetchImpl, log } = network();
  const seatbelt = createSeatbelt({ maxTotalUsd: 0.015 });
  const f = seatbelt.wrap(fetchImpl);
  const results = await Promise.allSettled([pay(f), pay(f), pay(f)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(log.paid, 1);
});

test("maxPaymentUsd blocks before sending", async () => {
  const { fetchImpl, log } = network({ amount: "50000" });
  const f = createSeatbelt({ maxPaymentUsd: 0.01 }).wrap(fetchImpl);
  await assert.rejects(pay(f), (e: any) => e.reason === "max_payment");
  assert.equal(log.paid, 0);
});

test("unknown assets are blocked when a payment cap is set, and counted otherwise", async () => {
  const other = "0x9999999999999999999999999999999999999999";
  const a = network({ asset: other });
  await assert.rejects(pay(createSeatbelt({ maxPaymentUsd: 1 }).wrap(a.fetchImpl)), (e: any) => e.reason === "unknown_value");
  const b = network({ asset: other });
  const seatbelt = createSeatbelt();
  await pay(seatbelt.wrap(b.fetchImpl));
  assert.equal(seatbelt.report().unvaluedPayments, 1);
  assert.equal(seatbelt.report().spentUsd, 0);
});

test("failed paid calls are not counted", async () => {
  const { fetchImpl } = network({ paidStatus: 500 });
  const seatbelt = createSeatbelt({ maxTotalUsd: 1 });
  await pay(seatbelt.wrap(fetchImpl));
  const r = seatbelt.report();
  assert.equal(r.payments, 0);
  assert.equal(r.pendingUsd, 0);
  assert.ok(r.events.some((e) => e.type === "not_charged"));
});

test("x402 v1 payments are valued from the 402 body", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (!req.headers.get("x-payment")) {
      const accepts = [{ scheme: "exact", network: "base", maxAmountRequired: "20000", asset: USDC, payTo: SELLER, resource: URL_ }];
      return Response.json({ x402Version: 1, accepts }, { status: 402 });
    }
    return new Response("{}", { status: 200, headers: { "X-PAYMENT-RESPONSE": "x" } });
  }) as typeof fetch;
  const seatbelt = createSeatbelt();
  const f = seatbelt.wrap(fetchImpl);
  await f(URL_);
  const v1 = { x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x", authorization: { to: SELLER, value: "20000" } } };
  await f(URL_, { headers: { "X-PAYMENT": b64(v1) } });
  assert.equal(seatbelt.report().spentUsd, 0.02);
});

test("stop() blocks every further payment", async () => {
  const { fetchImpl } = network();
  const seatbelt = createSeatbelt();
  seatbelt.stop();
  await assert.rejects(pay(seatbelt.wrap(fetchImpl)), (e: any) => e.reason === "stopped");
});

test("Pay Safe STOP blocks the payment and only terms are sent", async () => {
  const { fetchImpl, log } = network({ verdict: "stop" });
  const seatbelt = createSeatbelt({ paySafe: true, paySafeUrl: PAY_SAFE });
  await assert.rejects(pay(seatbelt.wrap(fetchImpl)), (e: any) => e.reason === "pay_safe" && e.verdict.verdict === "stop");
  assert.equal(log.paid, 0);
  const sent = log.paySafeBodies[0];
  assert.equal(sent.url, URL_);
  assert.equal(sent.payment_required.accepts[0].payTo, SELLER);
  assert.ok(!JSON.stringify(sent).includes("SIGNED"));
});

test("Pay Safe CAUTION passes by default, is cached, and can be blocked", async () => {
  const a = network({ verdict: "caution" });
  const seatbelt = createSeatbelt({ paySafe: true, paySafeUrl: PAY_SAFE });
  const f = seatbelt.wrap(a.fetchImpl);
  await pay(f);
  await pay(f);
  assert.equal(a.log.paid, 2);
  assert.equal(a.log.paySafeBodies.length, 1);

  const b = network({ verdict: "caution" });
  await assert.rejects(pay(createSeatbelt({ paySafe: true, paySafeUrl: PAY_SAFE, paySafeBlock: "caution" }).wrap(b.fetchImpl)));
  assert.equal(b.log.paid, 0);
});

test("Pay Safe unreachable: fails open by default, closed on request", async () => {
  const a = network({ verdict: null });
  const seatbelt = createSeatbelt({ paySafe: true, paySafeUrl: PAY_SAFE });
  await pay(seatbelt.wrap(a.fetchImpl));
  assert.equal(a.log.paid, 1);
  assert.ok(seatbelt.report().events.some((e) => e.type === "pay_safe" && e.detail.includes("unavailable")));

  const b = network({ verdict: null });
  await assert.rejects(pay(createSeatbelt({ paySafe: true, paySafeUrl: PAY_SAFE, paySafeFailClosed: true }).wrap(b.fetchImpl)), (e: any) => e.reason === "pay_safe_unavailable");
  assert.equal(b.log.paid, 0);
});

test("no payment header means untouched pass-through", async () => {
  const seatbelt = createSeatbelt({ maxTotalUsd: 0 });
  const res = await seatbelt.wrap(async () => new Response("ok"))("https://example.com");
  assert.equal(await res.text(), "ok");
});

// ---- the official client: @x402/fetch + @x402/evm signing with a random key (no funds), local seller -------

async function localSeller() {
  let paid = 0;
  const server = createServer((req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    if (req.headers["payment-signature"]) {
      paid++;
      res.writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x", network: "eip155:8453" }) });
      return res.end('{"data":1}');
    }
    const accepts = [{ ...terms(), extra: { name: "USD Coin", version: "2" } }];
    res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: { url }, accepts }) });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/paid`, paid: () => paid, close: () => server.close() };
}

function officialClient(baseFetch: typeof fetch) {
  const account = privateKeyToAccount(generatePrivateKey());
  return wrapFetchWithPaymentFromConfig(baseFetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] });
}

test("official @x402/fetch client: payment counted once, cap enforced", async () => {
  const seller = await localSeller();
  try {
    const seatbelt = createSeatbelt({ maxTotalUsd: 1 });
    const res = await officialClient(seatbelt.wrap(fetch))(seller.url);
    assert.equal(res.status, 200);
    assert.equal(seller.paid(), 1);
    assert.equal(seatbelt.report().payments, 1);
    assert.equal(seatbelt.report().spentUsd, 0.01);

    const capped = createSeatbelt({ maxPaymentUsd: 0.001 });
    await assert.rejects(officialClient(capped.wrap(fetch))(seller.url), PaymentBlockedError);
    assert.equal(seller.paid(), 1);
  } finally {
    seller.close();
  }
});
