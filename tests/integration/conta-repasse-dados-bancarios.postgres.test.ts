/**
 * aperture-mno2s — recebedor `metodo='conta'` is paid automatically via Inter
 * PIX with `destinatario.tipo = 'DADOS_BANCARIOS'`, through the same approve →
 * transactional enqueue → executar pipeline as PIX-key recebedores. Real
 * Postgres; only the Inter HTTP boundary is the fake provider.
 */

import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RecebedorRepository } from '../../src/adapters/arrecadacao/recebedor-repository.js';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import type { RepasseJobEnqueuer } from '../../src/adapters/pagamentos/transferencia-enqueuer.js';
import { TransferenciaProviderFake } from '../../src/adapters/pagamentos/transferencia-provider.fake.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type { IdRepasse } from '../../src/domain/pagamentos/financeiro/value-objects/ids.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import type { Observability } from '../../src/observability/observability.js';
import { aprovarRepasseRecebedor } from '../../src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
import { executarTransferenciaRepasse } from '../../src/use-cases/pagamentos/financeiro/executar-transferencia-repasse.js';
import { seedLancamentoParents } from '../helpers/seed-lancamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const T0 = new Date('2026-07-16T12:00:00Z');

const CONTA_RECEBEDOR = {
  metodo: 'conta',
  nomeTitular: 'Bia Silva',
  cpfTitular: '52998224725',
  celularTitular: '11999998888',
  codigoBanco: '341',
  agencia: '123',
  agenciaDigito: null,
  conta: '456789',
  contaDigito: '0',
  tipoConta: 'cp',
} as const;

let testDb: TestDatabase;
let repo: LivroFinanceiroRepositoryPostgres;
let recebedorAtual: Record<string, unknown> = CONTA_RECEBEDOR;

const observability: Observability = {
  logger: new NoopLogger(),
  tracer: trace.getTracer('conta-repasse-test'),
};

const recebedorRepositoryStub = {
  async save(): Promise<void> {},
  async findAtivoByCampanhaId(): Promise<unknown> {
    return { dadosRecebedor: recebedorAtual };
  },
  async findByCampanhaId(): Promise<readonly unknown[]> {
    return [];
  },
} as unknown as RecebedorRepository;

beforeAll(async () => {
  testDb = await createTestDatabase();
  repo = new LivroFinanceiroRepositoryPostgres(testDb.db, recebedorRepositoryStub);
}, 60000);

async function clean(): Promise<void> {
  const db = testDb.db;
  await sql`DELETE FROM repasse_reconciliacao_candidatos`.execute(db);
  await sql`DELETE FROM repasse_transfer_attempts`.execute(db);
  await sql`DELETE FROM lancamentos_financeiros`.execute(db);
  await sql`DELETE FROM repasses_recebedor`.execute(db);
  await sql`DELETE FROM intencao_items`.execute(db);
  await sql`DELETE FROM pagamentos`.execute(db);
}

afterAll(async () => {
  await clean();
  await testDb.teardown();
});

beforeEach(async () => {
  recebedorAtual = CONTA_RECEBEDOR;
  await clean();
});

async function seedRepasseComLancamento(): Promise<{ idRepasse: IdRepasse; idCampanha: string }> {
  const idRepasse = randomUUID() as IdRepasse;
  const idCampanha = randomUUID();
  const repasse: RepasseRecebedor = {
    id: idRepasse,
    idCampanha: idCampanha as IdCampanha,
    amountCents: 4500 as never,
    status: 'solicitado',
    solicitadoEm: T0,
    aprovadoEm: null,
    bankTransferRef: null,
    transferReferencia: null,
    interCodigoSolicitacao: null,
    transferAttempts: 0,
    lastTransferError: null,
  };
  await repo.saveRepasse(repasse);
  const lancamento: LancamentoFinanceiro = {
    id: randomUUID() as never,
    idPagamento: randomUUID() as never,
    idItemPagamento: randomUUID() as never,
    idContribuicao: randomUUID() as never,
    idCampanha: idCampanha as never,
    tipo: 'credito_saldo_recebedor',
    amountCents: 4500 as never,
    criadoEm: T0,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: idRepasse as never,
  };
  await seedLancamentoParents(testDb.db, [lancamento]);
  await repo.saveLancamentos([lancamento]);
  return { idRepasse, idCampanha };
}

function spyEnqueuer(): { enqueuer: RepasseJobEnqueuer; executar: string[] } {
  const executar: string[] = [];
  return {
    executar,
    enqueuer: {
      async enqueueExecutar(data) {
        executar.push(data.idRepasse);
      },
      async enqueueConfirmar() {},
    },
  };
}

async function stamped(idRepasse: string): Promise<number> {
  const r = await sql<{ cnt: number }>`
    SELECT count(*)::int AS cnt FROM lancamentos_financeiros
      WHERE id_repasse = ${idRepasse} AND transferido_em IS NOT NULL`.execute(testDb.db);
  return r.rows[0]?.cnt ?? 0;
}

describe('conta recebedor — pago automaticamente via DADOS_BANCARIOS', () => {
  it('aprovar enfileira o envio e NÃO marca transferido; executar paga por dados bancários com ISPB do COMPE', async () => {
    const { idRepasse } = await seedRepasseComLancamento();
    const spy = spyEnqueuer();

    const { repasse } = await aprovarRepasseRecebedor(
      {
        livroFinanceiroRepository: repo,
        repasseJobEnqueuer: spy.enqueuer,
        clock: () => new Date(),
        observability,
      },
      { idRepasse, bankTransferRef: null },
    );

    expect(repasse.status).toBe('aprovado');
    expect(spy.executar).toEqual([idRepasse]);
    expect(await stamped(idRepasse)).toBe(0);

    const fake = new TransferenciaProviderFake({ pagarPixOutcome: 'pago' });
    await executarTransferenciaRepasse(
      {
        livroFinanceiroRepository: repo,
        transferenciaProvider: fake,
        clock: () => new Date(),
        observability,
      },
      { idRepasse },
    );

    expect(fake.pagarPixCalls).toBe(1);
    expect(fake.pagarPixInputs[0]?.destinatario).toEqual({
      tipo: 'DADOS_BANCARIOS',
      nome: 'Bia Silva',
      cpfCnpj: '52998224725',
      ispb: '60701190',
      agencia: '0123',
      conta: '4567890',
      tipoConta: 'CONTA_POUPANCA',
    });
    expect((await repo.findRepasseById(idRepasse))?.status).toBe('enviado_ao_banco');
  });

  it('banco desconhecido ⇒ falha fechada: provider nunca é chamado, repasse falhou com erro claro', async () => {
    recebedorAtual = { ...CONTA_RECEBEDOR, codigoBanco: '999' };
    const { idRepasse } = await seedRepasseComLancamento();
    await aprovarRepasseRecebedor(
      {
        livroFinanceiroRepository: repo,
        repasseJobEnqueuer: spyEnqueuer().enqueuer,
        clock: () => new Date(),
        observability,
      },
      { idRepasse, bankTransferRef: null },
    );

    const fake = new TransferenciaProviderFake({ pagarPixOutcome: 'pago' });
    await executarTransferenciaRepasse(
      {
        livroFinanceiroRepository: repo,
        transferenciaProvider: fake,
        clock: () => new Date(),
        observability,
      },
      { idRepasse },
    );

    expect(fake.pagarPixCalls).toBe(0);
    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('falhou');
    expect(persisted?.lastTransferError).toBe('BANCO_DESCONHECIDO');
    expect(await stamped(idRepasse)).toBe(0);
  });
});
