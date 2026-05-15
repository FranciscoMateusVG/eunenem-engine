import { SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  SimulatedUserCredential,
  User,
  UserAccount,
  UserAccountId,
  UserDisplayName,
  UserEmail,
  UserId,
} from '../domain/user.js';
import { UserEmailAlreadyExistsError } from '../errors/user-email-already-exists.error.js';
import type { UserRepository } from './user-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'users',
} as const;

export class UserRepositoryMemory implements UserRepository {
  private readonly users = new Map<UserId, User>();
  private readonly accounts = new Map<UserAccountId, UserAccount>();
  private readonly credentials = new Map<UserId, SimulatedUserCredential>();
  private readonly userIdByEmail = new Map<UserEmail, UserId>();

  async saveRegistration(bundle: {
    readonly user: User;
    readonly account: UserAccount;
    readonly credential: SimulatedUserCredential;
  }): Promise<void> {
    return tracer.startActiveSpan('db.users.saveRegistration', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const { user, account, credential } = bundle;

        if (account.userId !== user.id || account.id !== user.accountId) {
          throw new Error('Invariant violated: account must reference user and user.accountId');
        }

        if (credential.userId !== user.id) {
          throw new Error('Invariant violated: credential must reference user');
        }

        if (this.userIdByEmail.has(user.email)) {
          throw new UserEmailAlreadyExistsError(user.email);
        }

        this.users.set(user.id, user);
        this.accounts.set(account.id, account);
        this.credentials.set(user.id, credential);
        this.userIdByEmail.set(user.email, user.id);

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findUserById(id: UserId): Promise<User | undefined> {
    return tracer.startActiveSpan('db.users.findUserById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.users.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findUserByEmail(email: UserEmail): Promise<User | undefined> {
    return tracer.startActiveSpan('db.users.findUserByEmail', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const userId = this.userIdByEmail.get(email);
        const result = userId ? this.users.get(userId) : undefined;
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findAccountById(id: UserAccountId): Promise<UserAccount | undefined> {
    return tracer.startActiveSpan('db.users.findAccountById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.accounts.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findCredentialByUserId(userId: UserId): Promise<SimulatedUserCredential | undefined> {
    return tracer.startActiveSpan('db.users.findCredentialByUserId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.credentials.get(userId);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async updateUserDisplayName(userId: UserId, displayName: UserDisplayName): Promise<void> {
    return tracer.startActiveSpan('db.users.updateUserDisplayName', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const existing = this.users.get(userId);
        if (!existing) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        this.users.set(userId, {
          ...existing,
          displayName,
        });

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
