// Reading x402 payments from HTTP headers.
//
// An x402 client answers "402 Payment Required" by resending the request with a signed payment in the
// PAYMENT-SIGNATURE header (x402 v2) or X-PAYMENT (v1): base64 JSON saying how much is paid, in which asset,
// on which network and to which wallet. Reading it before the request is sent lets the seatbelt stop a
// payment while it's still only a signature on this machine.

export const PAYMENT_HEADERS = ["payment-signature", "x-payment"] as const;
export const RESPONSE_HEADERS = ["payment-response", "x-payment-response"] as const;

/** USDC contract addresses (6 decimals). Payments in other assets can't be valued in dollars. */
const USDC = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // Base Sepolia
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // Ethereum
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // Polygon
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // Arbitrum
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // Optimism
  "epjfwdd5aufqssqem2qn1xzybapc8g4wegkzwytdt1v", // Solana (lowercased)
]);

/** Payment terms, in x402 v2 shape. */
export interface PaymentTerms {
  scheme?: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  [key: string]: unknown;
}

export interface Payment {
  version: number;
  network: string;
  payTo: string | null;
  asset: string | null;
  /** Amount in the asset's smallest unit. */
  rawAmount: bigint | null;
  /** Dollar value for USDC payments; null when the asset or amount is unknown. */
  usd: number | null;
  /** The terms the client accepted (v2), or rebuilt from the 402 quote (v1). */
  terms: PaymentTerms | null;
}

type HeaderSource = { get(name: string): string | null };

function decodeBase64Json(value: string): unknown {
  const text = value.trim();
  try {
    const binary = atob(text);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

function toBigInt(value: unknown): bigint | null {
  try {
    return value === undefined || value === null || value === "" ? null : BigInt(String(value));
  } catch {
    return null;
  }
}

const usdOf = (asset: string | null, raw: bigint | null) =>
  raw !== null && asset && USDC.has(asset.toLowerCase()) ? Number(raw) / 1e6 : null;

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);

export function hasPayment(headers: HeaderSource): boolean {
  return PAYMENT_HEADERS.some((h) => headers.get(h));
}

export function isSettled(headers: HeaderSource): boolean {
  return RESPONSE_HEADERS.some((h) => headers.get(h));
}

/** The payment options in a 402 answer: the PAYMENT-REQUIRED header, or (x402 v1) the JSON body. */
export function parseQuote(headers: HeaderSource, body?: unknown): Record<string, unknown>[] {
  const raw = headers.get("payment-required");
  const quote = obj(raw ? decodeBase64Json(raw) : body);
  const accepts = quote?.accepts;
  return Array.isArray(accepts) ? accepts.filter((a) => obj(a)) : [];
}

/** The payment carried by a request's headers, or null. `quotes` are the options from the 402 answer it
 * responds to (x402 v1 payments don't name their asset). */
export function parsePayment(headers: HeaderSource, quotes: Record<string, unknown>[] = []): Payment | null {
  const raw = PAYMENT_HEADERS.map((h) => headers.get(h)).find(Boolean);
  if (!raw) return null;
  const data = obj(decodeBase64Json(raw));
  if (!data) return { version: 0, network: "", payTo: null, asset: null, rawAmount: null, usd: null, terms: null };
  const auth = obj(obj(data.payload)?.authorization) ?? {};
  const accepted = obj(data.accepted);
  if (accepted) {
    const rawAmount = toBigInt(accepted.amount);
    const asset = typeof accepted.asset === "string" ? accepted.asset : null;
    return {
      version: 2,
      network: String(accepted.network ?? ""),
      payTo: (accepted.payTo as string) ?? auth.to ?? null,
      asset,
      rawAmount,
      usd: usdOf(asset, rawAmount),
      terms: accepted as PaymentTerms,
    };
  }
  // x402 v1: amount and recipient are in the signed authorization; the asset comes from the 402 quote.
  const payTo: string | null = typeof auth.to === "string" ? auth.to : null;
  const rawAmount = toBigInt(auth.value);
  const network = String(data.network ?? "");
  const match = quotes.find((q) => String(q.payTo ?? "").toLowerCase() === String(payTo ?? "").toLowerCase() && String(q.network ?? "") === network);
  const asset = match && typeof match.asset === "string" ? match.asset : null;
  const terms = match
    ? ({ ...match, network, asset: asset ?? "", payTo: payTo ?? "", amount: rawAmount !== null ? rawAmount.toString() : String(match.maxAmountRequired ?? "0") } as PaymentTerms)
    : null;
  return { version: 1, network, payTo, asset, rawAmount, usd: usdOf(asset, rawAmount), terms };
}

export function describe(p: Payment): string {
  const amount = p.usd !== null ? `$${Number(p.usd.toPrecision(6))}` : `${p.rawAmount ?? "?"} units of ${p.asset ?? "an unknown asset"}`;
  return `${amount} to ${p.payTo ?? "?"} on ${p.network || "?"}`;
}
