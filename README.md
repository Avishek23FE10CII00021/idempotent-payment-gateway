# Idempotent Payment Gateway

A `POST /charges` endpoint that is safe to retry. Send the same request twice, or ten times at once, and exactly one charge happens. Every caller gets the same response content back.

This is the pattern real payment APIs (Stripe, Razorpay) use. A naive charge endpoint double-charges a customer the moment a client times out and retries.

## Behavior

Every request needs an `Idempotency-Key` header.

| Situation                                          | Result                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| First request with a key                           | Charges, returns `201`, `Idempotent-Replayed: false`                                  |
| Retry, same key + same payload                     | Replays the stored response, `Idempotent-Replayed: true`, no new charge               |
| Same key, different payload                        | `422`                                                                                 |
| Card declined                                      | Stored and replayed as `402` (a decline is a definitive answer)                       |
| Duplicate arrives while the first is still running | Waits up to 2 s, then `409` with `Retry-After`                                        |
| Server crashes or errors mid-request               | Key stays `processing`; after the 30 s lease a retry takes over and finishes the work |

Payload comparison is order-insensitive: `{"a":1,"b":2}` and `{"b":2,"a":1}` count as the same request.

## How it works

Safety comes from two atomic database operations, not from an in-process lock (which would only protect a single server instance):

1. **Claim.** The server inserts a row for the key. `IdempotencyKey.key` is unique, so when many requests race, exactly one insert succeeds. The winner does the work; the rest wait and replay its result.
2. **Takeover.** Each claim carries a 30 s lease (`lockedUntil`). If the owner dies, the row stays `processing`. After the lease expires, one request wins an `UPDATE ... WHERE lockedUntil < now()` and re-runs the work. Postgres lets exactly one concurrent caller see `count === 1`.

Re-running is only safe because **every step of the handler can be repeated**:

- the idempotency key is forwarded to the processor, which dedupes on it (as Stripe and Razorpay do), so a re-run returns the original charge instead of charging again;
- the `Charge` row is written with `upsert`, not `create`;
- completing the key is a plain update.

An unknown error (timeout, DB failure) never marks the key as failed, because we don't know whether the money moved. Only the lease decides when it is safe to retry.

The slow processor call happens outside any DB transaction, so a hung processor cannot hold a database connection.

## Guarantees and limits

**Guaranteed** (as long as the processor dedupes on the idempotency key):

- A key never results in more than one real charge, including under concurrent duplicates and after a crash between the processor call and the database write.

**Not covered**

- No authentication or tenant scoping: keys are global.
- No key expiry or cleanup.
- If a handler outlasts the 30 s lease, two runs can overlap. This is safe only because of processor-side dedupe.
- A processor that does not support idempotency keys would need reconciliation (periodically listing its charges and matching them to ours). Not implemented.
- The processor here is a fake with simulated latency and fault injection.
- Replayed bodies have the same content but not necessarily the same key order (stored as `JSONB`).

## Setup

Requires Node 20+ and PostgreSQL.

```bash
npm install
cp .env.example .env          # set DATABASE_URL (URL-encode special characters in the password)
npx prisma migrate deploy
npm run dev
```

PostgreSQL via Docker: `docker compose up -d`. Or use any local Postgres and create a `payment_gateway` database.

## Tests

```bash
npm test
```

13 tests against a real Postgres database (this race condition only reproduces against real DB constraints), including:

- 20 concurrent calls with one key run the handler exactly once
- 10 concurrent HTTP requests produce exactly one charge
- a crash after the processor charged is recovered by a later request with no double charge (fault-injected)
- exactly one request wins a takeover of an expired lease under concurrency
- declines are replayed instead of retried
- non-integer amounts are rejected; reordered JSON keys replay

## Project layout

```
src/
  server.ts        Express app + POST /charges
  idempotency.ts   withIdempotency(): claim, lease, takeover (framework-agnostic)
  processor.ts     FakeProcessor: dedupes on key, simulated latency, fault injection
  errors.ts        IdempotencyConflictError, InProgressError
  prismaClient.ts  Prisma client singleton
prisma/schema.prisma   IdempotencyKey (with lease) + Charge
tests/                 mechanism tests + HTTP-level tests
```
