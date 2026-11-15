import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { IdempotencyConflictError, InProgressError } from "./errors.js";

const LEASE_MS = 30_000; // how long one request owns a key before others may take over
const MAX_WAIT_MS = 2_000; // how long a duplicate waits before answering 409
const POLL_MS = 25;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HandlerResult<T> {
  status: number;
  body: T;
}

export interface IdempotentResult<T> extends HandlerResult<T> {
  replayed: boolean;
}

/**
 * Runs `handler` for a given idempotency key such that the real-world effect
 * happens once.
 *
 * Safety comes from two atomic database operations:
 *   1. INSERT of the key row (unique constraint): one concurrent caller wins.
 *   2. UPDATE ... WHERE lockedUntil < now: one concurrent caller wins a takeover.
 *
 * If the owner crashes or throws, the row stays "processing" and its lease
 * eventually expires. A later request then takes over and re-runs the handler.
 * That is only safe because the handler itself is re-runnable: the processor
 * dedupes on the key and the Charge row is upserted. Never mark a key "failed"
 * on an unknown error: you don't know whether the money moved.
 */
export async function withIdempotency<T>(
  prisma: PrismaClient,
  key: string,
  requestPayload: unknown,
  handler: (ctx: { key: string }) => Promise<HandlerResult<T>>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashPayload(requestPayload);
  const lease = () => new Date(Date.now() + LEASE_MS);

  const run = async (): Promise<IdempotentResult<T>> => {
    const result = await handler({ key });
    await prisma.idempotencyKey.update({
      where: { key },
      data: {
        status: "completed",
        responseStatus: result.status,
        responseBody: result.body as Prisma.InputJsonValue,
        lockedUntil: null,
      },
    });
    return { ...result, replayed: false };
  };

  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const row = await prisma.idempotencyKey.findUnique({ where: { key } });

    if (!row) {
      // Try to claim the key. Exactly one concurrent caller succeeds.
      let claimed = false;
      try {
        await prisma.idempotencyKey.create({
          data: { key, requestHash, status: "processing", lockedUntil: lease() },
        });
        claimed = true;
      } catch (err) {
        if (!isUniqueConstraintViolation(err)) throw err;
      }
      if (claimed) return run();
      continue; // lost the race; loop and look at the winner's row
    }

    if (row.requestHash !== requestHash) {
      throw new IdempotencyConflictError(key);
    }

    if (row.status === "completed") {
      return {
        status: row.responseStatus!,
        body: row.responseBody as T,
        replayed: true,
      };
    }

    // status === "processing": take over if the owner's lease has expired.
    const { count } = await prisma.idempotencyKey.updateMany({
      where: { key, status: "processing", lockedUntil: { lt: new Date() } },
      data: { lockedUntil: lease() },
    });
    if (count === 1) return run();

    // Lease is still alive: someone else is working. Wait briefly.
    await sleep(POLL_MS);
  }

  throw new InProgressError(key);
}