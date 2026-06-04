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

function makeApprovedPaymentInput(
  overrides: Partial<RegistrarEfeitosFinanceirosPagamentoAprovadoInput> = {},
): RegistrarEfeitosFinanceirosPagamentoAprovadoInput {
  // Plan 0015 (aperture-ucgok): input schema dropped `metodo` along with
  // the maturação calculation — `EfeitosFinanceirosPagamentoAprovado` no
  // longer needs it. Lancamentos are born with
  // `transferidoEm: null, canceladoEm: null`.
  return {
    idPagamento,
    idContribuicao,
    idCampanha,
    statusPagamento: 'aprovado',
    composicaoValores: {
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      surchargeCents: 0,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      responsavelTaxa: 'contribuinte',
    },
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

  it('rejects inconsistent value composition as invalid financial input', async () => {
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

    await expect(
      registrarEfeitosFinanceirosPagamentoAprovado(
        { livroFinanceiroRepository, clock, observability: silentObservability },
        makeApprovedPaymentInput({
          composicaoValores: {
            contributionAmountCents: 8000,
            feeAmountCents: 400,
            totalPaidCents: 8300,
            receiverAmountCents: 8000,
            responsavelTaxa: 'contribuinte',
          },
        }),
      ),
    ).rejects.toThrow(FinanceiroInputInvalidoError);
  });

  it('creates an initial payout request when the receiver has available balance', async () => {
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    // Plan 0015 (aperture-ucgok): the "disponivel" (transferred) state on
    // a lancamento is now `transferidoEm !== null AND canceladoEm === null`.
    // Stamp transferidoEm so this row counts toward `valorDisponivelCents`.
    const availableEntry: LancamentoFinanceiro = {
      id: '550e8400-e29b-41d4-a716-446655443005',
      idPagamento: '550e8400-e29b-41d4-a716-446655443006',
      idContribuicao: '550e8400-e29b-41d4-a716-446655443007',
      idCampanha,
      tipo: 'credito_saldo_recebedor',
      amountCents: 5000,
      criadoEm: fixedDate,
      transferidoEm: fixedDate,
      canceladoEm: null,
    };
    await livroFinanceiroRepository.saveLancamentos([availableEntry]);

    const repasse = await solicitarRepasseRecebedor(
      { livroFinanceiroRepository, clock, observability: silentObservability },
      {
        idRepasse,
        idCampanha,
        amountCents: 3000,
      },
    );

    expect(repasse).toEqual({
      id: idRepasse,
      idCampanha,
      amountCents: 3000,
      status: 'solicitado',
      solicitadoEm: fixedDate,
    });
    expect(await livroFinanceiroRepository.findRepasseById(idRepasse)).toEqual(repasse);
  });

  it('does not create a payout request above the available balance', async () => {
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

    await expect(
      solicitarRepasseRecebedor(
        { livroFinanceiroRepository, clock, observability: silentObservability },
        {
          idRepasse,
          idCampanha,
          amountCents: 3000,
        },
      ),
    ).rejects.toThrow(FinanceiroSaldoDisponivelInsuficienteError);
  });
});
