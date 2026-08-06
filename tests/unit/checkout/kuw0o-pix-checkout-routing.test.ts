import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { PixCobrancaProviderFake } from '../../../src/adapters/pagamentos/pix-cobranca-provider.fake.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
import type { IdPagamento } from '../../../src/domain/pagamentos/value-objects/ids.js';
import { PagamentosInputInvalidoError } from '../../../src/errors/pagamentos/input-invalido.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';
import {
  type CobrancaPixProviderKind,
  iniciarPagamentoCarrinho,
} from '../../../src/use-cases/checkout/iniciar-pagamento-carrinho.js';
import { createArrecadacaoMemoryRepos } from '../../helpers/arrecadacao-repos.js';

/**
 * PIX-cobrança routing in iniciarPagamentoCarrinho (aperture-kuw0o).
 *
 * Locks the branch decision added by spec §4.3: `metodo === 'pix'` AND
 * `cobrancaPixProviderKind ∈ {'inter', 'fake'}` routes checkout through
 * the PixCobrancaProvider (→ `tipo: 'pix_qr'`); everything else stays on
 * the untouched Stripe path (→ `tipo: 'stripe_embedded'`). Also locks:
 *
 *   1. PIX branch persistence — intencao.externalRef = txid and the
 *      contribuinte is stamped atomically at creation.
 *   2. PIX branch REQUIRES contribuinte (our form collects it; Inter's
 *      cob API collects nothing) → PagamentosInputInvalidoError.
 *   3. kind='stripe' keeps metodo='pix' on the Stripe path with
 *      contribuinte NULL (Stripe stamps it at finalize).
 *   4. metodo='credit_card' never enters the PIX branch, even with a
 *      PIX-capable kind bound.
 *   5. The kind allowlist — not the concrete adapter instance — decides
 *      routing ('inter' with a fake instance still routes to PIX).
 *
 * Pure in-memory unit — no Postgres. Harness mirrors
 * tests/unit/checkout/carrinho-cross-campanha-guard.test.ts.
 */

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const contribuinte = { nome: 'Ana', email: 'ana@e2e.local', mensagem: 'com amor' };

const dadosRecebedorPadrao = () => ({
  metodo: 'pix' as const,
  nomeTitular: 'Maria Silva',
  cpfTitular: '52998224725',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
});

function makeDeps(cobrancaPixProviderKind: CobrancaPixProviderKind) {
  const { campanhaRepository, recebedorRepository, plataformaRepository } =
    createArrecadacaoMemoryRepos();
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const checkoutSessionProvider = new PagamentoProviderFake({ statusResultado: 'aprovado', clock });
  const pixCobrancaProvider = new PixCobrancaProviderFake({ clock });

  return {
    campanhaRepository,
    recebedorRepository,
    plataformaRepository,
    contribuicaoRepository,
    provedorRegraTaxa,
    pagamentoRepository,
    pagamentoEventPublisher,
    checkoutSessionProvider,
    pixCobrancaProvider,
    cobrancaPixProviderKind,
    clock,
    observability: silentObservability,
  };
}

type Deps = ReturnType<typeof makeDeps>;

/**
 * Seeds a campanha (on plataforma EUNENEM) with a single 'presente'
 * contribuição, via the real use-cases so the saga's repository reads
 * resolve. Returns the ids the saga needs.
 */
async function seedCampanhaComContribuicao(deps: Deps, titulo: string) {
  const idCampanha = randomUUID();
  const idOpcao = randomUUID();
  const idContribuicao = randomUUID();

  await criarCampanha(
    {
      campanhaRepository: deps.campanhaRepository,
      recebedorRepository: deps.recebedorRepository,
      plataformaRepository: deps.plataformaRepository,
      clock,
      observability: silentObservability,
    },
    {
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [randomUUID()],
      dadosRecebedor: dadosRecebedorPadrao(),
      titulo,
    },
  );
  await adicionarOpcaoContribuicao(
    { campanhaRepository: deps.campanhaRepository, observability: silentObservability },
    { idCampanha, idOpcao, tipo: 'presente' },
  );
  await criarContribuicao(
    {
      campanhaRepository: deps.campanhaRepository,
      contribuicaoRepository: deps.contribuicaoRepository,
      clock,
      observability: silentObservability,
    },
    { id: idContribuicao, idCampanha, idOpcaoContribuicao: idOpcao, nome: 'Fralda', valor: 8000 },
  );

  return { idCampanha, idOpcao, idContribuicao };
}

const baseInput = () => ({
  idPlataforma: ID_PLATAFORMA_EUNENEM,
  idPagamento: randomUUID(),
  idIntencaoPagamento: randomUUID(),
  returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
});

describe('iniciarPagamentoCarrinho — PIX-cobrança routing (aperture-kuw0o)', () => {
  it("metodo='pix' + kind='fake' + contribuinte → pix_qr, persists txid as externalRef + contribuinte, skips checkoutSessionProvider", async () => {
    const deps = makeDeps('fake');
    const a = await seedCampanhaComContribuicao(deps, 'Campanha A');
    const sessaoSpy = vi.spyOn(deps.checkoutSessionProvider, 'criarSessaoCheckout');

    const result = await iniciarPagamentoCarrinho(deps, {
      ...baseInput(),
      idCampanha: a.idCampanha,
      metodo: 'pix',
      itens: [{ idContribuicao: a.idContribuicao, quantidade: 1 }],
      idsItens: [randomUUID()],
      contribuinte,
    });

    expect(result.tipo).toBe('pix_qr');
    if (result.tipo !== 'pix_qr') throw new Error('unreachable — narrowing for TS');
    expect(result.txid).not.toBe('');
    expect(result.pixCopiaECola).not.toBe('');
    expect(result.expiraEm).toBeInstanceOf(Date);

    const persisted = await deps.pagamentoRepository.findById(result.pagamento.id);
    expect(persisted).toBeDefined();
    expect(persisted?.intencao.externalRef).toBe(result.txid);
    expect(persisted?.intencao.contribuinte).toEqual(contribuinte);
    // B4 contract (aperture-fpd0j): the provider's AUTHORITATIVE expiry is
    // persisted at creation — the reconciliation poller selects on it.
    expect(persisted?.intencao.expiraEm).toEqual(result.expiraEm);

    expect(sessaoSpy).not.toHaveBeenCalled();
  });

  it("metodo='pix' + kind='fake' WITHOUT contribuinte → PagamentosInputInvalidoError, nothing persisted", async () => {
    const deps = makeDeps('fake');
    const a = await seedCampanhaComContribuicao(deps, 'Campanha A');
    const idPagamento = randomUUID();

    await expect(
      iniciarPagamentoCarrinho(deps, {
        ...baseInput(),
        idPagamento,
        idCampanha: a.idCampanha,
        metodo: 'pix',
        itens: [{ idContribuicao: a.idContribuicao, quantidade: 1 }],
        idsItens: [randomUUID()],
      }),
    ).rejects.toBeInstanceOf(PagamentosInputInvalidoError);

    await expect(
      deps.pagamentoRepository.findById(idPagamento as IdPagamento),
    ).resolves.toBeUndefined();
  });

  it("metodo='pix' + kind='stripe' → stripe_embedded, pixCobrancaProvider untouched, contribuinte NULL (Stripe stamps at finalize)", async () => {
    const deps = makeDeps('stripe');
    const a = await seedCampanhaComContribuicao(deps, 'Campanha A');

    // contribuinte is supplied but the Stripe branch must NOT stamp it —
    // finalization is the only writer on that path.
    const result = await iniciarPagamentoCarrinho(deps, {
      ...baseInput(),
      idCampanha: a.idCampanha,
      metodo: 'pix',
      itens: [{ idContribuicao: a.idContribuicao, quantidade: 1 }],
      idsItens: [randomUUID()],
      contribuinte,
    });

    expect(result.tipo).toBe('stripe_embedded');
    if (result.tipo !== 'stripe_embedded') throw new Error('unreachable — narrowing for TS');
    expect(result.sessionId).not.toBe('');
    expect(result.clientSecret).not.toBe('');

    expect(deps.pixCobrancaProvider.criarCobrancaCalls).toBe(0);

    const persisted = await deps.pagamentoRepository.findById(result.pagamento.id);
    expect(persisted?.intencao.contribuinte).toBeNull();
  });

  it("metodo='credit_card' + kind='fake' → stripe_embedded (metodo gate holds)", async () => {
    const deps = makeDeps('fake');
    const a = await seedCampanhaComContribuicao(deps, 'Campanha A');

    const result = await iniciarPagamentoCarrinho(deps, {
      ...baseInput(),
      idCampanha: a.idCampanha,
      metodo: 'credit_card',
      itens: [{ idContribuicao: a.idContribuicao, quantidade: 1 }],
      // credit_card adds a passthrough-surcharge item → one EXTRA id.
      idsItens: [randomUUID(), randomUUID()],
    });

    expect(result.tipo).toBe('stripe_embedded');
  });

  it("kind='inter' with a fake provider instance still routes to pix_qr (the kind allowlist decides, not the adapter)", async () => {
    const deps = makeDeps('inter');
    const a = await seedCampanhaComContribuicao(deps, 'Campanha A');

    const result = await iniciarPagamentoCarrinho(deps, {
      ...baseInput(),
      idCampanha: a.idCampanha,
      metodo: 'pix',
      itens: [{ idContribuicao: a.idContribuicao, quantidade: 1 }],
      idsItens: [randomUUID()],
      contribuinte,
    });

    expect(result.tipo).toBe('pix_qr');
  });
});
