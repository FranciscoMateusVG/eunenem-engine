import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import type { Pagamento } from '../../src/domain/pagamentos/entities/pagamento.js';
import { PagamentoProviderProjectionConflictError } from '../../src/errors/pagamentos/provider-projection-conflict.error.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { seedPagamentoParents } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncatePagamentosTables } from '../helpers/truncate-pagamentos.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectStillBlocked(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
  ]);
  expect(outcome).toBe('blocked');
}

describe('PagamentoRepositoryPostgres lifecycle CAS classification snapshot', () => {
  let testDb: TestDatabase;
  let repository: PagamentoRepositoryPostgres;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  beforeEach(async () => {
    await truncatePagamentosTables(testDb.db);
    repository = new PagamentoRepositoryPostgres(testDb.db);
  });

  it('classifies a concurrently committed identity mismatch as a typed conflict', async () => {
    const pending = makePagamento({ paymentIntentExternalRef: 'pi_initial' });
    await seedPagamentoParents(testDb.db, pending);
    await repository.save(pending);

    const locked = deferred();
    const release = deferred();
    const competingProjection = testDb.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('pagamentos')
        .select('id')
        .where('id', '=', pending.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
      await trx
        .updateTable('pagamentos')
        .set({ intencao_payment_intent_external_ref: 'pi_canonical_conflict' })
        .where('id', '=', pending.id)
        .executeTakeFirstOrThrow();
    });
    await locked.promise;

    const lifecycleInput: Pagamento = {
      ...pending,
      status: 'processing',
      atualizadoEm: new Date('2026-05-01T12:03:00.000Z'),
      intencao: {
        ...pending.intencao,
        paymentIntentExternalRef: 'pi_stale_lifecycle',
      },
    };
    const lifecycleCas = repository.updateIfStatusIn(lifecycleInput, ['pendente']);
    await expectStillBlocked(lifecycleCas);
    release.resolve();
    await competingProjection;

    await expect(lifecycleCas).rejects.toBeInstanceOf(PagamentoProviderProjectionConflictError);
    await expect(repository.findById(pending.id)).resolves.toMatchObject({
      status: 'pendente',
      intencao: { paymentIntentExternalRef: 'pi_canonical_conflict' },
    });
  });

  it('classifies a concurrently committed status transition as CAS loss, not identity conflict', async () => {
    const pending = makePagamento({ paymentIntentExternalRef: 'pi_initial' });
    await seedPagamentoParents(testDb.db, pending);
    await repository.save(pending);

    const locked = deferred();
    const release = deferred();
    const competingTransition = testDb.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('pagamentos')
        .select('id')
        .where('id', '=', pending.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
      await trx
        .updateTable('pagamentos')
        .set({
          status: 'processing',
          intencao_payment_intent_external_ref: 'pi_other_writer',
        })
        .where('id', '=', pending.id)
        .executeTakeFirstOrThrow();
    });
    await locked.promise;

    const lifecycleInput: Pagamento = {
      ...pending,
      status: 'rejeitado',
      atualizadoEm: new Date('2026-05-01T12:03:00.000Z'),
      intencao: {
        ...pending.intencao,
        paymentIntentExternalRef: 'pi_stale_lifecycle',
      },
    };
    const lifecycleCas = repository.updateIfStatusIn(lifecycleInput, ['pendente']);
    await expectStillBlocked(lifecycleCas);
    release.resolve();
    await competingTransition;

    await expect(lifecycleCas).resolves.toBeUndefined();
    await expect(repository.findById(pending.id)).resolves.toMatchObject({
      status: 'processing',
      intencao: { paymentIntentExternalRef: 'pi_other_writer' },
    });
  });
});
