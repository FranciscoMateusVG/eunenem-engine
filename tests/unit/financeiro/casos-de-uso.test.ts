import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import type { LancamentoFinanceiro } from '../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import { FinanceiroInputInvalidoError } from '../../../src/errors/pagamentos/financeiro/input-invalido.error.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../../src/errors/pagamentos/financeiro/pagamento-ja-registrado.error.js';
import { FinanceiroPagamentoNaoAprovadoError } from '../../../src/errors/pagamentos/financeiro/pagamento-nao-aprovado.error.js';
import { FinanceiroSaldoDisponivelInsuficienteError } from '../../../src/errors/pagamentos/financeiro/saldo-disponivel-insuficiente.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { obterReceitaPlataforma } from '../../../src/use-cases/pagamentos/financeiro/obter-receita-plataforma.js';
import { obterSaldoRecebedor } from '../../../src/use-cases/pagamentos/financeiro/obter-saldo-recebedor.js';
import type { RegistrarEfeitosFinanceirosPagamentoAprovadoInput } from '../../../src/use-cases/pagamentos/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
import { registrarEfeitosFinanceirosPagamentoAprovado } from '../../../src/use-cases/pagamentos/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
import { solicitarRepasseRecebedor } from '../../../src/use-cases/pagamentos/financeiro/solicitar-repasse-recebedor.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const idPagamento = '550e8400-e29b-41d4-a716-446655443001';
const idContribuicao = '550e8400-e29b-41d4-a716-446655443002';
const idCampanha = '550e8400-e29b-41d4-a716-446655443003';
const idRepasse = '550e8400-e29b-41d4-a716-446655443004';
const idItemContribuicao = '550e8400-e29b-41d4-a716-446655443020';

function makeApprovedPaymentInput(
  overrides: Partial<RegistrarEfeitosFinanceirosPagamentoAprovadoInput> = {},
): RegistrarEfeitosFinanceirosPagamentoAprovadoInput {
  // Plan 0015 (aperture-ucgok): input schema dropped `metodo` along with
  // the maturação calculation — Lançamentos born with
  // `transferidoEm: null, canceladoEm: null`.
  // Plan 0016 Phase 2 (aperture-eg1s2): multi-item cart shape — root
  // `idContribuicao` + `composicaoValores` replaced by `items[]` +
  // `idContribuicaoAnchor`.
  return {
    idPagamento,
    idContribuicaoAnchor: idContribuicao,
    idCampanha,
    statusPagamento: 'aprovado',
    items: [
      {
        idItemPagamento: idItemContribuicao,
        composicaoValoresItem: {
          tipo: 'contribuicao',
          idContribuicao,
          quantidade: 1,
          contributionUnitAmountCents: 8000,
          feeUnitAmountCents: 400,
          receiverUnitAmountCents: 8000,
          lineContributionAmountCents: 8000,
          lineFeeAmountCents: 400,
          lineReceiverAmountCents: 8000,
        },
      },
    ],
    ...overrides,
  };
}

describe('financial use cases', () => {
  it('registers financial effects for the canonical approved payment flow', async () => {
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

    const lancamentos = await registrarEfeitosFinanceirosPagamentoAprovado(
      { livroFinanceiroRepository, clock, observability: silentObservability },
      makeApprovedPaymentInput(),
    );
    const saldoRecebedor = await obterSaldoRecebedor(
      { livroFinanceiroRepository, observability: silentObservability },
      { idCampanha },
    );
    const receitaPlataforma = await obterReceitaPlataforma({
      livroFinanceiroRepository,
      observability: silentObservability,
    });

    expect(lancamentos).toHaveLength(2);
    expect(lancamentos.map((l) => l.tipo)).toEqual([
      'credito_saldo_recebedor',
      'credito_receita_plataforma',
    ]);
    expect(saldoRecebedor).toEqual({
      idCampanha,
      valorPendenteCents: 8000,
      valorDisponivelCents: 0,
    });
    expect(receitaPlataforma).toEqual({ totalAmountCents: 400 });
  });

  it('does not register financial effects twice for the same payment', async () => {
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    const deps = { livroFinanceiroRepository, clock, observability: silentObservability };

    await registrarEfeitosFinanceirosPagamentoAprovado(deps, makeApprovedPaymentInput());

    await expect(
      registrarEfeitosFinanceirosPagamentoAprovado(deps, makeApprovedPaymentInput()),
    ).rejects.toThrow(FinanceiroPagamentoJaRegistradoError);
  });

  it('does not register financial effects for a non-approved payment', async () => {
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

    await expect(
      registrarEfeitosFinanceirosPagamentoAprovado(
        { livroFinanceiroRepository, clock, observability: silentObservability },
        makeApprovedPaymentInput({ statusPagamento: 'rejeitado' }),
      ),
    ).rejects.toThrow(FinanceiroPagamentoNaoAprovadoError);
  });

  it('rejects inconsistent per-item value composition as invalid financial input', async () => {
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

    // Plan 0016 Phase 2: validation moved to per-item — `line` must equal
    // `unit × quantidade`. Build an item whose lineContribution is wrong.
    await expect(
      registrarEfeitosFinanceirosPagamentoAprovado(
        { livroFinanceiroRepository, clock, observability: silentObservability },
        makeApprovedPaymentInput({
          items: [
            {
              idItemPagamento: idItemContribuicao,
              composicaoValoresItem: {
                tipo: 'contribuicao',
                idContribuicao,
                quantidade: 1,
                contributionUnitAmountCents: 8000,
                feeUnitAmountCents: 400,
                receiverUnitAmountCents: 8000,
                // Intentionally wrong: should be 8000.
                lineContributionAmountCents: 7900,
                lineFeeAmountCents: 400,
                lineReceiverAmountCents: 8000,
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow(FinanceiroInputInvalidoError);
  });

  it('creates an initial payout request sweeping every disponivel lancamento (aperture-s03dr)', async () => {
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    // aperture-s03dr: "disponivel for solicitação" is now the predicate
    // `transferidoEm IS NULL && canceladoEm IS NULL && idRepasse IS NULL`
    // PLUS (parent pagamento.status='aprovado' && availableOn <= now).
    // Without an injected PagamentoRepository the memory adapter
    // degrades to "trust everything that passes the lancamento-side
    // predicate" — good for this unit test.
    const eligibleEntry: LancamentoFinanceiro = {
      id: '550e8400-e29b-41d4-a716-446655443005',
      idPagamento: '550e8400-e29b-41d4-a716-446655443006',
      idContribuicao: '550e8400-e29b-41d4-a716-446655443007',
      idCampanha,
      tipo: 'credito_saldo_recebedor',
      amountCents: 5000,
      criadoEm: fixedDate,
      transferidoEm: null,
      canceladoEm: null,
      idRepasse: null,
    };
    await livroFinanceiroRepository.saveLancamentos([eligibleEntry]);

    const repasse = await solicitarRepasseRecebedor(
      { livroFinanceiroRepository, clock, observability: silentObservability },
      { idRepasse, idCampanha },
    );

    // The sweep claims the full eligible set; amountCents = SUM.
    expect(repasse).toEqual({
      id: idRepasse,
      idCampanha,
      amountCents: 5000,
      status: 'solicitado',
      solicitadoEm: fixedDate,
      aprovadoEm: null,
      bankTransferRef: null,
    });
    expect(await livroFinanceiroRepository.findRepasseById(idRepasse)).toEqual(repasse);
    // The eligible lancamento now carries idRepasse linkage.
    const lancamentoAposClaim = (
      await livroFinanceiroRepository.findLancamentosByIdPagamento(eligibleEntry.idPagamento)
    )[0];
    expect(lancamentoAposClaim?.idRepasse).toBe(idRepasse);
  });

  it('does not create a payout request when the eligible set is empty (aperture-s03dr)', async () => {
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

    await expect(
      solicitarRepasseRecebedor(
        { livroFinanceiroRepository, clock, observability: silentObservability },
        { idRepasse, idCampanha },
      ),
    ).rejects.toThrow(FinanceiroSaldoDisponivelInsuficienteError);
  });
});
