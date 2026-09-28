// The seatbelt: wraps fetch, and checks every x402 payment before it leaves this machine.
import { describe, hasPayment, isSettled, parsePayment, parseQuote, type Payment } from "./payment.js";

export const PAY_SAFE_URL = "https://agent-deals.gm-tools.workers.dev/v1/preflight";
const PAY_SAFE_CACHE_MS = 60_000; // the same payment to the same service isn't re-checked within a minute
const MAX_EVENTS = 200;

export interface SeatbeltOptions {
  /** Total budget for all payments made through this seatbelt (USDC). A payment that would cross it is never sent. */
  maxTotalUsd?: number;
  /** Block any single payment above this (USDC). Payments in other assets are blocked too, since their value is unknown. */
  maxPaymentUsd?: number;
  /** Block payments after this many. */
  maxPayments?: number;
  /**
   * Before each payment is sent, ask the Pay Safe service whether it looks safe: is the service working, is the
   * price fair, is the wallet safe and the one the service normally uses. Sends the service URL and the payment
   * terms (amount, asset, network, pay-to wallet), never the signature or any key. Off by default.
   */
  paySafe?: boolean;
  /** "stop" (default) blocks payments Pay Safe rates STOP; "caution" also blocks CAUTION. */
  paySafeBlock?: "stop" | "caution";
  /** Block payments when Pay Safe can't be reached (default: let them through). */
  paySafeFailClosed?: boolean;
  paySafeUrl?: string;
  paySafeTimeoutMs?: number;
  /** Called for every event (payments, blocks, Pay Safe answers). */
  onEvent?: (event: SeatbeltEvent) => void;
}

export type BlockReason = "max_payment" | "budget" | "max_payments" | "unknown_value" | "pay_safe" | "pay_safe_unavailable" | "stopped";

export interface PaySafeVerdict {
  verdict: "go" | "caution" | "stop";
  summary?: string;
  findings?: { level: string; code: string; message: string }[];
  [key: string]: unknown;
}

export interface SeatbeltEvent {
  time: number;
  type: "payment" | "not_charged" | "blocked" | "pay_safe" | "quote";
  detail: string;
  url?: string;
  payment?: Payment;
}

export interface SeatbeltReport {
  /** Payments that went through. */
  payments: number;
  /** Their USDC value. */
  spentUsd: number;
  /** Payments sent and still waiting for an answer. */
  pendingUsd: number;
  /** Payments stopped before they were sent. */
  blocked: number;
  /** Payments in assets other than USDC (not counted in spentUsd). */
  unvaluedPayments: number;
  paySafeChecks: number;
  stopped: boolean;
  events: SeatbeltEvent[];
}

/** A payment was stopped before it was sent: nothing was paid, the signed payment never left this machine. */
export class PaymentBlockedError extends Error {
  readonly reason: BlockReason;
  readonly payment: Payment;
  readonly verdict?: PaySafeVerdict;

  constructor(reason: BlockReason, message: string, payment: Payment, verdict?: PaySafeVerdict) {
    super(message);
    this.name = "PaymentBlockedError";
    this.reason = reason;
    this.payment = payment;
    this.verdict = verdict;
  }
}

type Fetch = typeof fetch;

function requestParts(input: RequestInfo | URL, init?: RequestInit) {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = isRequest ? (input as Request).url : input instanceof URL ? input.href : String(input);
  const method = (init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
  return { url, method, headers };
}

export class Seatbelt {
  private readonly options: SeatbeltOptions;
  private spent = 0;
  private pending = 0;
  private stats = { payments: 0, blocked: 0, unvaluedPayments: 0, paySafeChecks: 0 };
  private stopped = false;
  private events: SeatbeltEvent[] = [];
  private quotes = new Map<string, Record<string, unknown>[]>();
  private paySafeAnswers = new Map<string, { at: number; answer: PaySafeVerdict }>();

  constructor(options: SeatbeltOptions = {}) {
    if (options.paySafeBlock && !["stop", "caution"].includes(options.paySafeBlock)) {
      throw new Error('paySafeBlock must be "stop" or "caution"');
    }
    this.options = options;
  }

  /**
   * A fetch that checks every x402 payment before sending it. Pass it to your x402 client:
   *
   *     const fetchWithPayment = wrapFetchWithPayment(seatbelt.wrap(fetch), client);
   */
  wrap(baseFetch: Fetch = globalThis.fetch): Fetch {
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const { url, method, headers } = requestParts(input, init);
      const payment = hasPayment(headers) ? await this.checkPayment(url, method, headers, baseFetch) : null;
      let response: Response;
      try {
        response = await baseFetch(input, init);
      } catch (error) {
        if (payment) this.release(payment, url, "the request failed");
        throw error;
      }
      await this.recordResponse(url, response, payment);
      return response;
    };
    return wrapped as Fetch;
  }

  /** Stop every further payment (an emergency stop). */
  stop(): void {
    this.stopped = true;
  }

  report(): SeatbeltReport {
    return {
      ...this.stats,
      spentUsd: Math.round(this.spent * 1e6) / 1e6,
      pendingUsd: Math.round(this.pending * 1e6) / 1e6,
      stopped: this.stopped,
      events: [...this.events],
    };
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private event(type: SeatbeltEvent["type"], detail: string, url?: string, payment?: Payment) {
    const ev: SeatbeltEvent = { time: Date.now(), type, detail, url, payment };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    try {
      this.options.onEvent?.(ev);
    } catch {
      // a broken callback must not break payments
    }
  }

  private block(reason: BlockReason, why: string, payment: Payment, url: string, verdict?: PaySafeVerdict): never {
    this.stats.blocked++;
    const message = `x402-seatbelt blocked a payment of ${describe(payment)}: ${why}`;
    this.event("blocked", message, url, payment);
    throw new PaymentBlockedError(reason, message, payment, verdict);
  }

  /** Limits, then (optionally) Pay Safe. Reserves the amount so parallel payments can't overshoot the budget. */
  private async checkPayment(url: string, method: string, headers: Headers, baseFetch: Fetch): Promise<Payment | null> {
    const o = this.options;
    const payment = parsePayment(headers, this.quotes.get(url));
    if (!payment) return null;
    this.checkLimits(payment, url);
    if (payment.usd !== null) this.pending += payment.usd; // reserve now: the checks below may wait on the network
    try {
      if (o.paySafe) await this.paySafe(url, method, payment, baseFetch);
      this.checkLimits(payment, url, payment.usd ?? 0); // again: other payments may have gone through meanwhile
    } catch (error) {
      if (payment.usd !== null) this.pending -= payment.usd;
      throw error;
    }
    return payment;
  }

  private checkLimits(payment: Payment, url: string, reservedByThis = 0) {
    const o = this.options;
    if (this.stopped) this.block("stopped", "the seatbelt was stopped", payment, url);
    if (o.maxPayments !== undefined && this.stats.payments >= o.maxPayments) {
      this.block("max_payments", `maximum of ${o.maxPayments} payments reached`, payment, url);
    }
    if (o.maxPaymentUsd !== undefined) {
      if (payment.usd === null) this.block("unknown_value", "its dollar value is unknown (not USDC), so maxPaymentUsd can't be applied", payment, url);
      if (payment.usd > o.maxPaymentUsd) this.block("max_payment", `above maxPaymentUsd ($${o.maxPaymentUsd})`, payment, url);
    }
    if (o.maxTotalUsd !== undefined && payment.usd !== null) {
      const committed = this.spent + this.pending - reservedByThis;
      if (committed + payment.usd > o.maxTotalUsd + 1e-12) {
        this.block("budget", `it would exceed maxTotalUsd ($${o.maxTotalUsd}; $${committed.toFixed(6)} already committed)`, payment, url);
      }
    }
  }

  private async paySafe(url: string, method: string, payment: Payment, baseFetch: Fetch) {
    const o = this.options;
    const key = [url, payment.payTo?.toLowerCase(), payment.rawAmount?.toString(), payment.asset?.toLowerCase()].join("|");
    const cached = this.paySafeAnswers.get(key);
    let answer: PaySafeVerdict;
    if (cached && Date.now() - cached.at < PAY_SAFE_CACHE_MS) {
      answer = cached.answer;
    } else {
      const terms = payment.terms ?? {
        scheme: "exact",
        network: payment.network,
        amount: (payment.rawAmount ?? 0n).toString(),
        asset: payment.asset ?? "",
        payTo: payment.payTo ?? "",
      };
      try {
        const res = await baseFetch(o.paySafeUrl ?? PAY_SAFE_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "x402-seatbelt" },
          body: JSON.stringify({ url, method, payment_required: { x402Version: 2, resource: { url }, accepts: [terms] } }),
          signal: AbortSignal.timeout(o.paySafeTimeoutMs ?? 8000),
        });
        const body = (await res.json()) as PaySafeVerdict;
        if (!res.ok || !["go", "caution", "stop"].includes(body?.verdict)) throw new Error(`unexpected answer (HTTP ${res.status})`);
        answer = body;
        this.paySafeAnswers.set(key, { at: Date.now(), answer });
      } catch (error) {
        this.event("pay_safe", `check unavailable (${(error as Error).message}) for ${describe(payment)}`, url, payment);
        if (o.paySafeFailClosed) this.block("pay_safe_unavailable", "Pay Safe couldn't be reached (paySafeFailClosed)", payment, url);
        return;
      }
    }
    this.stats.paySafeChecks++;
    this.event("pay_safe", `${answer.verdict.toUpperCase()} for ${describe(payment)}: ${answer.summary ?? ""}`, url, payment);
    if (answer.verdict === "stop" || (answer.verdict === "caution" && o.paySafeBlock === "caution")) {
      this.block("pay_safe", `Pay Safe says ${answer.verdict.toUpperCase()}: ${answer.summary ?? ""}`, payment, url, answer);
    }
  }

  private release(payment: Payment, url: string, why: string) {
    if (payment.usd !== null) this.pending -= payment.usd;
    this.event("not_charged", `not charged (${why}): ${describe(payment)}`, url, payment);
  }

  private async recordResponse(url: string, response: Response, payment: Payment | null) {
    if (response.status === 402) {
      let body: unknown;
      if (!response.headers.get("payment-required")) {
        try {
          body = await response.clone().json(); // x402 v1: options in the JSON body
        } catch {
          body = undefined;
        }
      }
      const quotes = parseQuote(response.headers, body);
      if (quotes.length) this.quotes.set(url, quotes);
    }
    if (!payment) return;
    if (!(isSettled(response.headers) || response.ok)) {
      this.release(payment, url, `HTTP ${response.status}`);
      return;
    }
    this.stats.payments++;
    if (payment.usd === null) {
      this.stats.unvaluedPayments++;
      this.event("payment", `paid ${describe(payment)} (not valued in USD)`, url, payment);
      return;
    }
    this.pending -= payment.usd;
    this.spent += payment.usd;
    this.event("payment", `paid ${describe(payment)} (total $${this.spent.toFixed(6)})`, url, payment);
  }
}

/** Create a seatbelt. `seatbelt.wrap(fetch)` gives a fetch that checks every x402 payment before it's sent. */
export function createSeatbelt(options: SeatbeltOptions = {}): Seatbelt {
  return new Seatbelt(options);
}
