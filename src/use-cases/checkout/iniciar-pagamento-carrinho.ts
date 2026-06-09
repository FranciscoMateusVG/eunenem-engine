import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { CheckoutSessionProvider } from '../../adapters/pagamentos/checkout-session-provider.js';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { ProvedorRegraTaxa } from '../../adapters/taxas/regra-provider.js';
import { encontrarOpcaoContribuicao } from '../../domain/arrecadacao/entities/campanha.js';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  type IdContribuicao,
  IdCampanhaSchema,
  IdContribuicaoSchema,
  IdPlataformaReferenciaSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import {
  criarItemContribuicao,
  criarItemPassthroughSurcharge,
  type ItemDoPagamento,
} from '../../domain/pagamentos/entities/item-do-pagamento.js';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import {
  IdIntencaoPagamentoSchema,
  IdItemDoPagamentoSchema,
  IdPagamentoSchema,
} from '../../domain/pagamentos/value-objects/ids.js';
import { MetodoPagamentoSchema } from '../../domain/pagamentos/value-objects/metodo-pagamento.js';
import type {
  SnapshotComposicaoValoresItem,
  SnapshotComposicaoValoresItemContribuicao,
  SnapshotComposicaoValoresItemSurcharge,
} from '../../domain/pagamentos/value-objects/snapshot-composicao-valores-item.js';
import type { SnapshotComposicaoValoresAggregate } from '../../domain/pagamentos/value-objects/snapshot-composicao-valores-aggregate.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoIndisponivelError } from '../../errors/arrecadacao/contribuicao-indisponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import { CarrinhoMultiplasCampanhasError } from '../../errors/checkout/carrinho-multiplas-campanhas.error.js';
import { CheckoutPlataformaMismatchError } from '../../errors/checkout/plataforma-mismatch.error.js';
import type { Observability } from '../../observability/observability.js';
import { esgotada } from '../arrecadacao/quantidade-restante.js';
import { criarIntencaoPagamento } from '../pagamentos/criar-intencao-pagamento.js';
import { calcularComposicaoValoresParaItem } from '../taxas/calcular-composicao-valores-para-item.js';
import { calcularSurchargeParaCarrinho } from '../taxas/calcular-surcharge-para-carrinho.js';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2). Multi-item cart saga — renamed
 * from `iniciarPagamentoContribuicao` per operator review nit C (pure
 * rename, no @deprecated alias).
 */
const CartItemInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
  quantidade: z.number().int().positive(),
});

export const IniciarPagamentoCarrinhoInputSchema = z.object({
  idPlataforma: IdPlataformaReferenciaSchema,
  idCampanha: IdCampanhaSchema,
  itens: z.array(CartItemInputSchema).min(1),
  metodo: MetodoPagamentoSchema,
  idPagamento: IdPagamentoSchema,
  idIntencaoPagamento: IdIntencaoPagamentoSchema,
  /**
   * Caller-controlled UUIDs threaded into each item's `id`. Must have
   * exactly `itens.length` ids for the contribuicao items + ONE MORE if
   * `metodo === 'credit_card'` (the surcharge item's id).
   */
  idsItens: z.array(IdItemDoPagamentoSchema).min(1),
  returnUrl: z.string().trim().min(1).max(2000),
  redirectOnCompletion: z.enum(['always', 'if_required', 'never']).optional(),
});

export type IniciarPagamentoCarrinhoInput = z.infer<typeof IniciarPagamentoCarrinhoInputSchema>;

export interface IniciarPagamentoCarrinhoResult {
  readonly contribuicoes: readonly Contribuicao[];
  readonly pagamento: Pagamento;
  readonly sessionId: string;
  readonly clientSecret: string;
}

export interface IniciarPagamentoCarrinhoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly checkoutSessionProvider: CheckoutSessionProvider;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export async function iniciarPagamentoCarrinho(
  deps: IniciarPagamentoCarrinhoDeps,
  input: IniciarPagamentoCarrinhoInput,
): Promise<IniciarPagamentoCarrinhoResult> {
  const {
    campanhaRepository,
    contribuicaoRepository,
    provedorRegraTaxa,
    pagamentoRepository,
    pagamentoEventPublisher,
    checkoutSessionProvider,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('iniciarPagamentoCarrinho', async (span) => {
    try {
      const parsed = IniciarPagamentoCarrinhoInputSchema.parse(input);

      span.setAttributes({
        'checkout.plataforma.id': parsed.idPlataforma,
        'checkout.campanha.id': parsed.idCampanha,
        'checkout.cart.itens_count': parsed.itens.length,
        'checkout.pagamento.id': parsed.idPagamento,
        'checkout.metodo': parsed.metodo,
      });

      // ─── step 1: plataforma membership check ────────────────────────
      const campanha = await campanhaRepository.findById(parsed.idCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(parsed.idCampanha);
      }
      if (campanha.idPlataforma !== parsed.idPlataforma) {
        throw new CheckoutPlataformaMismatchError(parsed.idPlataforma, campanha.idPlataforma);
      }

      // ─── step 2: load contribuições + cart-construction invariant ───
      const contribuicoes: Contribuicao[] = [];
      const campanhasInCart = new Set<string>();
      for (const item of parsed.itens) {
        const contribuicao = await contribuicaoRepository.findById(
          item.idContribuicao as IdContribuicao,
        );
        if (!contribuicao) {
          throw new ArrecadacaoContribuicaoNaoEncontradaError(item.idContribuicao);
        }
        campanhasInCart.add(contribuicao.idCampanha);
        contribuicoes.push(contribuicao);
      }
      if (campanhasInCart.size > 1) {
        throw new CarrinhoMultiplasCampanhasError([...campanhasInCart]);
      }
      // Single-campanha cart: must equal the saga's input idCampanha.
      if (!campanhasInCart.has(parsed.idCampanha)) {
        throw new ArrecadacaoContribuicaoNaoEncontradaError(parsed.itens[0]?.idContribuicao ?? '');
      }

      // ─── step 3: per-item esgotada UX gate ─────────────────────────
      for (const item of parsed.itens) {
        const sold = await esgotada(
          {
            pagamentoRepository,
            contribuicaoRepository,
            observability,
          },
          { idContribuicao: item.idContribuicao as IdContribuicao },
        );
        if (sold) {
          throw new ArrecadacaoContribuicaoIndisponivelError(item.idContribuicao);
        }
      }

      // ─── step 4: composição per-item + cart-wide surcharge ─────────
      const itemComposicoes: SnapshotComposicaoValoresItemContribuicao[] = [];
      for (let i = 0; i < parsed.itens.length; i++) {
        const item = parsed.itens[i];
        const contribuicao = contribuicoes[i];
        if (!item || !contribuicao) {
          throw new Error('Internal saga error: itens / contribuicoes desalinhados');
        }
        const opcao = encontrarOpcaoContribuicao(campanha, contribuicao.idOpcaoContribuicao);
        if (!opcao) {
          throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(
            campanha.id,
            contribuicao.idOpcaoContribuicao,
          );
        }
        const composicao = await calcularComposicaoValoresParaItem(
          { provedorRegraTaxa, observability },
          {
            idPlataforma: parsed.idPlataforma,
            idContribuicao: item.idContribuicao,
            tipo: opcao.tipo,
            contributionUnitAmountCents: contribuicao.valor,
            quantidade: item.quantidade,
          },
        );
        itemComposicoes.push(composicao);
      }

      const totalContributionCents = itemComposicoes.reduce(
        (acc, c) => acc + c.lineContributionAmountCents,
        0,
      );
      const surchargeItem = await calcularSurchargeParaCarrinho(
        { observability },
        {
          totalContributionCents: totalContributionCents as never,
          metodo: parsed.metodo,
        },
      );

      // ─── step 4b: build items (caller-controlled UUIDs) ─────────────
      const expectedIdsCount = parsed.itens.length + (surchargeItem ? 1 : 0);
      if (parsed.idsItens.length !== expectedIdsCount) {
        throw new Error(
          `idsItens length (${parsed.idsItens.length}) must match itens.length (${parsed.itens.length}) plus ${surchargeItem ? 1 : 0} for the surcharge item.`,
        );
      }

      const now = clock();
      const items: ItemDoPagamento[] = [];
      for (let i = 0; i < itemComposicoes.length; i++) {
        const id = parsed.idsItens[i];
        const composicao = itemComposicoes[i];
        if (!id || !composicao) continue;
        items.push(
          criarItemContribuicao({
            id,
            composicaoValoresItem: composicao,
            criadoEm: now,
          }),
        );
      }
      if (surchargeItem) {
        const surchargeId = parsed.idsItens[parsed.itens.length];
        if (!surchargeId) {
          throw new Error('Internal saga error: surchargeId não encontrado em idsItens');
        }
        items.push(
          criarItemPassthroughSurcharge({
            id: surchargeId,
            composicaoValoresItem: surchargeItem,
            criadoEm: now,
          }),
        );
      }

      // ─── step 5: build aggregate ────────────────────────────────────
      const allItemComposicoes: SnapshotComposicaoValoresItem[] = [
        ...itemComposicoes,
        ...(surchargeItem
          ? [surchargeItem as SnapshotComposicaoValoresItemSurcharge]
          : []),
      ];
      const totalContribution = allItemComposicoes.reduce(
        (acc, c) => (c.tipo === 'contribuicao' ? acc + c.lineContributionAmountCents : acc),
        0,
      );
      const totalFee = allItemComposicoes.reduce(
        (acc, c) => (c.tipo === 'contribuicao' ? acc + c.lineFeeAmountCents : acc),
        0,
      );
      const totalReceiver = allItemComposicoes.reduce(
        (acc, c) => (c.tipo === 'contribuicao' ? acc + c.lineReceiverAmountCents : acc),
        0,
      );
      const totalSurcharge = allItemComposicoes.reduce(
        (acc, c) => (c.tipo === 'passthrough_surcharge' ? acc + c.amountCents : acc),
        0,
      );
      const totalPaid = totalReceiver + totalFee + totalSurcharge;

      const aggregate: SnapshotComposicaoValoresAggregate = {
        idCampanha: parsed.idCampanha,
        totalContributionCents: totalContribution as never,
        totalFeeCents: totalFee as never,
        totalReceiverCents: totalReceiver as never,
        totalSurchargeCents: totalSurcharge,
        totalPaidCents: totalPaid as never,
        responsavelTaxa: 'contribuinte',
      };

      // ─── step 6: provider session ──────────────────────────────────
      const anchorContribuicao = contribuicoes[0];
      if (!anchorContribuicao) {
        throw new Error('Internal saga error: contribuicoes array vazio');
      }
      const anchorOpcao = encontrarOpcaoContribuicao(
        campanha,
        anchorContribuicao.idOpcaoContribuicao,
      );
      if (!anchorOpcao) {
        throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(
          campanha.id,
          anchorContribuicao.idOpcaoContribuicao,
        );
      }

      const nomeItem =
        parsed.itens.length === 1
          ? anchorContribuicao.nome
          : `Carrinho — ${parsed.itens.length} itens (${anchorContribuicao.nome} + ${parsed.itens.length - 1} mais)`;

      const sessao = await checkoutSessionProvider.criarSessaoCheckout({
        idPagamento: parsed.idPagamento,
        idIntencaoPagamento: parsed.idIntencaoPagamento,
        idCampanha: parsed.idCampanha,
        idContribuicao: anchorContribuicao.id,
        idOpcaoContribuicao: anchorContribuicao.idOpcaoContribuicao,
        tipoOpcao: anchorOpcao.tipo,
        nomeItem,
        amountCents: aggregate.totalPaidCents,
        surchargeCents: aggregate.totalSurchargeCents,
        metodo: parsed.metodo,
        returnUrl: parsed.returnUrl,
        ...(parsed.redirectOnCompletion
          ? { redirectOnCompletion: parsed.redirectOnCompletion }
          : {}),
      });

      span.setAttribute('checkout.session.id', sessao.sessionId);

      // ─── step 7: persist intencao + items + publish event ──────────
      const pagamento = await criarIntencaoPagamento(
        { pagamentoRepository, pagamentoEventPublisher, clock, observability },
        {
          idPagamento: parsed.idPagamento,
          idIntencaoPagamento: parsed.idIntencaoPagamento,
          items,
          composicaoValoresAggregate: aggregate,
          valorACobrarCents: aggregate.totalPaidCents,
          metodo: parsed.metodo,
          externalRef: sessao.externalRef,
        },
      );

      logger.info('checkout.pagamento.iniciado', {
        idPlataforma: parsed.idPlataforma,
        idCampanha: campanha.id,
        idPagamento: pagamento.id,
        sessionId: sessao.sessionId,
        numeroDeItens: parsed.itens.length,
        totalPaidCents: aggregate.totalPaidCents,
        metodo: parsed.metodo,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return {
        contribuicoes,
        pagamento,
        sessionId: sessao.sessionId,
        clientSecret: sessao.clientSecret,
      };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
