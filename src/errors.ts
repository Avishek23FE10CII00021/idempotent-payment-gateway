

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency-Key "${key}" was already used with a different request payload`);
    this.name = "IdempotencyConflictError";
  }
}

export class InProgressError extends Error {
  constructor(key: string) {
    super(`A request with Idempotency-Key "${key}" is still being processed`);
    this.name = "InProgressError";
  }
}
