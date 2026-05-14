export class PaymentsInvalidInputError extends Error {
  public readonly code = 'PAYMENTS_INVALID_INPUT' as const;

  constructor(public readonly reason: string) {
    super(`Invalid payments input: ${reason}`);
    this.name = 'PaymentsInvalidInputError';
  }
}
