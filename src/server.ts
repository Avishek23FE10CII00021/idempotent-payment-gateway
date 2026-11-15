import express, { type Request, type Response } from "express";
import { pathToFileURL } from "node:url";
import { prisma } from "./prismaClient.js";
import { CardDeclinedError, FakeProcessor } from "./processor.js";
import { withIdempotency, type HandlerResult } from "./idempotency.js";
import { IdempotencyConflictError, InProgressError } from "./errors.js";

export function createApp(processor: FakeProcessor = new FakeProcessor()) {
  const app = express();
  app.use(express.json());

  app.post("/charges", async (req: Request, res: Response) => {
    const idempotencyKey = req.header("Idempotency-Key");
    if (!idempotencyKey) {
      return res.status(400).json({ error: "Idempotency-Key header is required" });
    }

    const { amount, currency, customerId } = req.body ?? {};
    if (!Number.isInteger(amount) || amount <= 0 || !currency || !customerId) {
      return res.status(400).json({
        error: "amount (positive integer, smallest currency unit), currency, and customerId are required",
      });
    }

    // Hash only the validated fields, in a fixed shape.
    const payload = { amount, currency, customerId };

    try {
      const result = await withIdempotency(
        prisma,
        idempotencyKey,
        payload,
        async ({ key }): Promise<HandlerResult<unknown>> => {
          try {
            // Forward the key so the processor dedupes if we re-run after a crash.
            const charge = await processor.charge(payload, key);
            // upsert, not create: this step must be safe to re-run.
            await prisma.charge.upsert({
              where: { idempotencyKey: key },
              create: {
                idempotencyKey: key,
                processorChargeId: charge.id,
                amount: charge.amount,
                currency: charge.currency,
                customerId: charge.customerId,
                status: charge.status,
              },
              update: {},
            });
            return { status: 201, body: charge };
          } catch (err) {
            // A decline is a definitive answer: store and replay it.
            if (err instanceof CardDeclinedError) {
              return { status: 402, body: { error: err.message } };
            }
            // Anything else is "unknown": rethrow, leave the key to its lease.
            throw err;
          }
        },
      );

      res.status(result.status).set("Idempotent-Replayed", String(result.replayed)).json(result.body);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return res.status(422).json({ error: err.message });
      }
      if (err instanceof InProgressError) {
        return res.status(409).set("Retry-After", "1").json({ error: err.message });
      }
      console.error(err);
      res.status(500).json({ error: "Internal error processing charge" });
    }
  });

  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  return app;
}

// Only start listening when this file is run directly (not when imported by tests).
// pathToFileURL makes the comparison work on Windows as well as Linux/macOS.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`Payment gateway listening on http://localhost:${port}`);
  });
}