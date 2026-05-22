import type { Transaction } from 'kysely';
import type { DB } from '../db-types.generated.js';

/** Contexto opcional de transação para persistência Postgres do BC Arrecadação. */
export interface ArrecadacaoRepositoryContext {
  readonly trx?: Transaction<DB>;
}
