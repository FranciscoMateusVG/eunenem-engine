import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
import { criarPagamentoPendente } from '../../../src/domain/pagamentos/entities/pagamento.js';
import { ArrecadacaoContribuicaoNaoDisponivelError } from '../../../src/errors/arrecadacao/contribuicao-nao-disponivel.error.js';
import { CheckoutPlataformaMismatchError } from '../../../src/errors/checkout/plataforma-mismatch.error.js';
import { PagamentoJaExisteError } from '../../../src/errors/pagamentos/ja-existe.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { associarContribuinteContribuicao } from '../../../src/use-cases/arrecadacao/associar-contribuinte-contribuicao.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { iniciarPagamentoContribuicao } from '../../../src/use-cases/checkout/iniciar-pagamento-contribuicao.js';
import { createArrecadacaoMemoryRepos } from '../../helpers/arrecadacao-repos.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const dadosRecebedorPadrao = () => ({
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
});

const contribuinteValido = () => ({
  nome: 'Joao Visitante',
  email: 'joao@exemplo.com',
});

const TEST_RETURN_URL = 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}';

async function seedCheckoutCenario(idPlataforma: string, tipoOpcao: 'presente' | 'rifa') {
  const repos = createArrecadacaoMemoryRepos();
  const { campanhaRepository, recebedorRepository, plataformaRepository } = repos;
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const checkoutSessionProvider = new PagamentoProviderFake();

  const idCampanha = randomUUID();
  const idOpcao = randomUUID();
  const idContribuicao = randomUUID();

  await criarCampanha(
    {
      campanhaRepository,
      recebedorRepository,
      plataformaRepository,
      clock,
      observability: silentObservability,
    },
    {
      id: idCampanha,
      idPlataforma,
      idsAdministradores: [randomUUID()],
      dadosRecebedor: dadosRecebedorPadrao(),
      titulo: 'Campanha Checkout',
    },
  );
  await adicionarOpcaoContribuicao(
    { campanhaRepository, observability: silentObservability },
    { idCampanha, idOpcao, tipo: tipoOpcao },
  );
  await criarContribuicao(
    { campanhaRepository, contribuicaoRepository, clock, observability: silentObservability },
    {
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao: idOpcao,
      nome: 'Fralda',
      valor: 8000,
    },
  );

  return {
    deps: {
      campanhaRepository,
      contribuicaoRepository,
      provedorRegraTaxa,
      pagamentoRepository,
      pagamentoEventPublisher,
      checkoutSessionProvider,
      clock,
      observability: silentObservability,
    },
    idCampanha,
    idOpcao,
    idContribuicao,
  };
}

describe('iniciarPagamentoContribuicao — happy path', () => {
  it('leaves contribuição disponivel, computes plataforma-scoped composição, creates pagamento pendente (eunenem presente, 5%)', async () => {
    // aperture-m95f3: the saga no longer claims the contribuição — claim
    // happens later in finalizarPagamentoAprovado via the webhook. Visitor
    // identity is collected by Stripe inside the iframe, so no contribuinte
    // input here either.
    const { deps, idCampanha, idContribuicao } = await seedCheckoutCenario(
      ID_PLATAFORMA_EUNENEM,
      'presente',
    );

    const idPagamento = randomUUID();
    const idIntencaoPagamento = randomUUID();

    const { contribuicao, pagamento } = await iniciarPagamentoContribuicao(deps, {
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idCampanha,
      idContribuicao,
      metodo: 'pix',
      idPagamento,
      idIntencaoPagamento,
      returnUrl: TEST_RETURN_URL,
    });

    expect(contribuicao.id).toBe(idContribuicao);
    expect(contribuicao.status).toBe('disponivel');
    expect(contribuicao.contribuinte).toBeNull();

    expect(pagamento.id).toBe(idPagamento);
    expect(pagamento.status).toBe('pendente');
    expect(pagamento.intencao.amountCents).toBe(8400);
    expect(pagamento.intencao.composicaoValores).toMatchObject({
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      totalPaidCents: 8400,
    });
  });

  it('locks in the eucasei 8% rifa price (R$80 + R$6.40 = R$86.40)', async () => {
    const { deps, idCampanha, idContribuicao } = await seedCheckoutCenario(
      ID_PLATAFORMA_EUCASEI,
      'rifa',
    );

    const { pagamento } = await iniciarPagamentoContribuicao(deps, {
      idPlataforma: ID_PLATAFORMA_EUCASEI,
      idCampanha,
      idContribuicao,
      metodo: 'pix',
      idPagamento: randomUUID(),
      idIntencaoPagamento: randomUUID(),
      returnUrl: TEST_RETURN_URL,
    });

    expect(pagamento.intencao.amountCents).toBe(8640);
    expect(pagamento.intencao.composicaoValores).toMatchObject({
      feeAmountCents: 640,
      totalPaidCents: 8640,
    });
  });
});

describe('iniciarPagamentoContribuicao — cross-tenant guard', () => {
  it('rejects with CheckoutPlataformaMismatchError when input plataforma differs from campanha plataforma, BEFORE any write', async () => {
    const { deps, idCampanha, idContribuicao } = await seedCheckoutCenario(
      ID_PLATAFORMA_EUNENEM,
      'presente',
    );

    await expect(
      iniciarPagamentoContribuicao(deps, {
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        idCampanha,
        idContribuicao,
        metodo: 'pix',
        idPagamento: randomUUID(),
        idIntencaoPagamento: randomUUID(),
        returnUrl: TEST_RETURN_URL,
      }),
    ).rejects.toThrow(CheckoutPlataformaMismatchError);

    // contribuição untouched — no side effect from a cross-tenant attempt
    const contribuicao = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicao?.status).toBe('disponivel');
    expect(contribuicao?.contribuinte).toBeNull();
  });
});

describe('iniciarPagamentoContribuicao — failure paths leave contribuição untouched', () => {
  it('contribuição stays disponivel when criarIntencaoPagamento fails (idPagamento collision)', async () => {
    // aperture-m95f3: saga never claims the contribuição (claim moves to
    // finalize via webhook). Failures in later saga steps therefore have
    // nothing to compensate — verify the contribuição is untouched.
    const { deps, idCampanha, idContribuicao } = await seedCheckoutCenario(
      ID_PLATAFORMA_EUNENEM,
      'presente',
    );

    // pre-seed a Pagamento with the idPagamento we'll try to use, so step 5 throws
    const idPagamento = randomUUID();
    await deps.pagamentoRepository.save(
      criarPagamentoPendente({
        idPagamento,
        idIntencaoPagamento: randomUUID(),
        composicaoValores: {
          idContribuicao: randomUUID(),
          contributionAmountCents: 1000,
          feeAmountCents: 50,
          totalPaidCents: 1050,
          receiverAmountCents: 1000,
          responsavelTaxa: 'contribuinte',
        },
        valorACobrarCents: 1050,
        metodo: 'pix',
        criadoEm: fixedDate,
      }),
    );

    await expect(
      iniciarPagamentoContribuicao(deps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idContribuicao,
        metodo: 'pix',
        idPagamento, // collides with the pre-seeded pagamento
        idIntencaoPagamento: randomUUID(),
        returnUrl: TEST_RETURN_URL,
      }),
    ).rejects.toThrow(PagamentoJaExisteError);

    // nothing to revert — saga never wrote to the contribuição
    const contribuicao = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicao?.status).toBe('disponivel');
    expect(contribuicao?.contribuinte).toBeNull();
  });

  it('early-fails with ArrecadacaoContribuicaoNaoDisponivelError when contribuição is already claimed (step 2 read-only check)', async () => {
    // aperture-m95f3 rephrase: the saga's new step 2 reads the contribuição
    // and refuses to mount a Stripe iframe for a gift already claimed by
    // someone else's webhook. UX win — visitor doesn't pay for something
    // they can't keep. Webhook finalize still owns the correctness race.
    const { deps, idCampanha, idContribuicao } = await seedCheckoutCenario(
      ID_PLATAFORMA_EUNENEM,
      'presente',
    );

    // simulate an earlier visitor's webhook having claimed the contribuição
    await associarContribuinteContribuicao(
      { contribuicaoRepository: deps.contribuicaoRepository, observability: silentObservability },
      { idContribuicao, contribuinte: contribuinteValido() },
    );

    // a new visitor attempting to mount checkout is refused at session-create
    await expect(
      iniciarPagamentoContribuicao(deps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idContribuicao,
        metodo: 'pix',
        idPagamento: randomUUID(),
        idIntencaoPagamento: randomUUID(),
        returnUrl: TEST_RETURN_URL,
      }),
    ).rejects.toThrow(ArrecadacaoContribuicaoNaoDisponivelError);

    // contribuição still belongs to the original claimant — untouched
    const contribuicao = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicao?.status).toBe('indisponivel');
    expect(contribuicao?.contribuinte).toEqual(contribuinteValido());
  });
});
