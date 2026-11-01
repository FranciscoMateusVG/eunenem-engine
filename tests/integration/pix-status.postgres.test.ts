import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readPixStatus } from '../../apps/eunenem-server/server/trpc/pix-status.js';
import {
  type InterPixWebhookDeps,
  mountInterPixWebhookRoutes,
} from '../../apps/eunenem-server/server/webhooks/inter-pix-webhook.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { createDatabase } from '../../src/adapters/database.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PixCobrancaProviderFake } from '../../src/adapters/pagamentos/pix-cobranca-provider.fake.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import { WebhookEventArchiveMemory } from '../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { createArrecadacaoMemoryRepos } from '../helpers/arrecadacao-repos.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { seedPagamentoParents } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;
const fixtures: ReturnType<typeof makePagamento>[] = [];
beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  for (const p of fixtures) {
    await testDb.db
      .deleteFrom('rate_limit')
      .where('key', '=', `pix-status:provider-read:${p.id}`)
      .execute();
    await testDb.db.deleteFrom('intencao_items').where('id_pagamento', '=', p.id).execute();
    await testDb.db.deleteFrom('pagamentos').where('id', '=', p.id).execute();
    await testDb.db
      .deleteFrom('contribuicoes')
      .where('campanha_id', '=', p.intencao.idCampanha)
      .execute();
    await testDb.db
      .deleteFrom('opcoes_contribuicao')
      .where('campanha_id', '=', p.intencao.idCampanha)
      .execute();
    await testDb.db.deleteFrom('campanhas').where('id', '=', p.intencao.idCampanha).execute();
  }
  await testDb.teardown();
});

async function fixture() {
  let now = new Date('2026-11-01T12:00:00Z');
  const id = randomUUID();
  const payment = makePagamento({ id, externalRef: id.replaceAll('-', ''), criadoEm: now });
  fixtures.push(payment);
  await seedPagamentoParents(testDb.db, payment);
  const repo = new PagamentoRepositoryPostgres(testDb.db);
  await repo.save(payment);
  const provider = new PixCobrancaProviderFake();
  const consult = vi.spyOn(provider, 'consultarCobranca').mockResolvedValue({
    status: 'ativa',
    txid: payment.intencao.externalRef ?? '',
    valorOriginalCents: 8400 as never,
  });
  const logger = new NoopLogger();
  const log = vi.spyOn(logger, 'info');
  const deps = {
    db: testDb.db,
    clock: () => now,
    observability: { logger, tracer: noopTracer() },
    pagamentoRepository: repo,
    pixCobrancaProvider: provider,
    cobrancaPixProviderKind: 'inter' as const,
  };
  const read = async () =>
    readPixStatus(
      deps,
      (await repo.findById(payment.id)) ?? payment,
      payment.intencao.externalRef ?? '',
    );
  return {
    payment,
    deps,
    read,
    consult,
    log,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('PIX status: durable admission independent of webhook lease', () => {
  it('first minute has no HTTP; >1 process and many tabs admit only one GET/minute', async () => {
    const f = await fixture();
    await expect(f.read()).resolves.toEqual({ status: 'pendente' });
    f.advance(59_999);
    await f.read();
    expect(f.consult).not.toHaveBeenCalled();
    f.advance(1);
    const db2 = createDatabase(testDb.connectionUri);
    try {
      const other = {
        ...f.deps,
        db: db2,
        pagamentoRepository: new PagamentoRepositoryPostgres(db2),
      };
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 ? f.read() : readPixStatus(other, f.payment, f.payment.intencao.externalRef ?? ''),
        ),
      );
      expect(f.consult).toHaveBeenCalledOnce();
      f.advance(59_999);
      await f.read();
      expect(f.consult).toHaveBeenCalledOnce();
      f.advance(1);
      await f.read();
      expect(f.consult).toHaveBeenCalledTimes(2);
      expect(f.log).toHaveBeenCalledWith(
        'pix.status.provider_read',
        expect.objectContaining({ paymentId: f.payment.id, callCount: 1, outcome: 'ativa' }),
      );
      const row = await testDb.db
        .selectFrom('pagamentos')
        .select('pix_reconciliacao_claimed_until')
        .where('id', '=', f.payment.id)
        .executeTakeFirstOrThrow();
      expect(row.pix_reconciliacao_claimed_until).toBeNull();
    } finally {
      await db2.destroy();
    }
  });

  it('approved DB state avoids provider HTTP, including a stale poll snapshot racing webhook', async () => {
    const f = await fixture();
    f.advance(61_000);
    await f.deps.pagamentoRepository.update({ ...f.payment, status: 'aprovado' } as never);
    await expect(f.read()).resolves.toEqual({ status: 'confirmado' });
    await expect(
      readPixStatus(f.deps, f.payment, f.payment.intencao.externalRef ?? ''),
    ).resolves.toEqual({ status: 'confirmado' });
    expect(f.consult).not.toHaveBeenCalled();
  });

  it('real webhook HTTP confirms in PG; subsequent status polls make zero provider GETs', async () => {
    const f = await fixture();
    f.advance(61_000);
    const domain = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const item = f.payment.intencao.items.find((item) => item.tipo === 'contribuicao');
    if (!item || item.tipo !== 'contribuicao') throw new Error('fixture item');
    const idCampanha = f.payment.intencao.idCampanha;
    const idOpcao = randomUUID();
    const common = { ...domain, clock: f.deps.clock, observability: f.deps.observability };
    await criarCampanha(common, {
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [randomUUID()],
      dadosRecebedor: {
        metodo: 'pix',
        nomeTitular: 'Synthetic Receiver',
        cpfTitular: '52998224725',
        tipoChavePix: 'email',
        chavePix: 'receiver@example.test',
      },
      titulo: 'Synthetic webhook',
    });
    await adicionarOpcaoContribuicao(common, { idCampanha, idOpcao, tipo: 'presente' });
    await criarContribuicao(
      { ...common, contribuicaoRepository },
      {
        id: item.idContribuicao,
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        nome: 'Synthetic gift',
        valor: 8000,
      },
    );
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    f.consult.mockResolvedValue({
      status: 'concluida',
      e2eId: 'E'.repeat(32),
      valorPagoCents: 8400 as never,
      horario: f.deps.clock(),
    });
    const app = new Hono();
    mountInterPixWebhookRoutes(
      app,
      {
        ...f.deps,
        ...domain,
        contribuicaoRepository,
        livroFinanceiroRepository,
        webhookEventArchive: new WebhookEventArchiveMemory(f.deps.clock),
        pagamentoEventPublisher: { publish: async () => {} },
        trustedHopCount: 0,
        logPiiHashSalt: 'synthetic-test-salt-thirty-two-chars',
      } as unknown as InterPixWebhookDeps,
      { consumeRateLimit: async () => ({ allowed: true, count: 1, max: 600, windowMs: 60_000 }) },
    );
    const response = await app.request('/api/webhooks/inter/pix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pix: [{ txid: f.payment.intencao.externalRef, endToEndId: 'E'.repeat(32) }],
      }),
    });
    expect(response.status).toBe(200);
    expect((await f.deps.pagamentoRepository.findById(f.payment.id))?.status).toBe('aprovado');
    expect(await livroFinanceiroRepository.findLancamentosByIdPagamento(f.payment.id)).toHaveLength(
      2,
    );
    f.consult.mockClear();
    expect(await Promise.all(Array.from({ length: 20 }, () => f.read()))).toEqual(
      Array.from({ length: 20 }, () => ({ status: 'confirmado' })),
    );
    expect(f.consult).not.toHaveBeenCalled();
  });

  it('starts the grace period at latest local payment update, not an old reservation', async () => {
    const f = await fixture();
    await testDb.db
      .updateTable('pagamentos')
      .set({ criado_em: new Date(f.deps.clock().getTime() - 3600_000) })
      .where('id', '=', f.payment.id)
      .execute();
    await expect(f.read()).resolves.toEqual({ status: 'pendente' });
    expect(f.consult).not.toHaveBeenCalled();
  });

  it('webhook wins even if provider GET fails while the webhook commits', async () => {
    const f = await fixture();
    f.advance(61_000);
    f.consult.mockImplementation(async () => {
      await f.deps.pagamentoRepository.update({ ...f.payment, status: 'aprovado' } as never);
      throw new Error('provider timeout');
    });
    await expect(f.read()).resolves.toEqual({ status: 'confirmado' });
    expect(f.consult).toHaveBeenCalledOnce();
  });

  it.each([
    'concluida',
    'removida',
  ] as const)('fallback %s is display-only and never settles PG', async (status) => {
    const f = await fixture();
    f.advance(61_000);
    f.consult.mockResolvedValue(
      status === 'removida'
        ? { status }
        : { status, e2eId: 'E'.repeat(32), valorPagoCents: 8400 as never, horario: f.deps.clock() },
    );
    await expect(f.read()).resolves.toEqual({
      status: status === 'concluida' ? 'confirmado' : 'expirado',
    });
    expect((await f.deps.pagamentoRepository.findById(f.payment.id))?.status).toBe('pendente');
  });

  it('Stripe rollback binding never calls the Inter adapter', async () => {
    const f = await fixture();
    f.advance(3600_000);
    await expect(
      readPixStatus(
        { ...f.deps, cobrancaPixProviderKind: 'stripe' },
        f.payment,
        f.payment.intencao.externalRef ?? '',
      ),
    ).resolves.toEqual({ status: 'pendente' });
    expect(f.consult).not.toHaveBeenCalled();
  });

  it('provider errors consume the minute and emit no raw response in the log', async () => {
    const f = await fixture();
    f.advance(61_000);
    f.consult.mockRejectedValue(new Error('SECRET_PROVIDER_PAYLOAD'));
    await expect(f.read()).resolves.toEqual({ status: 'pendente', retryableError: true });
    await Promise.all(Array.from({ length: 15 }, () => f.read()));
    expect(f.consult).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('SECRET_PROVIDER_PAYLOAD');
  });
});
