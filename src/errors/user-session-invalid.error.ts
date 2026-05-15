export class UserSessionInvalidError extends Error {
  public readonly code = 'USER_SESSION_INVALID' as const;

  constructor(public readonly reason: string) {
    super(`User session invalid: ${reason}`);
    this.name = 'UserSessionInvalidError';
  }
}
