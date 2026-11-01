import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { CheckoutOperationRepositoryPostgres } from '../../src/adapters/pagamentos/checkout-operation-repository.postgres.js';
import { PagamentoEventPublisherMemory } from '../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import { PixCobrancaProviderFake } from '../../src/adapters/pagamentos/pix-cobranca-provider.fake.js';
import { PagamentoProviderFake } from '../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import { ProvedorRegraTaxaMemory } from '../../src/adapters/taxas/regra-provider.memory.js';
import { WebhookEventArchiveMemory } from '../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { removerContribuicao } from '../../src/use-cases/arrecadacao/remover-contribuicao.js';
import { finalizarPagamentoAprovado } from '../../src/use-cases/checkout/finalizar-pagamento-aprovado.js';
import { finalizarPagamentoRejeitado } from '../../src/use-cases/checkout/finalizar-pagamento-rejeitado.js';
import { prepararPagamentoCarrinho } from '../../src/use-cases/checkout/iniciar-pagamento-carrinho.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { createTestObservability } from '../helpers/observability.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { seedPagamentoParents } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';

let testDb: TestDatabase;
const obs = createTestObservability();
beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);
afterAll(async () => {
  await testDb?.teardown();
  await obs.shutdown();
});
beforeEach(async () => {
  await truncateArrecadacaoTables(testDb.db);
});

describe('aperture-vcrxu: removal preserves payment history', () => {
  it.each([
    'pendente',
    'rejeitado',
  ] as const)('removes gift with %s payment without FK failure', async (status) => {
    const idContribuicao = randomUUID();
    const pagamento = makePagamento({ idContribuicao, status });
    await seedPagamentoParents(testDb.db, pagamento);
    const contribuicaoRepository = new ContribuicaoRepositoryPostgres(testDb.db);
    const pagamentoRepository = new PagamentoRepositoryPostgres(testDb.db);
    await pagamentoRepository.save(pagamento);
    const before = await pagamentoRepository.findById(pagamento.id);
    const gift = await contribuicaoRepository.findById(idContribuicao);
    if (!gift) throw new Error('Missing seeded gift');
    await removerContribuicao(
      { contribuicaoRepository, pagamentoRepository, observability: obs.observability },
      {
        idContribuicao,
        idCampanhaEsperada: pagamento.intencao.idCampanha,
      },
    );
    expect(await contribuicaoRepository.findById(idContribuicao)).toBeUndefined();
    expect(await contribuicaoRepository.findByCampanhaId(gift.idCampanha)).toEqual([]);
    expect(
      await contribuicaoRepository.findByOpcao(gift.idCampanha, gift.idOpcaoContribuicao),
    ).toEqual([]);
    expect(
      await contribuicaoRepository.countByOpcao(gift.idCampanha, gift.idOpcaoContribuicao),
    ).toBe(0);
    expect(await pagamentoRepository.findById(pagamento.id)).toEqual(before);
    expect(
      await testDb.db
        .selectFrom('contribuicoes')
        .select('id')
        .where('id', '=', idContribuicao)
        .executeTakeFirst(),
    ).toBeDefined();
  });

  it('still refuses removal with approved payment and logs the real reason', async () => {
    const log = vi.spyOn(obs.observability.logger, 'error');
    const idContribuicao = randomUUID();
    const pagamento = makePagamento({ idContribuicao, status: 'aprovado' });
    await seedPagamentoParents(testDb.db, pagamento);
    const contribuicaoRepository = new ContribuicaoRepositoryPostgres(testDb.db);
    const pagamentoRepository = new PagamentoRepositoryPostgres(testDb.db);
    await pagamentoRepository.save(pagamento);
    await expect(
      removerContribuicao(
        { contribuicaoRepository, pagamentoRepository, observability: obs.observability },
        {
          idContribuicao,
          idCampanhaEsperada: pagamento.intencao.idCampanha,
        },
      ),
    ).rejects.toThrow();
    expect(await contribuicaoRepository.findById(idContribuicao)).toBeDefined();
    expect(log).toHaveBeenCalledWith(
      'arrecadacao.contribuicao.remocao_falhou',
      expect.objectContaining({
        idContribuicao,
        error: `Contribuicao indisponivel: ${idContribuicao}`,
      }),
    );
    log.mockRestore();
  });
});

it.each([
  'aprovado',
  'rejeitado',
] as const)('existing pending payment can finish %s after archival', async (status) => {
  const idContribuicao = randomUUID();
  const pagamento = makePagamento({ idContribuicao });
  await seedPagamentoParents(testDb.db, pagamento);
  const contribuicaoRepository = new ContribuicaoRepositoryPostgres(testDb.db);
  const pagamentoRepository = new PagamentoRepositoryPostgres(testDb.db);
  await pagamentoRepository.save(pagamento);
  const deps = {
    contribuicaoRepository,
    pagamentoRepository,
    observability: obs.observability,
    campanhaRepository: new CampanhaRepositoryPostgres(
      testDb.db,
      new RecebedorRepositoryPostgres(testDb.db),
    ),
    pagamentoProvider: new PagamentoProviderFake({ statusResultado: status }),
    pagamentoEventPublisher: new PagamentoEventPublisherMemory(),
    livroFinanceiroRepository: new LivroFinanceiroRepositoryPostgres(testDb.db),
    clock: () => new Date(),
  };
  await removerContribuicao(deps, {
    idContribuicao,
    idCampanhaEsperada: pagamento.intencao.idCampanha,
  });
  const campaign = await deps.campanhaRepository.findById(pagamento.intencao.idCampanha);
  if (!campaign) throw new Error('Missing seeded campaign');
  await expect(
    prepararPagamentoCarrinho(
      {
        ...deps,
        provedorRegraTaxa: new ProvedorRegraTaxaMemory(),
        checkoutOperationRepository: new CheckoutOperationRepositoryPostgres(testDb.db),
        checkoutSessionProvider: deps.pagamentoProvider,
        pixCobrancaProvider: new PixCobrancaProviderFake(),
        cobrancaPixProviderKind: 'fake',
      },
      {
        idPlataforma: campaign.idPlataforma,
        idCampanha: campaign.id,
        itens: [{ idContribuicao, quantidade: 1 }],
        metodo: 'pix',
        idPagamento: randomUUID(),
        idIntencaoPagamento: randomUUID(),
        idsItens: [randomUUID()],
        returnUrl: 'http://localhost/checkout',
      },
      { capability: 'a'.repeat(43) },
    ),
  ).rejects.toThrow('nao encontrada');
  const finalize = status === 'aprovado' ? finalizarPagamentoAprovado : finalizarPagamentoRejeitado;
  await finalize(deps, { idPagamento: pagamento.id });
  await finalize(deps, { idPagamento: pagamento.id }); // webhook replay stays valid
  expect((await pagamentoRepository.findById(pagamento.id))?.status).toBe(status);
  expect(await contribuicaoRepository.findById(idContribuicao)).toBeUndefined();
  const entries = await deps.livroFinanceiroRepository.findLancamentosByIdPagamento(pagamento.id);
  expect(entries.length).toBe(status === 'aprovado' ? 2 : 0);
});

it.each([
  'pendente',
  'rejeitado',
] as const)('admin history still resolves %s payment and gift name after archive', async (status) => {
  const idContribuicao = randomUUID();
  const payment = makePagamento({ idContribuicao, status });
  await seedPagamentoParents(testDb.db, payment);
  await testDb.db
    .updateTable('campanhas')
    .set({ id_plataforma: ID_PLATAFORMA_EUNENEM })
    .where('id', '=', payment.intencao.idCampanha)
    .execute();
  const contribuicaoRepository = new ContribuicaoRepositoryPostgres(testDb.db);
  const pagamentoRepository = new PagamentoRepositoryPostgres(testDb.db);
  await pagamentoRepository.save(payment);
  const auth = adminAuthOverrides();
  const caller = appRouter.createCaller({
    headers: auth.headers,
    resHeaders: new Headers(),
    deps: {
      ...auth.depsOverrides,
      contribuicaoRepository,
      pagamentoRepository,
      campanhaRepository: new CampanhaRepositoryPostgres(
        testDb.db,
        new RecebedorRepositoryPostgres(testDb.db),
      ),
      livroFinanceiroRepository: new LivroFinanceiroRepositoryPostgres(testDb.db),
      webhookEventArchive: new WebhookEventArchiveMemory(),
      clock: () => new Date(),
      observability: obs.observability,
    } as unknown as ServerDeps,
  });
  const before = await caller.admin.pagamentos.findById({ idPagamento: payment.id });
  expect(JSON.stringify(before)).toContain('seed');
  await removerContribuicao(
    { contribuicaoRepository, pagamentoRepository, observability: obs.observability },
    {
      idContribuicao,
      idCampanhaEsperada: payment.intencao.idCampanha,
    },
  );
  expect(await caller.admin.pagamentos.findById({ idPagamento: payment.id })).toEqual(before);
  const listed = await caller.admin.pagamentos.listByCampanha({
    idCampanha: payment.intencao.idCampanha,
  });
  expect(listed.pagamentos).toHaveLength(1);
  expect(JSON.stringify(listed)).toContain('seed');
});

it('admin gift listing marks archived gifts explicitly', async () => {
  const idContribuicao = randomUUID();
  const payment = makePagamento({ idContribuicao, status: 'pendente' });
  await seedPagamentoParents(testDb.db, payment);
  await testDb.db
    .updateTable('campanhas')
    .set({ id_plataforma: ID_PLATAFORMA_EUNENEM })
    .where('id', '=', payment.intencao.idCampanha)
    .execute();
  const repo = new ContribuicaoRepositoryPostgres(testDb.db);
  const auth = adminAuthOverrides();
  const caller = appRouter.createCaller({
    headers: auth.headers,
    resHeaders: new Headers(),
    deps: {
      ...auth.depsOverrides,
      contribuicaoRepository: repo,
      pagamentoRepository: new PagamentoRepositoryPostgres(testDb.db),
      campanhaRepository: new CampanhaRepositoryPostgres(
        testDb.db,
        new RecebedorRepositoryPostgres(testDb.db),
      ),
    } as unknown as ServerDeps,
  });
  const input = { idCampanha: payment.intencao.idCampanha };
  expect((await caller.admin.contribuicoes.listByCampanha(input)).contribuicoes[0]).toMatchObject({
    id: idContribuicao,
    arquivada: false,
  });
  await repo.deleteById(idContribuicao);
  expect((await caller.admin.contribuicoes.listByCampanha(input)).contribuicoes[0]).toMatchObject({
    id: idContribuicao,
    arquivada: true,
  });
});
