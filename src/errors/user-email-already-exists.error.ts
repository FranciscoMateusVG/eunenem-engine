export class UserEmailAlreadyExistsError extends Error {
  public readonly code = 'USER_EMAIL_ALREADY_EXISTS' as const;

  constructor(public readonly email: string) {
    super(`User email already exists: ${email}`);
    this.name = 'UserEmailAlreadyExistsError';
  }
}
