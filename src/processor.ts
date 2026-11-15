import { randomUUID } from "node:crypto";

/**
 * Stands in for a real processor (Stripe, Razorpay). Like the real ones, it
 * dedupes on the idempotency key it is given, so re-running a charge after a
 * crash returns the ORIGINAL charge instead of charging again.
 */

export interface ChargeInput {
  amount: number;
  currency: string;
  customerId: string;
}

export interface ChargeResult {
  id: string;
  amount: number;
  currency: string;
  customerId: string;
  status: "succeeded";
}

export class CardDeclinedError extends Error {
  constructor(message = "Card declined") {
    super(message);
    this.name = "CardDeclinedError";
  }
}

const LATENCY_MS = 80;

export class FakeProcessor {
  callCount = 0; // every call, including deduped ones
  uniqueCharges = 0; // charges that actually moved money
  failAfterChargeOnce = false; // fault injection: money moves, response is lost

  private byKey = new Map<string, ChargeResult>();

  async charge(input: ChargeInput, idempotencyKey: string): Promise<ChargeResult> {
    this.callCount += 1;

    const existing = this.byKey.get(idempotencyKey);
    if (existing) return existing;

    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));

    if (input.customerId === "cus_declined") {
      throw new CardDeclinedError();
    }

    const result: ChargeResult = {
      id: `ch_${randomUUID()}`,
      amount: input.amount,
      currency: input.currency,
      customerId: input.customerId,
      status: "succeeded",
    };
    this.byKey.set(idempotencyKey, result);
    this.uniqueCharges += 1;

    if (this.failAfterChargeOnce) {
      this.failAfterChargeOnce = false;
      throw new Error("network timeout after charge");
    }

    return result;
  }
}
