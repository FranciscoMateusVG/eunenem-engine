import type {
  SimulatedUserCredential,
  User,
  UserAccount,
  UserAccountId,
  UserDisplayName,
  UserEmail,
  UserId,
} from '../domain/user.js';

/**
 * Persistência de utilizador, conta e credencial simulada (porta).
 */
export interface UserRepository {
  saveRegistration(bundle: {
    readonly user: User;
    readonly account: UserAccount;
    readonly credential: SimulatedUserCredential;
  }): Promise<void>;

  findUserById(id: UserId): Promise<User | undefined>;
  findUserByEmail(email: UserEmail): Promise<User | undefined>;
  findAccountById(id: UserAccountId): Promise<UserAccount | undefined>;
  findCredentialByUserId(userId: UserId): Promise<SimulatedUserCredential | undefined>;
  updateUserDisplayName(userId: UserId, displayName: UserDisplayName): Promise<void>;
}
