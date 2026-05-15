export class UserForbiddenError extends Error {
  public readonly code = 'USER_FORBIDDEN' as const;

  constructor(public readonly permission: string) {
    super(`User forbidden: missing permission ${permission}`);
    this.name = 'UserForbiddenError';
  }
}
