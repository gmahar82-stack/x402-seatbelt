// The seatbelt: wraps fetch, and checks every x402 payment before it leaves this machine.
import { describe, isSettled, parsePayment, parseQuote, paymentHeader, type Payment } from "./payment.js";

export const PAY_SAFE_URL = "https://agent-deals.gm-tools.workers.dev/v1/preflight";
const PAY_SAFE_CACHE_MS = 60_000; // the same payment to the same service isn't re-checked within a minute
const MAX_EVENTS = 200;
/** Gateway errors: the seller's server may have settled the payment before the answer was lost. */
const LOST_ANSWER_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

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
  /**
   * When a signed payment gets no answer (network error, timeout, or a 502/503/504/52x gateway error) the seller
   * may still have settled it. The seatbelt then resends the SAME signed payment, which can be settled at most
   * once, up to this many times (default 2). It never signs a new one.
   */
  lostAnswerRetries?: number;
  /** Wait before each resend, multiplied by the attempt number (default 1000 ms). */
  lostAnswerRetryDelayMs?: number;
  /**
   * While a payment is unconfirmed, block a NEW signed payment for the same request (default true): it could pay
   * twice. Resending the same signed payment is always allowed. Clear it with `seatbelt.resolveUnconfirmed()`.
   */
  blockNewPaymentWhileUnconfirmed?: boolean;
  /** Called for every event (payments, blocks, Pay Safe answers). */
  onEvent?: (event: SeatbeltEvent) => void;
}

export type BlockReason =
  | "max_payment"
  | "budget"
  | "max_payments"
  | "unknown_value"
  | "pay_safe"
  | "pay_safe_unavailable"
  | "stopped"
  | "unconfirmed_payment";

export interface PaySafeVerdict {
  verdict: "go" | "caution" | "stop";
  summary?: string;
  findings?: { level: string; code: string; message: string }[];
  [key: string]: unknown;
}

export interface SeatbeltEvent {
  time: number;
  type: "payment" | "not_charged" | "blocked" | "pay_safe" | "quote" | "resend" | "unconfirmed";
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
  /** Payments whose answer was lost: they may or may not have been charged, so they count against the budget. */
  unconfirmedUsd: number;
  unconfirmed: UnconfirmedPayment[];
  /** Payments stopped before they were sent. */
  blocked: number;
  /** Payments in assets other than USDC (not counted in spentUsd). */
  unvaluedPayments: number;
  paySafeChecks: number;
  stopped: boolean;
  events: SeatbeltEvent[];
}

export interface UnconfirmedPayment {
  url: string;
  method: string;
  payment: Payment;
  /** When the answer was lost (ms since epoch). */
  since: number;
  why: string;
}

/**
 * A payment was stopped before it was sent: nothing was paid, the signed payment never left this machine.
 * One exception: reason "stopped" can also refuse a resend of an unconfirmed payment, which may already be charged.
 */
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
  return { url, method, headers, isRequest };
}

type Sent = { key: string; method: string; signature: string; resend: boolean; answerLost: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Seatbelt {
  private readonly options: SeatbeltOptions;
  private spent = 0;
  private pending = 0;
  private stats = { payments: 0, blocked: 0, unvaluedPayments: 0, paySafeChecks: 0 };
  private stopped = false;
  private events: SeatbeltEvent[] = [];
  private quotes = new Map<string, Record<string, unknown>[]>();
  private paySafeAnswers = new Map<string, { at: number; answer: PaySafeVerdict }>();
  /** Payments whose answer was lost, by the signed payment exactly as it was sent. */
  private lost = new Map<string, UnconfirmedPayment & { key: string }>();
  private unconfirmedTotal = 0;

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
      const { url, method, headers, isRequest } = requestParts(input, init);
      const key = `${method} ${url}`;
      const signature = paymentHeader(headers);
      if (!signature) {
        const response = await baseFetch(input, init);
        await this.recordResponse(url, response, null);
        return response;
      }
      // The same signed payment sent again (after a lost answer) is already counted: it can't be charged twice.
      const earlier = this.lost.get(signature);
      const resend = earlier?.key === key;
      if (resend && this.stopped) {
        this.block("stopped", "the seatbelt was stopped. This payment was already sent once and stays unconfirmed, so check your wallet", earlier!.payment, url);
      }
      const payment = resend ? earlier!.payment : await this.checkPayment(url, method, headers, baseFetch, key);
      if (!payment) {
        const response = await baseFetch(input, init);
        await this.recordResponse(url, response, null);
        return response;
      }

      // A body that can be read only once (a stream) can't be resent, so a lost answer isn't retried then.
      const template = isRequest ? (input as Request).clone() : null;
      const canResend = !(typeof ReadableStream !== "undefined" && init?.body instanceof ReadableStream);
      const signal = init?.signal ?? (isRequest ? (input as Request).signal : undefined);
      const retries = canResend ? Math.max(0, this.options.lostAnswerRetries ?? 2) : 0;
      const delay = this.options.lostAnswerRetryDelayMs ?? 1000;
      let answerLost = resend;

      for (let attempt = 0; ; attempt++) {
        let response: Response | undefined;
        let error: unknown;
        try {
          response = await baseFetch(attempt === 0 || !template ? input : template.clone(), init);
        } catch (e) {
          error = e;
        }
        const lostNow = response === undefined || (LOST_ANSWER_STATUSES.has(response.status) && !isSettled(response.headers));
        if (lostNow && attempt < retries && !signal?.aborted && !this.stopped) {
          answerLost = true;
          const why = response ? `HTTP ${response.status}` : `no answer (${(error as Error)?.message ?? error})`;
          this.event("resend", `${why}; resending the same signed payment (${attempt + 1}/${retries}): ${describe(payment)}`, url, payment);
          await sleep(delay * (attempt + 1));
          // stop() may have come during the wait: then nothing more leaves, and the payment stays unconfirmed below.
          if (!this.stopped) {
            await response?.body?.cancel();
            continue;
          }
        }
        const sent = { key, method, signature, resend, answerLost };
        if (lostNow) {
          this.markUnconfirmed(url, payment, sent, response ? `HTTP ${response.status}` : "no answer");
          if (response === undefined) throw error;
          return response;
        }
        await this.recordResponse(url, response!, payment, sent);
        return response!;
      }
    };
    return wrapped as Fetch;
  }

  /**
   * Settle an unconfirmed payment by hand, once you know (e.g. from your wallet or a block explorer) whether it was
   * charged. `charged: true` counts it as spent; false gives the amount back to the budget. Returns false if no
   * unconfirmed payment matches.
   */
  resolveUnconfirmed(url: string, charged: boolean, method = "GET"): boolean {
    const key = `${method.toUpperCase()} ${url}`;
    const found = [...this.lost].find(([, e]) => e.key === key);
    if (!found) return false;
    const [signature, entry] = found;
    this.lost.delete(signature);
    if (entry.payment.usd !== null) this.unconfirmedTotal -= entry.payment.usd;
    if (charged) this.countPaid(entry.payment, url, " (confirmed by hand)");
    else this.event("not_charged", `not charged (confirmed by hand): ${describe(entry.payment)}`, url, entry.payment);
    return true;
  }

  /** Stop every payment that hasn't left yet, and any further resend (an emergency stop). Can't recall one already sent. */
  stop(): void {
    this.stopped = true;
  }

  report(): SeatbeltReport {
    return {
      ...this.stats,
      spentUsd: Math.round(this.spent * 1e6) / 1e6,
      pendingUsd: Math.round(this.pending * 1e6) / 1e6,
      unconfirmedUsd: Math.round(this.unconfirmedTotal * 1e6) / 1e6,
      unconfirmed: [...this.lost.values()].map(({ key: _key, ...e }) => e),
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
  private async checkPayment(url: string, method: string, headers: Headers, baseFetch: Fetch, key: string): Promise<Payment | null> {
    const o = this.options;
    const payment = parsePayment(headers, this.quotes.get(url));
    if (!payment) return null;
    if (o.blockNewPaymentWhileUnconfirmed !== false && [...this.lost.values()].some((e) => e.key === key)) {
      this.block(
        "unconfirmed_payment",
        "an earlier payment for this request got no answer and may already have been charged. Resend that same " +
          "signed payment, or call seatbelt.resolveUnconfirmed() once you know whether it was charged",
        payment,
        url,
      );
    }
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
      const committed = this.spent + this.pending + this.unconfirmedTotal - reservedByThis;
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

  /** A payment that got no answer: it may have been charged, so it keeps counting against the budget. */
  private markUnconfirmed(url: string, payment: Payment, sent: Sent, why: string) {
    if (!sent.resend) {
      if (payment.usd !== null) {
        this.pending -= payment.usd;
        this.unconfirmedTotal += payment.usd;
      }
      this.lost.set(sent.signature, { key: sent.key, url, method: sent.method, payment, since: Date.now(), why });
    }
    this.event(
      "unconfirmed",
      `${why}: ${describe(payment)} may or may not have been charged. It still counts against the budget; resend the ` +
        "same signed payment or call resolveUnconfirmed()",
      url,
      payment,
    );
  }

  private countPaid(payment: Payment, url: string, note = "") {
    this.stats.payments++;
    if (payment.usd === null) {
      this.stats.unvaluedPayments++;
      this.event("payment", `paid ${describe(payment)} (not valued in USD)${note}`, url, payment);
      return;
    }
    this.spent += payment.usd;
    this.event("payment", `paid ${describe(payment)} (total $${this.spent.toFixed(6)})${note}`, url, payment);
  }

  private async recordResponse(url: string, response: Response, payment: Payment | null, sent?: Sent) {
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
      // After a lost answer, a refusal (often "already used") doesn't prove the first send wasn't charged.
      if (sent?.answerLost) this.markUnconfirmed(url, payment, sent, `HTTP ${response.status} after a lost answer`);
      else this.release(payment, url, `HTTP ${response.status}`);
      return;
    }
    if (sent?.resend) {
      this.lost.delete(sent.signature);
      if (payment.usd !== null) this.unconfirmedTotal -= payment.usd;
    } else if (payment.usd !== null) {
      this.pending -= payment.usd;
    }
    this.countPaid(payment, url, sent?.answerLost ? " (after resending the same signed payment)" : "");
  }
}

/** Create a seatbelt. `seatbelt.wrap(fetch)` gives a fetch that checks every x402 payment before it's sent. */
export function createSeatbelt(options: SeatbeltOptions = {}): Seatbelt {
  return new Seatbelt(options);
}
