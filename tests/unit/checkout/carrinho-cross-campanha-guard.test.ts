import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { CheckoutOperationRepositoryMemory } from '../../../src/adapters/pagamentos/checkout-operation-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { PixCobrancaProviderFake } from '../../../src/adapters/pagamentos/pix-cobranca-provider.fake.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../../src/errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { CarrinhoMultiplasCampanhasError } from '../../../src/errors/checkout/carrinho-multiplas-campanhas.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';
import {
  iniciarPagamentoCarrinho,
  prepararPagamentoCarrinho,
} from '../../../src/use-cases/checkout/iniciar-pagamento-carrinho.js';
import { createArrecadacaoMemoryRepos } from '../../helpers/arrecadacao-repos.js';

/**
 * Cross-campaign payment mis-attribution guard (aperture-to9gu).
 *
 * Locks the two invariants in iniciar-pagamento-carrinho.ts step 2
 * (src/use-cases/checkout/iniciar-pagamento-carrinho.ts:131-150) that
 * are the ONLY thing keeping a checkout claiming campanha A from paying
 * for campanha B's contribuição (gift) — i.e. money + gift/mural entry
 * landing on the WRONG campanha / wrong recebedor:
 *
 *   1. campanhasInCart.size > 1  → CarrinhoMultiplasCampanhasError  (line 144-146)
 *   2. single-campanha cart whose campanha != the claimed idCampanha
 *      → ArrecadacaoContribuicaoNaoEncontradaError                  (line 148-150)
 *
 * Plus a NEGATIVE control: a well-formed single-campanha cart with its
 * own contribuição must SUCCEED — proving the guard is targeted, not a
 * blanket reject.
 *
 * Pure in-memory unit — no Postgres. Harness mirrors
 * tests/unit/checkout/finalizar-pagamento-aprovado.test.ts.
 */

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const dadosRecebedorPadrao = () => ({
  metodo: 'pix' as const,
  nomeTitular: 'Maria Silva',
  cpfTitular: '52998224725',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
});

function makeDeps() {
  const { campanhaRepository, recebedorRepository, plataformaRepository } =
    createArrecadacaoMemoryRepos();
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const checkoutSessionProvider = new PagamentoProviderFake({ statusResultado: 'aprovado', clock });
  const checkoutOperationRepository = new CheckoutOperationRepositoryMemory(pagamentoRepository);

  return {
    campanhaRepository,
    recebedorRepository,
    plataformaRepository,
    contribuicaoRepository,
    provedorRegraTaxa,
    pagamentoRepository,
    pagamentoEventPublisher,
    checkoutSessionProvider,
    checkoutOperationRepository,
    pixCobrancaProvider: new PixCobrancaProviderFake({ clock }),
    cobrancaPixProviderKind: 'stripe' as const,
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
  metodo: 'pix' as const,
  idPagamento: randomUUID(),
  idIntencaoPagamento: randomUUID(),
  returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
});

describe('iniciarPagamentoCarrinho — cross-campaign mis-attribution guard', () => {
  const access = { capability: 'A'.repeat(43) };
  it('rejects a cart whose items reference TWO different campanhas (CarrinhoMultiplasCampanhasError)', async () => {
    const deps = makeDeps();
    const a = await seedCampanhaComContribuicao(deps, 'Campanha A');
    const b = await seedCampanhaComContribuicao(deps, 'Campanha B');

    await expect(
      iniciarPagamentoCarrinho(
        deps,
        {
          ...baseInput(),
          idCampanha: a.idCampanha,
          itens: [
            { idContribuicao: a.idContribuicao, quantidade: 1 },
            { idContribuicao: b.idContribuicao, quantidade: 1 },
          ],
          idsItens: [randomUUID(), randomUUID()],
        },
        access,
      ),
    ).rejects.toBeInstanceOf(CarrinhoMultiplasCampanhasError);
  });

  it('rejects a cart claiming campanha A but referencing a contribuição owned by campanha B (ArrecadacaoContribuicaoNaoEncontradaError)', async () => {
    const deps = makeDeps();
    const a = await seedCampanhaComContribuicao(deps, 'Campanha A');
    const b = await seedCampanhaComContribuicao(deps, 'Campanha B');

    // A single-campanha cart (all items belong to B) whose campanha does
    // NOT match the claimed idCampanha (A). This is the foreign-gift
    // attack: without this guard, B's gift would be paid under A's
    // checkout and credited to A's recebedor.
    await expect(
      iniciarPagamentoCarrinho(
        deps,
        {
          ...baseInput(),
          idCampanha: a.idCampanha,
          itens: [{ idContribuicao: b.idContribuicao, quantidade: 1 }],
          idsItens: [randomUUID()],
        },
        access,
      ),
    ).rejects.toBeInstanceOf(ArrecadacaoContribuicaoNaoEncontradaError);
  });

  it('NEGATIVE control: a well-formed single-campanha cart with its own contribuição SUCCEEDS', async () => {
    const deps = makeDeps();
    const a = await seedCampanhaComContribuicao(deps, 'Campanha A');

    const input = {
      ...baseInput(),
      idCampanha: a.idCampanha,
      itens: [{ idContribuicao: a.idContribuicao, quantidade: 1 }],
      idsItens: [randomUUID()],
    };
    await prepararPagamentoCarrinho(deps, input, access);
    const result = await iniciarPagamentoCarrinho(deps, input, access);

    // Attribution lands on the claimed campanha and its own contribuição.
    expect(result.contribuicoes).toHaveLength(1);
    expect(result.contribuicoes[0]?.id).toBe(a.idContribuicao);
    expect(result.contribuicoes[0]?.idCampanha).toBe(a.idCampanha);
    expect(result.pagamento.intencao.composicaoValoresAggregate.idCampanha).toBe(a.idCampanha);
    expect(result.sessionId).toBeTruthy();
    expect(result.clientSecret).toBeTruthy();
  });
});
