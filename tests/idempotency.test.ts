import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/prismaClient.js";
import { withIdempotency } from "../src/idempotency.js";
import { IdempotencyConflictError } from "../src/errors.js";

beforeEach(async () => {
  await prisma.charge.deleteMany();
  await prisma.idempotencyKey.deleteMany();
});

const expireLease = (key: string) =>
  prisma.idempotencyKey.update({ where: { key }, data: { lockedUntil: new Date(0) } });

describe("withIdempotency", () => {
  it("runs the handler exactly once, even under real concurrency", async () => {
    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { status: 201, body: { chargedAt: Date.now() } };
    };

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => withIdempotency(prisma, "key-concurrent", { amount: 500 }, handler)),
    );

    expect(callCount).toBe(1);
    const [first, ...rest] = results;
    for (const r of rest) expect(r.body).toEqual(first.body);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(N - 1);
    expect(await prisma.idempotencyKey.count({ where: { key: "key-concurrent" } })).toBe(1);
  });

  it("replays the stored response on a sequential retry", async () => {
    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      return { status: 201, body: { id: "charge-1" } };
    };

    const first = await withIdempotency(prisma, "key-retry", { amount: 100 }, handler);
    const second = await withIdempotency(prisma, "key-retry", { amount: 100 }, handler);

    expect(callCount).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
  });

  it("rejects reuse of the same key with a different payload", async () => {
    const handler = async () => ({ status: 201, body: { id: "charge-1" } });
    await withIdempotency(prisma, "key-reused", { amount: 100 }, handler);

    await expect(
      withIdempotency(prisma, "key-reused", { amount: 999 }, handler),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("treats reordered JSON keys as the same payload", async () => {
    const handler = async () => ({ status: 201, body: { id: "c" } });
    await withIdempotency(prisma, "key-order", { a: 1, b: 2 }, handler);
    const second = await withIdempotency(prisma, "key-order", { b: 2, a: 1 }, handler);
    expect(second.replayed).toBe(true);
  });

  it("leaves the key 'processing' when the handler throws, and a later request takes over", async () => {
    const failing = async (): Promise<never> => {
      throw new Error("network timeout");
    };
    await expect(withIdempotency(prisma, "key-crash", { amount: 100 }, failing)).rejects.toThrow("network timeout");

    const row = await prisma.idempotencyKey.findUnique({ where: { key: "key-crash" } });
    expect(row?.status).toBe("processing"); // NOT "failed"

    await expireLease("key-crash");

    const ok = await withIdempotency(prisma, "key-crash", { amount: 100 }, async () => ({
      status: 201,
      body: { id: "charge-ok" },
    }));
    expect(ok.replayed).toBe(false);
    expect(ok.body).toEqual({ id: "charge-ok" });
  });

  it("lets exactly one request take over an expired lease under concurrency", async () => {
    await expect(
      withIdempotency(prisma, "key-takeover", { amount: 1 }, async (): Promise<never> => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    await expireLease("key-takeover");

    let runs = 0;
    const handler = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { status: 201, body: { id: "x" } };
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => withIdempotency(prisma, "key-takeover", { amount: 1 }, handler)),
    );

    expect(runs).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});