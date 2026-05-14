export class FeesInvalidInputError extends Error {
  public readonly code = 'FEES_INVALID_INPUT' as const;

  constructor(public readonly reason: string) {
    super(`Invalid fees input: ${reason}`);
    this.name = 'FeesInvalidInputError';
  }
}
