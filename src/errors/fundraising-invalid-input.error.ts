export class FundraisingInvalidInputError extends Error {
  public readonly code = 'FUNDRAISING_INVALID_INPUT' as const;

  constructor(public readonly reason: string) {
    super(`Invalid fundraising input: ${reason}`);
    this.name = 'FundraisingInvalidInputError';
  }
}
