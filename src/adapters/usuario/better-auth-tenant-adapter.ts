import { kyselyAdapter } from '@better-auth/kysely-adapter';
import type {
  BetterAuthOptions,
  DBAdapter,
  DBAdapterInstance,
  DBTransactionAdapter,
  JoinOption,
  Where,
} from 'better-auth/types';
import type { Database } from '../database.js';

/**
 * Generic error on a tenant-bound Better Auth lookup/write.
 *
 * Deliberately carries no email, provider account id, or tenant id. Better
 * Auth turns lookup failures into its generic OAuth error redirect; including
 * identity data here would only put PII into application logs.
 */
class BetterAuthTenantBoundaryError extends Error {
  constructor() {
    super('Better Auth tenant boundary rejected the identity operation');
    this.name = 'BetterAuthTenantBoundaryError';
  }
}

type LogicalRecord = Record<string, unknown>;
type FindOneInput = {
  model: string;
  where: Where[];
  select?: string[] | undefined;
  join?: JoinOption | undefined;
};

function tenantOf(record: LogicalRecord | null | undefined): unknown {
  return record?.idPlataforma;
}

function stringField(record: LogicalRecord, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function withTenantWhere(where: readonly Where[] | undefined, idPlataforma: string): Where[] {
  return [
    ...(where ?? []),
    {
      field: 'idPlataforma',
      value: idPlataforma,
    },
  ];
}

function exactEmailWhere(where: readonly Where[]): Where | null {
  return (
    where.find(
      (item) =>
        item.field === 'email' &&
        (item.operator === undefined || item.operator === 'eq') &&
        item.connector !== 'OR' &&
        typeof item.value === 'string',
    ) ?? null
  );
}

function exactStringWhere(where: readonly Where[] | undefined, field: string): string | null {
  const match = where?.find(
    (item) =>
      item.field === field &&
      (item.operator === undefined || item.operator === 'eq') &&
      item.connector !== 'OR' &&
      typeof item.value === 'string',
  );
  return typeof match?.value === 'string' ? match.value : null;
}

function isSingleOwnerLookup(
  model: 'account' | 'session',
  where: readonly Where[] | undefined,
): boolean {
  if (exactStringWhere(where, 'id')) return true;
  if (model === 'session') return exactStringWhere(where, 'token') !== null;
  return (
    exactStringWhere(where, 'accountId') !== null && exactStringWhere(where, 'providerId') !== null
  );
}

function isBoundedOwnerLookup(
  model: 'account' | 'session',
  where: readonly Where[] | undefined,
): boolean {
  if (isSingleOwnerLookup(model, where)) return true;
  if (model !== 'session') return false;
  return (
    where?.some(
      (item) =>
        item.field === 'token' &&
        item.operator === 'in' &&
        item.connector !== 'OR' &&
        Array.isArray(item.value) &&
        item.value.length > 0 &&
        item.value.every((value) => typeof value === 'string'),
    ) ?? false
  );
}

async function requireTenantUser(
  adapter: DBTransactionAdapter<BetterAuthOptions>,
  userId: string,
  idPlataforma: string,
): Promise<void> {
  const user = await adapter.findOne<LogicalRecord>({
    model: 'user',
    where: [
      { field: 'id', value: userId },
      { field: 'idPlataforma', value: idPlataforma },
    ],
  });
  if (!user || tenantOf(user) !== idPlataforma) {
    throw new BetterAuthTenantBoundaryError();
  }
}

/**
 * Resolve the owner of an account/session record through its joined Better
 * Auth user. Account and session tables deliberately do not duplicate the
 * platform id; users.id_plataforma is the single tenant authority.
 */
async function requireJoinedTenantOwner(
  adapter: DBTransactionAdapter<BetterAuthOptions>,
  model: 'account' | 'session',
  where: Where[],
  idPlataforma: string,
  join?: JoinOption | undefined,
): Promise<LogicalRecord | null> {
  const record = await adapter.findOne<LogicalRecord>({
    model,
    where,
    join: {
      ...join,
      user: true,
    },
  });
  if (!record) return null;
  const user = record.user;
  if (
    typeof user !== 'object' ||
    user === null ||
    tenantOf(user as LogicalRecord) !== idPlataforma
  ) {
    throw new BetterAuthTenantBoundaryError();
  }
  return record;
}

function joinWasRequested(join: JoinOption | undefined, model: string): boolean {
  return join !== undefined && Object.hasOwn(join, model) && join[model] !== false;
}

function projectOwnedRecord<T>(
  record: LogicalRecord,
  select: string[] | undefined,
  join: JoinOption | undefined,
): T {
  if (!select) {
    if (joinWasRequested(join, 'user')) return record as T;
    const { user: _user, ...withoutUser } = record;
    return withoutUser as T;
  }
  const projected: LogicalRecord = {};
  for (const field of select) {
    if (Object.hasOwn(record, field)) projected[field] = record[field];
  }
  for (const model of Object.keys(join ?? {})) {
    if (joinWasRequested(join, model) && Object.hasOwn(record, model)) {
      projected[model] = record[model];
    }
  }
  return projected as T;
}

async function findTenantUser<T>(
  adapter: DBTransactionAdapter<BetterAuthOptions>,
  input: FindOneInput,
  idPlataforma: string,
): Promise<T | null> {
  const emailWhere = exactEmailWhere(input.where);
  if (emailWhere) {
    // Read every tenant for this normalized email before selecting one.
    // limit=2 is sufficient: 0=new, 1=unambiguous, 2=collision.
    const matches = await adapter.findMany<LogicalRecord>({
      model: 'user',
      where: [emailWhere],
      limit: 2,
    });
    if (matches.length > 1) throw new BetterAuthTenantBoundaryError();
    if (matches.length === 1 && tenantOf(matches[0]) !== idPlataforma) {
      throw new BetterAuthTenantBoundaryError();
    }
  }
  return adapter.findOne<T>({
    ...input,
    where: withTenantWhere(input.where, idPlataforma),
  });
}

async function findTenantOwnedRecord<T>(
  adapter: DBTransactionAdapter<BetterAuthOptions>,
  input: FindOneInput,
  model: 'account' | 'session',
  idPlataforma: string,
): Promise<T | null> {
  if (!exactStringWhere(input.where, 'userId') && !isSingleOwnerLookup(model, input.where)) {
    throw new BetterAuthTenantBoundaryError();
  }
  const record = await requireJoinedTenantOwner(
    adapter,
    model,
    input.where,
    idPlataforma,
    input.join,
  );
  if (!record) return null;
  return projectOwnedRecord<T>(record, input.select, input.join);
}

async function findTenantSession<T>(
  adapter: DBTransactionAdapter<BetterAuthOptions>,
  input: FindOneInput,
  idPlataforma: string,
): Promise<T | null> {
  try {
    return await findTenantOwnedRecord<T>(adapter, input, 'session', idPlataforma);
  } catch (error) {
    // Session reads are an authentication question, not an OAuth
    // identity-selection error. A foreign signed cookie is simply not a
    // session in this application; return null without an identity oracle.
    if (error instanceof BetterAuthTenantBoundaryError) return null;
    throw error;
  }
}

async function boundedSingleOwnerWhere(
  adapter: DBTransactionAdapter<BetterAuthOptions>,
  input: {
    model: 'account' | 'session';
    where: Where[];
    nextUserId?: string | null | undefined;
  },
  idPlataforma: string,
): Promise<Where[] | null> {
  const scopedUserId = exactStringWhere(input.where, 'userId');
  if (scopedUserId) {
    await requireTenantUser(adapter, scopedUserId, idPlataforma);
    if (input.nextUserId) {
      await requireTenantUser(adapter, input.nextUserId, idPlataforma);
    }
    return input.where;
  }
  if (!isSingleOwnerLookup(input.model, input.where)) {
    throw new BetterAuthTenantBoundaryError();
  }
  const owned = await requireJoinedTenantOwner(adapter, input.model, input.where, idPlataforma);
  if (!owned) return null;
  if (input.nextUserId) {
    await requireTenantUser(adapter, input.nextUserId, idPlataforma);
  }
  const id = stringField(owned, 'id');
  if (!id) throw new BetterAuthTenantBoundaryError();
  return [...input.where, { field: 'id', value: id }];
}

async function findTenantOwnedRecords<T>(
  adapter: DBTransactionAdapter<BetterAuthOptions>,
  input: {
    model: 'account' | 'session';
    where?: Where[] | undefined;
    limit?: number | undefined;
    select?: string[] | undefined;
    sortBy?: { field: string; direction: 'asc' | 'desc' } | undefined;
    offset?: number | undefined;
    join?: JoinOption | undefined;
  },
  idPlataforma: string,
): Promise<T[]> {
  const userId = exactStringWhere(input.where, 'userId');
  if (userId) {
    await requireTenantUser(adapter, userId, idPlataforma);
    return adapter.findMany<T>(input);
  }
  if (!isBoundedOwnerLookup(input.model, input.where)) {
    throw new BetterAuthTenantBoundaryError();
  }
  const { select: _select, ...securityInput } = input;
  const records = await adapter.findMany<LogicalRecord>({
    ...securityInput,
    join: {
      ...input.join,
      user: true,
    },
  });
  return records.map((record) => {
    const user = record.user;
    if (
      typeof user !== 'object' ||
      user === null ||
      tenantOf(user as LogicalRecord) !== idPlataforma
    ) {
      throw new BetterAuthTenantBoundaryError();
    }
    return projectOwnedRecord<T>(record, input.select, input.join);
  });
}

/**
 * Wrap Better Auth's official Kysely adapter with a fixed platform boundary.
 *
 * Why the adapter seam is load-bearing:
 * - Better Auth 1.6.22 resolves OAuth accounts globally by
 *   (providerId, accountId), then falls back to a global email-only user read.
 * - Its account.create.before hook is too late: returning false aborts the
 *   account insert, but the core link flow continues into user/session writes.
 * - The application session resolver is later still; by then provider tokens,
 *   credentials, sessions, and profile fields may already have changed.
 *
 * The wrapper therefore enforces tenancy on the reads that select an identity,
 * before Better Auth reaches any hook or write:
 * - an exact provider account must belong to this platform;
 * - an unlinked email must have either zero global matches (new signup) or
 *   exactly one match on this platform;
 * - foreign-only and cross-platform duplicate emails fail closed.
 *
 * Transactions are wrapped recursively. Better Auth's createOAuthUser runs in
 * adapter.transaction(), so guarding only the top-level adapter would be the
 * familiar "tests pass, production composition bypasses the guard" mistake.
 */
export function tenantBoundBetterAuthAdapter(
  db: Database,
  idPlataforma: string,
): DBAdapterInstance {
  const baseFactory = kyselyAdapter(db, {
    type: 'postgres',
  });

  const wrapTransaction = (
    adapter: DBTransactionAdapter<BetterAuthOptions>,
  ): DBTransactionAdapter<BetterAuthOptions> => {
    const wrapped: DBTransactionAdapter<BetterAuthOptions> = {
      ...adapter,

      async findOne<T>(input: FindOneInput): Promise<T | null> {
        if (input.model === 'user') {
          return findTenantUser<T>(adapter, input, idPlataforma);
        }
        if (input.model === 'account') {
          return findTenantOwnedRecord<T>(adapter, input, 'account', idPlataforma);
        }
        if (input.model === 'session') {
          return findTenantSession<T>(adapter, input, idPlataforma);
        }
        return adapter.findOne<T>(input);
      },

      async findMany<T>(input: {
        model: string;
        where?: Where[] | undefined;
        limit?: number | undefined;
        select?: string[] | undefined;
        sortBy?: { field: string; direction: 'asc' | 'desc' } | undefined;
        offset?: number | undefined;
        join?: JoinOption | undefined;
      }): Promise<T[]> {
        if (input.model === 'user') {
          return adapter.findMany<T>({
            ...input,
            where: withTenantWhere(input.where, idPlataforma),
          });
        }
        if (input.model === 'account' || input.model === 'session') {
          // User-scoped lists are safe directly. Better Auth also pre-reads a
          // single row by unique id before hook-aware delete; force a user join
          // for that shape. Refuse broad unscoped scans rather than filtering
          // after limit/offset and returning incorrect pages.
          return findTenantOwnedRecords<T>(adapter, { ...input, model: input.model }, idPlataforma);
        }
        return adapter.findMany<T>(input);
      },

      async count(input: { model: string; where?: Where[] | undefined }): Promise<number> {
        if (input.model === 'user') {
          return adapter.count({
            ...input,
            where: withTenantWhere(input.where, idPlataforma),
          });
        }
        if (input.model === 'account' || input.model === 'session') {
          const userId = exactStringWhere(input.where, 'userId');
          if (!userId) throw new BetterAuthTenantBoundaryError();
          await requireTenantUser(adapter, userId, idPlataforma);
        }
        return adapter.count(input);
      },

      async create<T extends Record<string, unknown>, R = T>(input: {
        model: string;
        data: Omit<T, 'id'>;
        select?: string[] | undefined;
        forceAllowId?: boolean | undefined;
      }): Promise<R> {
        if (input.model === 'user') {
          const data = {
            ...input.data,
            idPlataforma,
          } as Omit<T, 'id'>;
          return adapter.create<T, R>({ ...input, data });
        }
        if (input.model === 'account' || input.model === 'session') {
          const userId = stringField(input.data as LogicalRecord, 'userId');
          if (!userId) throw new BetterAuthTenantBoundaryError();
          await requireTenantUser(adapter, userId, idPlataforma);
        }
        return adapter.create<T, R>(input);
      },

      async update<T>(input: {
        model: string;
        where: Where[];
        update: Record<string, unknown>;
      }): Promise<T | null> {
        if (input.model === 'user') {
          return adapter.update<T>({
            ...input,
            where: withTenantWhere(input.where, idPlataforma),
            update: {
              ...input.update,
              idPlataforma,
            },
          });
        }
        if (input.model === 'account' || input.model === 'session') {
          const where = await boundedSingleOwnerWhere(
            adapter,
            {
              model: input.model,
              where: input.where,
              nextUserId: stringField(input.update, 'userId'),
            },
            idPlataforma,
          );
          if (!where) return null;
          return adapter.update<T>({ ...input, where });
        }
        return adapter.update<T>(input);
      },

      async updateMany(input: {
        model: string;
        where: Where[];
        update: Record<string, unknown>;
      }): Promise<number> {
        if (input.model === 'user') {
          return adapter.updateMany({
            ...input,
            where: withTenantWhere(input.where, idPlataforma),
            update: {
              ...input.update,
              idPlataforma,
            },
          });
        }
        if (input.model === 'account' || input.model === 'session') {
          await findTenantOwnedRecords(
            adapter,
            {
              model: input.model,
              where: input.where,
              join: { user: true },
            },
            idPlataforma,
          );
          const nextUserId = stringField(input.update, 'userId');
          if (nextUserId) await requireTenantUser(adapter, nextUserId, idPlataforma);
        }
        return adapter.updateMany(input);
      },

      async delete<_T>(input: { model: string; where: Where[] }): Promise<void> {
        if (input.model === 'user') {
          return adapter.delete({
            ...input,
            where: withTenantWhere(input.where, idPlataforma),
          });
        }
        if (input.model === 'account' || input.model === 'session') {
          const where = await boundedSingleOwnerWhere(
            adapter,
            {
              model: input.model,
              where: input.where,
            },
            idPlataforma,
          );
          if (!where) return;
          return adapter.delete({ ...input, where });
        }
        return adapter.delete(input);
      },

      async deleteMany(input: { model: string; where: Where[] }): Promise<number> {
        if (input.model === 'user') {
          return adapter.deleteMany({
            ...input,
            where: withTenantWhere(input.where, idPlataforma),
          });
        }
        if (input.model === 'account' || input.model === 'session') {
          await findTenantOwnedRecords(
            adapter,
            {
              model: input.model,
              where: input.where,
              join: { user: true },
            },
            idPlataforma,
          );
        }
        return adapter.deleteMany(input);
      },

      async consumeOne<T>(input: { model: string; where: Where[] }): Promise<T | null> {
        if (input.model === 'user') {
          return adapter.consumeOne<T>({
            ...input,
            where: withTenantWhere(input.where, idPlataforma),
          });
        }
        if (input.model === 'account' || input.model === 'session') {
          const where = await boundedSingleOwnerWhere(
            adapter,
            {
              model: input.model,
              where: input.where,
            },
            idPlataforma,
          );
          if (!where) return null;
          return adapter.consumeOne<T>({ ...input, where });
        }
        return adapter.consumeOne<T>(input);
      },

      async incrementOne<T>(input: {
        model: string;
        where: Where[];
        increment: Record<string, number>;
        set?: Record<string, unknown> | undefined;
      }): Promise<T | null> {
        if (input.model === 'user') {
          return adapter.incrementOne<T>({
            ...input,
            where: withTenantWhere(input.where, idPlataforma),
            set: {
              ...input.set,
              idPlataforma,
            },
          });
        }
        if (input.model === 'account' || input.model === 'session') {
          const where = await boundedSingleOwnerWhere(
            adapter,
            {
              model: input.model,
              where: input.where,
              nextUserId: input.set ? stringField(input.set, 'userId') : null,
            },
            idPlataforma,
          );
          if (!where) return null;
          return adapter.incrementOne<T>({ ...input, where });
        }
        return adapter.incrementOne<T>(input);
      },
    };

    return wrapped;
  };

  const wrap = (adapter: DBAdapter<BetterAuthOptions>): DBAdapter<BetterAuthOptions> => {
    const wrappedTransaction = wrapTransaction(adapter);
    return {
      ...wrappedTransaction,
      transaction<R>(
        callback: (trx: DBTransactionAdapter<BetterAuthOptions>) => Promise<R>,
      ): Promise<R> {
        return adapter.transaction((trx) => callback(wrapTransaction(trx)));
      },
    };
  };

  return (options) => wrap(baseFactory(options));
}
