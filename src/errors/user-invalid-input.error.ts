export class UserInvalidInputError extends Error {
  public readonly code = 'USER_INVALID_INPUT' as const;

  constructor(public readonly reason: string) {
    super(`Invalid user input: ${reason}`);
    this.name = 'UserInvalidInputError';
  }
}
