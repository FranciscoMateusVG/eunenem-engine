import { z } from 'zod/v4';

/**
 * BC **Usuário**: administradores de campanhas (sem auth real; didático em memória).
 * IDs são UUIDs compatíveis com `AccountId` em Arrecadação — a app passa `accountId` como `creatorAccountId`.
 */

export const UserIdSchema = z.uuid();
export type UserId = z.infer<typeof UserIdSchema>;

/** Conta administrativa (1:1 com utilizador nesta fatia). */
export const UserAccountIdSchema = z.uuid();
export type UserAccountId = z.infer<typeof UserAccountIdSchema>;

export const UserEmailSchema = z
  .string()
  .trim()
  .transform((s) => s.toLowerCase())
  .pipe(z.string().email('Must be a valid email'));

export type UserEmail = z.infer<typeof UserEmailSchema>;

export const UserDisplayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name must not be empty')
  .max(120);

export type UserDisplayName = z.infer<typeof UserDisplayNameSchema>;

/** Permissão rudimentar (sem RBAC completo). */
export const UserPermissionSchema = z.enum(['campaign:admin']);
export type UserPermission = z.infer<typeof UserPermissionSchema>;

export const DEFAULT_USER_PERMISSIONS: readonly UserPermission[] = ['campaign:admin'];

export const SimulatedPasswordSchema = z
  .string()
  .min(1, 'Simulated password must not be empty')
  .max(200, 'Simulated password is too long');

export type SimulatedPassword = z.infer<typeof SimulatedPasswordSchema>;

/** Token opaco de sessão (não é JWT). */
export const SessionTokenSchema = z
  .string()
  .min(32, 'Session token must be opaque and sufficiently long');

export type SessionToken = z.infer<typeof SessionTokenSchema>;

export interface User {
  readonly id: UserId;
  readonly accountId: UserAccountId;
  readonly email: UserEmail;
  readonly displayName: UserDisplayName;
  readonly createdAt: Date;
}

/** Conta: permissões administrativas ligadas a um utilizador. */
export interface UserAccount {
  readonly id: UserAccountId;
  readonly userId: UserId;
  readonly permissions: readonly UserPermission[];
  readonly createdAt: Date;
}

/** Credencial simulada (texto plano só para demo — nunca produção). */
export interface SimulatedUserCredential {
  readonly userId: UserId;
  readonly simulatedPassword: SimulatedPassword;
}

export interface UserSession {
  readonly token: SessionToken;
  readonly accountId: UserAccountId;
  readonly expiresAt: Date;
}

export const RegisterUserAccountInputSchema = z.object({
  userId: UserIdSchema,
  accountId: UserAccountIdSchema,
  email: UserEmailSchema,
  displayName: UserDisplayNameSchema,
  simulatedPassword: SimulatedPasswordSchema,
});

export type RegisterUserAccountInput = z.infer<typeof RegisterUserAccountInputSchema>;

export const UpdateUserProfileInputSchema = z.object({
  userId: UserIdSchema,
  displayName: UserDisplayNameSchema,
});

export type UpdateUserProfileInput = z.infer<typeof UpdateUserProfileInputSchema>;

export const CreateUserSessionInputSchema = z.object({
  email: UserEmailSchema,
  simulatedPassword: SimulatedPasswordSchema,
});

export type CreateUserSessionInput = z.infer<typeof CreateUserSessionInputSchema>;

export const AuthorizeUserPermissionInputSchema = z.object({
  token: SessionTokenSchema,
  permission: UserPermissionSchema,
});

export type AuthorizeUserPermissionInput = z.infer<typeof AuthorizeUserPermissionInputSchema>;

/** Verifica se a sessão já expirou (regra pura). */
export function isUserSessionExpired(session: UserSession, now: Date): boolean {
  return now.getTime() >= session.expiresAt.getTime();
}

/** Verifica se a conta concede a permissão pedida. */
export function userAccountHasPermission(
  account: UserAccount,
  permission: UserPermission,
): boolean {
  return account.permissions.includes(permission);
}
