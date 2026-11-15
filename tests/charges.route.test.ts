import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/prismaClient.js";
import { createApp } from "../src/server.js";
import { FakeProcessor } from "../src/processor.js";

beforeEach(async () => {
  await prisma.charge.deleteMany();
  await prisma.idempotencyKey.deleteMany();
});

const post = (app: ReturnType<typeof createApp>, key: string, body: object) =>
  request(app).post("/charges").set("Idempotency-Key", key).send(body);

describe("POST /charges", () => {
  it("requires an Idempotency-Key header", async () => {
    const res = await request(createApp()).post("/charges").send({ amount: 500, currency: "usd", customerId: "cus_1" });
    expect(res.status).toBe(400);
  });

  it("rejects negative and non-integer amounts", async () => {
    const app = createApp();
    expect((await post(app, "k1", { amount: -5, currency: "usd", customerId: "cus_1" })).status).toBe(400);
    expect((await post(app, "k2", { amount: 10.5, currency: "usd", customerId: "cus_1" })).status).toBe(400);
  });

  it("charges once and replays the same response on retry", async () => {
    const processor = new FakeProcessor();
    const app = createApp(processor);
    const payload = { amount: 1500, currency: "usd", customerId: "cus_42" };

    const first = await post(app, "k-route-1", payload);
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBe("false");

    const second = await post(app, "k-route-1", payload);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);

    expect(processor.callCount).toBe(1);
    expect(await prisma.charge.count({ where: { idempotencyKey: "k-route-1" } })).toBe(1);
  });

  it("rejects the same key reused with a different payload", async () => {
    const app = createApp();
    await post(app, "k-conflict", { amount: 1000, currency: "usd", customerId: "cus_1" });
    const res = await post(app, "k-conflict", { amount: 2000, currency: "usd", customerId: "cus_1" });
    expect(res.status).toBe(422);
  });

  it("charges exactly once under real concurrent duplicate requests", async () => {
    const processor = new FakeProcessor();
    const app = createApp(processor);
    const payload = { amount: 750, currency: "usd", customerId: "cus_race" };

    const responses = await Promise.all(Array.from({ length: 10 }, () => post(app, "k-race", payload)));

    expect(processor.uniqueCharges).toBe(1);
    for (const res of responses) {
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(responses[0].body.id);
    }
    expect(await prisma.charge.count({ where: { idempotencyKey: "k-race" } })).toBe(1);
  });

  it("replays a card decline instead of retrying it", async () => {
    const processor = new FakeProcessor();
    const app = createApp(processor);
    const payload = { amount: 500, currency: "usd", customerId: "cus_declined" };

    const first = await post(app, "k-decline", payload);
    const second = await post(app, "k-decline", payload);

    expect(first.status).toBe(402);
    expect(second.status).toBe(402);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(processor.callCount).toBe(1);
  });

  it("recovers from a crash AFTER the processor charged, without double-charging", async () => {
    const processor = new FakeProcessor();
    processor.failAfterChargeOnce = true; // money moves, response is lost
    const app = createApp(processor);
    const payload = { amount: 500, currency: "usd", customerId: "cus_1" };

    const first = await post(app, "k-crash", payload);
    expect(first.status).toBe(500);
    expect(processor.uniqueCharges).toBe(1);

    // Simulate the lease expiring instead of waiting 30s.
    await prisma.idempotencyKey.update({ where: { key: "k-crash" }, data: { lockedUntil: new Date(0) } });

    const second = await post(app, "k-crash", payload);
    expect(second.status).toBe(201);
    expect(processor.uniqueCharges).toBe(1); // still exactly one real charge
    expect(await prisma.charge.count({ where: { idempotencyKey: "k-crash" } })).toBe(1);
  });
});