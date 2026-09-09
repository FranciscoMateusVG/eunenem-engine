import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type {
  CheckoutOperation,
  CheckoutOperationRepository,
  CheckoutOperationSnapshot,
} from '../../adapters/pagamentos/checkout-operation-repository.js';
import type {
  CheckoutSessionProvider,
  CriarSessaoCheckoutInput,
} from '../../adapters/pagamentos/checkout-session-provider.js';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PixCobrancaProvider } from '../../adapters/pagamentos/pix-cobranca-provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { ProvedorRegraTaxa } from '../../adapters/taxas/regra-provider.js';
import { encontrarOpcaoContribuicao } from '../../domain/arrecadacao/entities/campanha.js';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  IdCampanhaSchema,
  type IdContribuicao,
  IdContribuicaoSchema,
  IdPlataformaReferenciaSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import {
  criarItemContribuicao,
  criarItemPassthroughSurcharge,
  type ItemDoPagamento,
} from '../../domain/pagamentos/entities/item-do-pagamento.js';
import {
  criarEventoPagamento,
  criarPagamentoPendente,
  type Pagamento,
} from '../../domain/pagamentos/entities/pagamento.js';
import { DadosContribuinteSchema } from '../../domain/pagamentos/value-objects/dados-contribuinte.js';
import {
  IdIntencaoPagamentoSchema,
  IdItemDoPagamentoSchema,
  IdPagamentoSchema,
} from '../../domain/pagamentos/value-objects/ids.js';
import { MetodoPagamentoSchema } from '../../domain/pagamentos/value-objects/metodo-pagamento.js';
import type { SnapshotComposicaoValoresAggregate } from '../../domain/pagamentos/value-objects/snapshot-composicao-valores-aggregate.js';
import type {
  SnapshotComposicaoValoresItem,
  SnapshotComposicaoValoresItemContribuicao,
  SnapshotComposicaoValoresItemSurcharge,
} from '../../domain/pagamentos/value-objects/snapshot-composicao-valores-item.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoIndisponivelError } from '../../errors/arrecadacao/contribuicao-indisponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import { CarrinhoMultiplasCampanhasError } from '../../errors/checkout/carrinho-multiplas-campanhas.error.js';
import { CheckoutPlataformaMismatchError } from '../../errors/checkout/plataforma-mismatch.error.js';
import { PagamentosInputInvalidoError } from '../../errors/pagamentos/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';
import { esgotada } from '../arrecadacao/quantidade-restante.js';
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
  itens: z.array(CartItemInputSchema).min(1).max(50),
  metodo: MetodoPagamentoSchema,
  idPagamento: IdPagamentoSchema,
  idIntencaoPagamento: IdIntencaoPagamentoSchema,
  /**
   * Caller-controlled UUIDs threaded into each item's `id`. Must have
   * exactly `itens.length` ids for the contribuicao items + ONE MORE if
   * `metodo === 'credit_card'` (the surcharge item's id).
   */
  idsItens: z.array(IdItemDoPagamentoSchema).min(1).max(51),
  returnUrl: z.string().trim().min(1).max(2000),
  redirectOnCompletion: z.enum(['always', 'if_required', 'never']).optional(),
  /**
   * aperture-kuw0o (Inter PIX, spec §4.3): visitor identity captured by
   * OUR OWN form before checkout. REQUIRED when the saga routes to the
   * PIX-cobrança branch (Inter's cob API collects nothing, unlike
   * Stripe's iframe custom_fields); Stripe-branch callers omit it.
   * Includes email — the domain's DadosContribuinte requires it (the
   * spec's "nome/mensagem" wording listed only the custom_fields pair;
   * Stripe also collected email natively, so our form collects all 3 —
   * documented deviation, follows aperture-m95f3's data-must-exist
   * intent).
   */
  contribuinte: DadosContribuinteSchema.optional(),
});

export type IniciarPagamentoCarrinhoInput = z.infer<typeof IniciarPagamentoCarrinhoInputSchema>;

/**
 * aperture-kuw0o (spec §4.3): discriminated union — no phantom fields.
 * `stripe_embedded` carries the iframe pair; `pix_qr` carries the BR Code
 * trio the QR screen renders. Common saga outputs (contribuicoes +
 * pagamento) ride alongside for router-side consumers.
 */
export type IniciarPagamentoCarrinhoResult = {
  readonly contribuicoes: readonly Contribuicao[];
  readonly pagamento: Pagamento;
} & (
  | { readonly tipo: 'stripe_embedded'; readonly sessionId: string; readonly clientSecret: string }
  | {
      readonly tipo: 'pix_qr';
      readonly txid: string;
      readonly pixCopiaECola: string;
      readonly expiraEm: Date;
      /**
       * aperture-irhxi (Izzy QA blocker 3 — money display): the
       * AUTHORITATIVE charged amount (aggregate totalPaidCents =
       * contribution + platform fee). The QR screen renders THIS — never
       * the raw gift price. On the Stripe path the iframe shows Stripe's
       * own total; our QR flow owes the visitor the same honesty.
       */
      readonly valorCents: number;
    }
);

/**
 * aperture-kuw0o: which PixCobrancaProvider binding is active (B7's
 * COBRANCA_PIX_PROVIDER env). Routing DEVIATION from the spec's literal
 * "=== 'inter'": the fake binding must also route through the PIX branch,
 * or the spec's own §7 e2e (fake provider → QR screen) is unreachable.
 * 'stripe' (the default) keeps every flow on the untouched Stripe path.
 */
export type CobrancaPixProviderKind = 'stripe' | 'inter' | 'fake';

export interface IniciarPagamentoCarrinhoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly pagamentoRepository: PagamentoRepository;
  readonly checkoutOperationRepository: CheckoutOperationRepository;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly checkoutSessionProvider: CheckoutSessionProvider;
  readonly pixCobrancaProvider: PixCobrancaProvider;
  readonly cobrancaPixProviderKind: CobrancaPixProviderKind;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface CheckoutOperationAccess {
  /** Opaque per-operation cookie capability. Never log or return it. */
  readonly capability: string;
}

export interface PrepararPagamentoCarrinhoResult {
  readonly operationId: string;
  readonly created: boolean;
}

export class CheckoutOperationConflictError extends Error {
  readonly _tag = 'CheckoutOperationConflictError';
  constructor() {
    super('checkout operation is unavailable');
    this.name = 'CheckoutOperationConflictError';
  }
}

export class CheckoutOperationPendingError extends Error {
  readonly _tag = 'CheckoutOperationPendingError';
  constructor() {
    super('checkout operation outcome is pending recovery');
    this.name = 'CheckoutOperationPendingError';
  }
}

function digestCapability(capability: string): string {
  return createHash('sha256').update(capability, 'utf8').digest('hex');
}

function digestRequest(capability: string, value: unknown): string {
  return createHmac('sha256', capability)
    .update('eunenem.checkout-operation.v1\0', 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

export async function prepararPagamentoCarrinho(
  deps: IniciarPagamentoCarrinhoDeps,
  input: IniciarPagamentoCarrinhoInput,
  access: CheckoutOperationAccess,
): Promise<PrepararPagamentoCarrinhoResult> {
  const result = await runPagamentoCarrinho(deps, input, access, 'prepare');
  return result as PrepararPagamentoCarrinhoResult;
}

export async function iniciarPagamentoCarrinho(
  deps: IniciarPagamentoCarrinhoDeps,
  input: IniciarPagamentoCarrinhoInput,
  access: CheckoutOperationAccess,
): Promise<IniciarPagamentoCarrinhoResult> {
  const result = await runPagamentoCarrinho(deps, input, access, 'execute');
  return result as IniciarPagamentoCarrinhoResult;
}

async function runPagamentoCarrinho(
  deps: IniciarPagamentoCarrinhoDeps,
  input: IniciarPagamentoCarrinhoInput,
  access: CheckoutOperationAccess,
  phase: 'prepare' | 'execute',
): Promise<IniciarPagamentoCarrinhoResult | PrepararPagamentoCarrinhoResult> {
  const {
    campanhaRepository,
    contribuicaoRepository,
    provedorRegraTaxa,
    pagamentoRepository,
    checkoutOperationRepository,
    pagamentoEventPublisher,
    checkoutSessionProvider,
    pixCobrancaProvider,
    cobrancaPixProviderKind,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;
  if (!checkoutOperationRepository) {
    throw new Error('checkoutOperationRepository is required');
  }
  if (!access || !/^[A-Za-z0-9_-]{43}$/.test(access.capability)) {
    throw new Error('checkout operation access is required');
  }

  return tracer.startActiveSpan(
    'iniciarPagamentoCarrinho',
    async (span): Promise<IniciarPagamentoCarrinhoResult | PrepararPagamentoCarrinhoResult> => {
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
          throw new ArrecadacaoContribuicaoNaoEncontradaError(
            parsed.itens[0]?.idContribuicao ?? '',
          );
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
          ...(surchargeItem ? [surchargeItem as SnapshotComposicaoValoresItemSurcharge] : []),
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

        // Build the exact server-derived request snapshot before any provider I/O.
        const anchorContribuicao = contribuicoes[0];
        if (!anchorContribuicao) throw new Error('Internal saga error: contribuicoes array vazio');
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
            : 'Carrinho — ' +
              parsed.itens.length +
              ' itens (' +
              anchorContribuicao.nome +
              ' + ' +
              (parsed.itens.length - 1) +
              ' mais)';
        const viaPixCobranca =
          parsed.metodo === 'pix' &&
          (cobrancaPixProviderKind === 'inter' || cobrancaPixProviderKind === 'fake');
        if (viaPixCobranca && !parsed.contribuinte) {
          throw new PagamentosInputInvalidoError(
            'contribuinte (nome + email) é obrigatório para pagamento PIX via cobrança — a coleta acontece no nosso formulário, não no provedor.',
          );
        }

        const provider = viaPixCobranca ? 'inter' : 'stripe';
        const pagamento = criarPagamentoPendente({
          idPagamento: parsed.idPagamento,
          idIntencaoPagamento: parsed.idIntencaoPagamento,
          items,
          composicaoValoresAggregate: aggregate,
          valorACobrarCents: aggregate.totalPaidCents,
          metodo: parsed.metodo,
          externalRef: null,
          contribuinte: viaPixCobranca ? (parsed.contribuinte ?? null) : null,
          expiraEm: null,
          criadoEm: now,
        });
        const snapshot: CheckoutOperationSnapshot = {
          operationId: parsed.idPagamento,
          platformId: parsed.idPlataforma,
          campaignId: parsed.idCampanha,
          paymentId: parsed.idPagamento,
          intentId: parsed.idIntencaoPagamento,
          method: parsed.metodo,
          provider,
          items: [
            ...itemComposicoes.map((line, index) => ({
              paymentItemId: parsed.idsItens[index] as string,
              contributionId: parsed.itens[index]?.idContribuicao ?? null,
              optionId: contribuicoes[index]?.idOpcaoContribuicao ?? null,
              optionType:
                encontrarOpcaoContribuicao(
                  campanha,
                  contribuicoes[index]?.idOpcaoContribuicao ?? '',
                )?.tipo ?? null,
              quantity: parsed.itens[index]?.quantidade ?? 1,
              contributionCents: line.lineContributionAmountCents as number,
              feeCents: line.lineFeeAmountCents as number,
              receiverCents: line.lineReceiverAmountCents as number,
              surchargeCents: 0,
            })),
            ...(surchargeItem
              ? [
                  {
                    paymentItemId: parsed.idsItens[parsed.itens.length] as string,
                    contributionId: null,
                    optionId: null,
                    optionType: 'passthrough_surcharge',
                    quantity: 1,
                    contributionCents: 0,
                    feeCents: 0,
                    receiverCents: 0,
                    surchargeCents: surchargeItem.amountCents,
                  },
                ]
              : []),
          ],
          totalChargedCents: aggregate.totalPaidCents as number,
          totalReceiverCents: aggregate.totalReceiverCents as number,
          totalSurchargeCents: aggregate.totalSurchargeCents,
          ...(provider === 'inter'
            ? {
                idempotencyKey: parsed.idPagamento.replaceAll('-', ''),
                txid: parsed.idPagamento.replaceAll('-', ''),
                expirationSeconds: 600,
              }
            : {
                idempotencyKey: `pagamento:${parsed.idPagamento}:create-session`,
                anchorContributionId: anchorContribuicao.id,
                anchorOptionId: anchorContribuicao.idOpcaoContribuicao,
                anchorOptionType: anchorOpcao.tipo,
                redirectOnCompletion: parsed.redirectOnCompletion ?? 'always',
              }),
        } as CheckoutOperationSnapshot;
        const requestMaterial = {
          snapshot,
          nomeItem,
          returnUrl: parsed.returnUrl,
          // PII is never stored in the operation snapshot, but it is bound
          // by the keyed request HMAC so a replay cannot silently substitute
          // a different contributor on the same operation.
          contribuinte: parsed.contribuinte ?? null,
        };
        const capabilityHash = digestCapability(access.capability);
        const requestHmac = digestRequest(access.capability, requestMaterial);
        const prepared = await checkoutOperationRepository.prepare({
          pagamento,
          operationId: parsed.idPagamento,
          platformId: parsed.idPlataforma,
          campaignId: parsed.idCampanha,
          provider,
          method: parsed.metodo,
          capabilityHash,
          requestHmac,
          snapshot,
          now,
        });
        if (
          !equalDigest(prepared.operation.capabilityHash, capabilityHash) ||
          !equalDigest(prepared.operation.requestHmac, requestHmac)
        ) {
          throw new CheckoutOperationConflictError();
        }
        if (phase === 'prepare') {
          span.setStatus({ code: SpanStatusCode.OK });
          return { operationId: parsed.idPagamento, created: prepared.created };
        }
        if (prepared.created) {
          // Execution is a distinct request that proves receipt of the per-operation cookie.
          throw new CheckoutOperationConflictError();
        }

        const claimNow = clock();
        const claimed = await checkoutOperationRepository.claim({
          operationId: parsed.idPagamento,
          capabilityHash,
          requestHmac,
          now: claimNow,
          leaseUntil: new Date(claimNow.getTime() + 30_000),
        });
        if (claimed.status === 'busy' || claimed.status === 'expired_window') {
          throw new CheckoutOperationPendingError();
        }
        if (claimed.status === 'failed') throw new CheckoutOperationConflictError();

        if (claimed.status === 'local_committed') {
          const recovered = await recoverProviderMaterial(
            checkoutSessionProvider,
            pixCobrancaProvider,
            claimed.operation,
            aggregate.totalPaidCents as number,
          );
          if (!recovered) throw new CheckoutOperationPendingError();
          const persisted = await pagamentoRepository.findById(parsed.idPagamento);
          if (!persisted) throw new CheckoutOperationPendingError();
          span.setStatus({ code: SpanStatusCode.OK });
          return {
            contribuicoes,
            pagamento: persisted,
            ...recovered,
          } as IniciarPagamentoCarrinhoResult;
        }
        if (claimed.status !== 'claimed') throw new CheckoutOperationPendingError();

        let material: ProviderMountMaterial;
        try {
          material = await obtainProviderMaterial(
            claimed.claimKind,
            claimed.operation,
            checkoutSessionProvider,
            pixCobrancaProvider,
            {
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
              redirectOnCompletion: parsed.redirectOnCompletion ?? 'always',
            },
          );
        } catch {
          await checkoutOperationRepository.completeAttempt({
            operationId: parsed.idPagamento,
            attemptNo: claimed.attemptNo,
            fenceToken: claimed.fenceToken,
            outcome: 'outcome_unknown',
            diagnostic: 'provider_call_failed',
            providerRef: null,
            providerExpiresAt: null,
            now: clock(),
          });
          throw new CheckoutOperationPendingError();
        }

        const resultRecorded = await checkoutOperationRepository.completeAttempt({
          operationId: parsed.idPagamento,
          attemptNo: claimed.attemptNo,
          fenceToken: claimed.fenceToken,
          outcome: 'provider_succeeded',
          diagnostic: null,
          providerRef: material.externalRef,
          providerExpiresAt: material.providerExpiresAt,
          now: clock(),
        });
        if (!resultRecorded) throw new CheckoutOperationPendingError();
        const committed = await checkoutOperationRepository.commitLocal({
          operationId: parsed.idPagamento,
          fenceToken: claimed.fenceToken,
          providerRef: material.externalRef,
          providerExpiresAt: material.providerExpiresAt,
          now: clock(),
        });
        if (!committed) {
          // Never release mount material after losing the operation fence.
          throw new CheckoutOperationPendingError();
        }

        const committedPayment = await pagamentoRepository.findById(parsed.idPagamento);
        if (!committedPayment) throw new CheckoutOperationPendingError();
        try {
          await pagamentoEventPublisher.publish(
            criarEventoPagamento({
              id: randomUUID(),
              tipo: 'payment.intent_created',
              pagamento: committedPayment,
              ocorridoEm: clock(),
            }),
          );
        } catch {
          logger.warn('checkout.intent_event.publish_failed', {
            idPagamento: parsed.idPagamento,
          });
        }
        logger.info('checkout.pagamento.iniciado', {
          idPlataforma: parsed.idPlataforma,
          idCampanha: campanha.id,
          idPagamento: committedPayment.id,
          numeroDeItens: parsed.itens.length,
          totalPaidCents: aggregate.totalPaidCents,
          metodo: parsed.metodo,
          via: provider,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return {
          contribuicoes,
          pagamento: committedPayment,
          ...toPublicMaterial(material, aggregate.totalPaidCents as number),
        } as IniciarPagamentoCarrinhoResult;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

type ProviderMountMaterial =
  | {
      readonly kind: 'stripe';
      readonly sessionId: string;
      readonly clientSecret: string;
      readonly externalRef: string;
      readonly providerExpiresAt: Date | null;
    }
  | {
      readonly kind: 'inter';
      readonly txid: string;
      readonly pixCopiaECola: string;
      readonly externalRef: string;
      readonly providerExpiresAt: Date;
    };

async function obtainProviderMaterial(
  claimKind: 'create' | 'retrieve' | 'reconcile',
  operation: CheckoutOperation,
  stripe: CheckoutSessionProvider,
  inter: PixCobrancaProvider,
  stripeInput: CriarSessaoCheckoutInput,
): Promise<ProviderMountMaterial> {
  if (operation.provider === 'stripe') {
    if (claimKind === 'create') {
      const created = await stripe.criarSessaoCheckout(stripeInput);
      return {
        kind: 'stripe',
        sessionId: created.sessionId,
        clientSecret: created.clientSecret,
        externalRef: created.externalRef,
        providerExpiresAt: null,
      };
    }
    const recovered = await stripe.obterSessaoCheckout(operation.providerRef ?? '');
    if (
      !recovered?.clientSecret ||
      recovered.sessionId !== operation.providerRef ||
      recovered.externalRef !== operation.providerRef ||
      recovered.paymentId !== operation.paymentId ||
      recovered.intentId !== operation.snapshot.intentId ||
      recovered.campaignId !== operation.campaignId ||
      recovered.method !== operation.method ||
      recovered.amountTotalCents !== operation.snapshot.totalChargedCents
    ) {
      throw new CheckoutOperationPendingError();
    }
    return {
      kind: 'stripe',
      sessionId: recovered.sessionId,
      clientSecret: recovered.clientSecret,
      externalRef: recovered.externalRef,
      providerExpiresAt: null,
    };
  }
  if (claimKind === 'create') {
    const created = await inter.criarCobranca({
      idPagamento: operation.paymentId as never,
      idIntencaoPagamento: operation.snapshot.intentId as never,
      amountCents: operation.snapshot.totalChargedCents as never,
    });
    return {
      kind: 'inter',
      txid: created.txid,
      pixCopiaECola: created.pixCopiaECola,
      externalRef: created.txid,
      providerExpiresAt: created.expiraEm,
    };
  }
  if (operation.snapshot.provider !== 'inter') throw new CheckoutOperationPendingError();
  const recovered = await inter.consultarCobranca(operation.providerRef ?? operation.snapshot.txid);
  if (
    recovered.status !== 'ativa' ||
    recovered.txid !== (operation.providerRef ?? operation.snapshot.txid) ||
    recovered.valorOriginalCents !== operation.snapshot.totalChargedCents ||
    typeof recovered.pixCopiaECola !== 'string' ||
    !(recovered.expiraEm instanceof Date)
  ) {
    throw new CheckoutOperationPendingError();
  }
  return {
    kind: 'inter',
    txid: operation.providerRef ?? operation.snapshot.txid,
    pixCopiaECola: recovered.pixCopiaECola,
    externalRef: operation.providerRef ?? operation.snapshot.txid,
    providerExpiresAt: recovered.expiraEm,
  };
}

async function recoverProviderMaterial(
  stripe: CheckoutSessionProvider,
  inter: PixCobrancaProvider,
  operation: CheckoutOperation,
  amountCents: number,
): Promise<ReturnType<typeof toPublicMaterial> | null> {
  if (amountCents !== operation.snapshot.totalChargedCents) return null;
  try {
    const material = await obtainProviderMaterial(
      'retrieve',
      operation,
      stripe,
      inter,
      {} as CriarSessaoCheckoutInput,
    );
    return toPublicMaterial(material, operation.snapshot.totalChargedCents);
  } catch {
    // Provider-derived errors are never allowed to escape into router/tracing
    // surfaces during recovery. The durable operation remains retryable.
    return null;
  }
}

function toPublicMaterial(material: ProviderMountMaterial, amountCents: number) {
  return material.kind === 'stripe'
    ? {
        tipo: 'stripe_embedded' as const,
        sessionId: material.sessionId,
        clientSecret: material.clientSecret,
      }
    : {
        tipo: 'pix_qr' as const,
        txid: material.txid,
        pixCopiaECola: material.pixCopiaECola,
        expiraEm: material.providerExpiresAt,
        valorCents: amountCents,
      };
}
