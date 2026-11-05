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
import { reenviarRepasseContaPeloInter } from '../../src/use-cases/pagamentos/financeiro/reenviar-repasse-conta-pelo-inter.js';
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

async function seedRepasseComLancamento(
  override: Partial<RepasseRecebedor> = {},
  transferidoEm: Date | null = null,
): Promise<{ idRepasse: IdRepasse; idCampanha: string }> {
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
    ...override,
  };
  await repo.saveRepasse(repasse);
  // saveRepasse persists only the basic columns; transfer columns go in directly.
  await sql`UPDATE repasses_recebedor
      SET transfer_referencia = ${repasse.transferReferencia},
          transfer_attempts = ${repasse.transferAttempts}
      WHERE id = ${idRepasse}`.execute(testDb.db);
  const lancamento: LancamentoFinanceiro = {
    id: randomUUID() as never,
    idPagamento: randomUUID() as never,
    idItemPagamento: randomUUID() as never,
    idContribuicao: randomUUID() as never,
    idCampanha: idCampanha as never,
    tipo: 'credito_saldo_recebedor',
    amountCents: 4500 as never,
    criadoEm: T0,
    transferidoEm,
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

describe('conta já aprovada e marcada transferida sem envio — "Enviar pelo Inter agora"', () => {
  const APROVADA_SEM_ENVIO = { status: 'aprovado', aprovadoEm: T0 } as const;

  function reenviarDeps(enqueuer: RepasseJobEnqueuer) {
    return {
      livroFinanceiroRepository: repo,
      repasseJobEnqueuer: enqueuer,
      clock: () => new Date(),
      observability,
    };
  }

  it('desmarca o ledger, enfileira pela mesma via nova, audita e depois paga por DADOS_BANCARIOS', async () => {
    const { idRepasse } = await seedRepasseComLancamento(APROVADA_SEM_ENVIO, T0);
    expect(await stamped(idRepasse)).toBe(1);
    const spy = spyEnqueuer();

    const { repasse } = await reenviarRepasseContaPeloInter(reenviarDeps(spy.enqueuer), {
      idRepasse,
      motivo: 'Aprovado antes da correção; nenhum envio ocorreu',
      solicitadoPor: 'admin@eunenem.com',
    });

    expect(repasse.transferReferencia).not.toBeNull();
    expect(spy.executar).toEqual([idRepasse]);
    expect(await stamped(idRepasse)).toBe(0);
    const audit = await sql<{ request_summary: string; operation: string }>`
      SELECT request_summary, operation FROM repasse_transfer_attempts WHERE repasse_id = ${idRepasse}`.execute(
      testDb.db,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.operation).toBe('reenvio_inter');
    expect(audit.rows[0]?.request_summary).toContain('admin@eunenem.com');
    expect(audit.rows[0]?.request_summary).toContain('Aprovado antes da correção');

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
    expect(fake.pagarPixInputs[0]?.destinatario.tipo).toBe('DADOS_BANCARIOS');
    expect((await repo.findRepasseById(idRepasse))?.status).toBe('enviado_ao_banco');
  });

  it('segunda chamada não reenvia (um único job, ledger já desmarcado)', async () => {
    const { idRepasse } = await seedRepasseComLancamento(APROVADA_SEM_ENVIO, T0);
    const spy = spyEnqueuer();
    const input = { idRepasse, motivo: 'Aprovado antes da correção', solicitadoPor: 'a@b.com' };
    await reenviarRepasseContaPeloInter(reenviarDeps(spy.enqueuer), input);
    await expect(
      reenviarRepasseContaPeloInter(reenviarDeps(spy.enqueuer), input),
    ).rejects.toThrow();
    expect(spy.executar).toHaveLength(1);
  });

  it.each([
    ['com referência bancária registrada', { bankTransferRef: 'E2E123' }],
    ['com tentativa de envio já feita', { transferAttempts: 1, transferReferencia: 'EN1' }],
    ['ainda solicitado', { status: 'solicitado', aprovadoEm: null }],
  ])('inelegível %s: rejeita sem enfileirar nem desmarcar', async (_nome, override) => {
    const { idRepasse } = await seedRepasseComLancamento(
      { ...APROVADA_SEM_ENVIO, ...override } as Partial<RepasseRecebedor>,
      T0,
    );
    const spy = spyEnqueuer();
    await expect(
      reenviarRepasseContaPeloInter(reenviarDeps(spy.enqueuer), {
        idRepasse,
        motivo: 'Aprovado antes da correção',
        solicitadoPor: 'a@b.com',
      }),
    ).rejects.toThrow();
    expect(spy.executar).toHaveLength(0);
    expect(await stamped(idRepasse)).toBe(1);
  });

  it('recebedor PIX (não conta): rejeita', async () => {
    recebedorAtual = {
      metodo: 'pix',
      nomeTitular: 'Bia',
      cpfTitular: '52998224725',
      tipoChavePix: 'email',
      chavePix: 'bia@example.com',
    };
    const { idRepasse } = await seedRepasseComLancamento(APROVADA_SEM_ENVIO, T0);
    const spy = spyEnqueuer();
    await expect(
      reenviarRepasseContaPeloInter(reenviarDeps(spy.enqueuer), {
        idRepasse,
        motivo: 'Aprovado antes da correção',
        solicitadoPor: 'a@b.com',
      }),
    ).rejects.toThrow();
    expect(spy.executar).toHaveLength(0);
  });
});
