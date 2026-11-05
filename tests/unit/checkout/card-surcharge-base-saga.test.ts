import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { computeCardSurchargeCents } from '../../../src/adapters/pagamentos/card-surcharge.js';
import { CheckoutOperationRepositoryMemory } from '../../../src/adapters/pagamentos/checkout-operation-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { PixCobrancaProviderFake } from '../../../src/adapters/pagamentos/pix-cobranca-provider.fake.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
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
async function seedCampanha(
  deps: Deps,
  gifts: ReadonlyArray<{ valor: number; quantidade?: number }>,
) {
  const idCampanha = randomUUID();
  const idOpcao = randomUUID();

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
      titulo: 'Campanha',
    },
  );
  await adicionarOpcaoContribuicao(
    { campanhaRepository: deps.campanhaRepository, observability: silentObservability },
    { idCampanha, idOpcao, tipo: 'presente' },
  );
  const ids: string[] = [];
  for (const [n, g] of gifts.entries()) {
    const id = randomUUID();
    ids.push(id);
    await criarContribuicao(
      {
        campanhaRepository: deps.campanhaRepository,
        contribuicaoRepository: deps.contribuicaoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id,
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        nome: `Presente ${n}`,
        valor: g.valor,
        ...(g.quantidade ? { quantidade: g.quantidade } : {}),
      },
    );
  }
  return { idCampanha, ids };
}

const access = { capability: 'A'.repeat(43) };

function cartaoInput(
  idCampanha: string,
  itens: Array<{ idContribuicao: string; quantidade: number }>,
) {
  return {
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    metodo: 'credit_card' as const,
    idPagamento: randomUUID(),
    idIntencaoPagamento: randomUUID(),
    returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
    idCampanha,
    itens,
    idsItens: [...itens.map(() => randomUUID()), randomUUID()],
  };
}

describe('iniciarPagamentoCarrinho — card surcharge base is gift + EuNeném fee', () => {
  it('R$200 gift: fee 1796, surcharge 926, total paid 22722', async () => {
    const deps = makeDeps();
    const { idCampanha, ids } = await seedCampanha(deps, [{ valor: 20000 }]);
    const input = cartaoInput(idCampanha, [{ idContribuicao: ids[0] as string, quantidade: 1 }]);
    await prepararPagamentoCarrinho(deps, input, access);
    const result = await iniciarPagamentoCarrinho(deps, input, access);
    const agg = result.pagamento.intencao.composicaoValoresAggregate;
    expect(agg.totalFeeCents).toBe(1796);
    expect(agg.totalSurchargeCents).toBe(926);
    expect(agg.totalPaidCents).toBe(22722);
  });

  it('multi-item cart: surcharge charged once on the whole cart, matching what the guest sees', async () => {
    const deps = makeDeps();
    const { idCampanha, ids } = await seedCampanha(deps, [
      { valor: 5000 },
      { valor: 3333, quantidade: 3 },
    ]);
    const input = cartaoInput(idCampanha, [
      { idContribuicao: ids[0] as string, quantidade: 1 },
      { idContribuicao: ids[1] as string, quantidade: 2 },
    ]);
    await prepararPagamentoCarrinho(deps, input, access);
    const result = await iniciarPagamentoCarrinho(deps, input, access);
    const agg = result.pagamento.intencao.composicaoValoresAggregate;
    // Same formula revalidarCarrinho / cart.tsx use for what the guest sees.
    const totalPix = agg.totalContributionCents + agg.totalFeeCents;
    expect(agg.totalSurchargeCents).toBe(computeCardSurchargeCents(totalPix as never));
    expect(agg.totalPaidCents).toBe(totalPix + agg.totalSurchargeCents);
  });
});
