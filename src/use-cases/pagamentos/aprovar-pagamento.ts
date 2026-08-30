import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import { PixCobrancaE2eIdSchema } from '../../adapters/pagamentos/pix-cobranca-devolucao-repository.js';
import type { PagamentoProvider } from '../../adapters/pagamentos/provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import {
  aprovarPagamentoPendente,
  criarEventoPagamento,
  type Pagamento,
  podeAprovarPagamento,
  type TransacaoExterna,
  TransacaoExternaSchema,
} from '../../domain/pagamentos/entities/pagamento.js';
import { PagamentosInputInvalidoError } from '../../errors/pagamentos/input-invalido.error.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import { PagamentoValorDivergenteError } from '../../errors/pagamentos/valor-divergente.error.js';
import type { Observability } from '../../observability/observability.js';
import {
  type ComandoPagamentoInput,
  ComandoPagamentoInputSchema,
} from './obter-pagamento-por-id.js';

export interface AprovarPagamentoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
  readonly pixReceiptNotifier?: PixReceiptNotifier;
}

export interface AprovarPagamentoComTransacaoVerificadaDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
  readonly pixReceiptNotifier?: PixReceiptNotifier;
}

/**
 * Outbound receipt seam. It is invoked only by the approval CAS winner, so
 * webhook/reconciler replay cannot send the same PIX receipt twice.
 */
export type PixReceiptNotifier = (pagamento: Pagamento) => Promise<void>;

export interface AprovarPagamentoComTransacaoVerificadaInput extends ComandoPagamentoInput {
  /**
   * Provider result that the caller has already verified against the
   * provider's authoritative read API. This function never contacts a
   * provider; it only applies the verified fact to our aggregate.
   */
  readonly transacao: TransacaoExterna;
}

const STATUS_ORIGEM_VERIFICADA = ['pendente', 'processing'] as const;

/**
 * Aprova um pagamento a partir de uma transação externa simulada pelo provedor fake.
 */
export async function aprovarPagamento(
  deps: AprovarPagamentoDeps,
  input: ComandoPagamentoInput,
): Promise<Pagamento> {
  const {
    pagamentoRepository,
    pagamentoProvider,
    pagamentoEventPublisher,
    clock,
    observability,
    pixReceiptNotifier,
  } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('aprovarPagamento', async (span) => {
    try {
      const parsed = ComandoPagamentoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new PagamentosInputInvalidoError(message);
      }

      span.setAttribute('pagamento.id', parsed.data.idPagamento);

      const pagamento = await pagamentoRepository.findById(parsed.data.idPagamento);
      if (!pagamento) {
        throw new PagamentoNaoEncontradoError(parsed.data.idPagamento);
      }

      if (!podeAprovarPagamento(pagamento)) {
        throw new PagamentoTransicaoStatusInvalidaError(pagamento.id, pagamento.status, 'aprovado');
      }

      // Thread externalRef (aperture-xaha2): when the Pagamento was created
      // via the CheckoutSessionProvider flow, the Stripe adapter needs the
      // session id to look up the actual `payment_intent` rather than minting
      // a synthetic transaction. The fake adapter ignores this field.
      const transacao = await pagamentoProvider.solicitarPagamento({
        idPagamento: pagamento.id,
        idIntencaoPagamento: pagamento.intencao.id,
        amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
        metodo: pagamento.intencao.metodo,
        externalRef: pagamento.intencao.externalRef,
      });

      const aprovado = await aplicarTransacaoVerificada(
        {
          pagamentoRepository,
          pagamentoEventPublisher,
          clock,
          observability,
          ...(pixReceiptNotifier ? { pixReceiptNotifier } : {}),
        },
        pagamento,
        transacao,
      );
      span.setStatus({ code: SpanStatusCode.OK });
      return aprovado;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Apply an already-authoritatively-verified provider transaction.
 *
 * This is the bookkeeping seam for provider callbacks whose trust root is a
 * separate read (Banco Inter webhook -> GET /cob/{txid}). Calling the regular
 * `aprovarPagamento` here would contact `PagamentoProvider` again and, during
 * the Stripe/Inter coexistence window, could call the wrong provider. The
 * caller must supply the exact verified transaction; amount/status/domain
 * invariants are still enforced here before persistence.
 */
export async function aprovarPagamentoComTransacaoVerificada(
  deps: AprovarPagamentoComTransacaoVerificadaDeps,
  input: AprovarPagamentoComTransacaoVerificadaInput,
): Promise<Pagamento> {
  const parsedInput = ComandoPagamentoInputSchema.safeParse(input);
  if (!parsedInput.success) {
    const message = parsedInput.error.issues.map((issue) => issue.message).join('; ');
    throw new PagamentosInputInvalidoError(message);
  }
  const transacao = TransacaoExternaSchema.parse(input.transacao);
  const pagamento = await deps.pagamentoRepository.findById(parsedInput.data.idPagamento);
  if (!pagamento) {
    throw new PagamentoNaoEncontradoError(parsedInput.data.idPagamento);
  }

  if (pagamento.status === 'aprovado') {
    validarRepeticaoVerificada(pagamento, transacao);
    return pagamento;
  }
  if (!podeAprovarPagamento(pagamento)) {
    throw new PagamentoTransicaoStatusInvalidaError(pagamento.id, pagamento.status, 'aprovado');
  }

  validarTransacaoAprovada(pagamento, transacao);

  const now = deps.clock();
  const aprovado = stampVerifiedProviderIdentity(
    aprovarPagamentoPendente(pagamento, transacao, now),
    transacao,
    now,
  );
  const venceuCas = await deps.pagamentoRepository.updateIfStatusIn(
    aprovado,
    STATUS_ORIGEM_VERIFICADA,
  );

  if (!venceuCas) {
    const canonical = await deps.pagamentoRepository.findById(pagamento.id);
    if (!canonical) {
      throw new PagamentoNaoEncontradoError(pagamento.id);
    }
    if (canonical.status === 'aprovado') {
      validarRepeticaoVerificada(canonical, transacao);
      return canonical;
    }
    throw new PagamentoTransicaoStatusInvalidaError(canonical.id, canonical.status, 'aprovado');
  }

  await publicarAprovacao(deps, aprovado, transacao, now);
  return aprovado;
}

async function aplicarTransacaoVerificada(
  deps: AprovarPagamentoComTransacaoVerificadaDeps,
  pagamento: Pagamento,
  transacao: TransacaoExterna,
): Promise<Pagamento> {
  const { pagamentoRepository, clock } = deps;

  validarTransacaoAprovada(pagamento, transacao);

  const now = clock();
  const aprovado = stampVerifiedProviderIdentity(
    aprovarPagamentoPendente(pagamento, transacao, now),
    transacao,
    now,
  );
  const venceuCas = await pagamentoRepository.updateIfStatusIn(aprovado, STATUS_ORIGEM_VERIFICADA);

  if (!venceuCas) {
    const canonical = await pagamentoRepository.findById(pagamento.id);
    if (!canonical) {
      throw new PagamentoNaoEncontradoError(pagamento.id);
    }
    if (canonical.status === 'aprovado') {
      validarRepeticaoVerificada(canonical, transacao);
      return canonical;
    }
    throw new PagamentoTransicaoStatusInvalidaError(canonical.id, canonical.status, 'aprovado');
  }

  await publicarAprovacao(deps, aprovado, transacao, now);

  return aprovado;
}

function validarTransacaoAprovada(pagamento: Pagamento, transacao: TransacaoExterna): void {
  if (transacao.status !== 'aprovado') {
    throw new PagamentoTransicaoStatusInvalidaError(pagamento.id, pagamento.status, 'aprovado');
  }
  if (transacao.amountCents !== pagamento.intencao.composicaoValoresAggregate.totalPaidCents) {
    throw new PagamentoValorDivergenteError(
      pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
      transacao.amountCents,
    );
  }
}

function validarRepeticaoVerificada(pagamento: Pagamento, transacao: TransacaoExterna): void {
  const existente = pagamento.transacaoExterna;
  if (
    !existente ||
    existente.id !== transacao.id ||
    existente.provedor !== transacao.provedor ||
    existente.status !== transacao.status ||
    existente.amountCents !== transacao.amountCents ||
    (transacao.provedor === 'inter' && pagamento.intencao.e2eExternalRef !== transacao.id)
  ) {
    throw new PagamentosInputInvalidoError('transacao verificada diverge do pagamento ja aprovado');
  }
}

/**
 * Persist the provider identity needed by later provider-specific operations.
 *
 * Banco Inter refunds are addressed by the authoritative Pix end-to-end id,
 * not by the checkout txid.  Only this verified settlement path may stamp it;
 * caller-supplied intent creation can never choose the value.  Other
 * providers keep the nullable column untouched so historic Stripe routing is
 * still driven solely by `transacaoExterna.provedor`.
 */
function stampVerifiedProviderIdentity(
  pagamento: Pagamento,
  transacao: TransacaoExterna,
  now: Date,
): Pagamento {
  if (transacao.provedor !== 'inter') return pagamento;
  const parsedE2eId = PixCobrancaE2eIdSchema.safeParse(transacao.id);
  if (!parsedE2eId.success) {
    throw new PagamentosInputInvalidoError('e2e id Inter verificado invalido');
  }
  const e2eExternalRef = parsedE2eId.data;
  return {
    ...pagamento,
    intencao: {
      ...pagamento.intencao,
      e2eExternalRef,
      balanceTransactionAvailableOn: pagamento.intencao.balanceTransactionAvailableOn ?? now,
    },
  };
}

async function publicarAprovacao(
  deps: AprovarPagamentoComTransacaoVerificadaDeps,
  aprovado: Pagamento,
  transacao: TransacaoExterna,
  ocorridoEm: Date,
): Promise<void> {
  await deps.pagamentoEventPublisher.publish(
    criarEventoPagamento({
      id: randomUUID(),
      tipo: 'payment.approved',
      pagamento: aprovado,
      ocorridoEm,
    }),
  );

  if (aprovado.intencao.metodo === 'pix' && aprovado.intencao.contribuinte !== null) {
    try {
      await deps.pixReceiptNotifier?.(aprovado);
    } catch {
      // Payment settlement is authoritative and must not be rolled back by a
      // downstream SMTP outage. No recipient is logged (no email oracle/PII).
      deps.observability.logger.error('pagamento.comprovante_pix_email_falhou', {
        idPagamento: aprovado.id,
        // Never forward caller-controlled Error fields. SMTP exceptions can
        // carry RCPT addresses in name/message/stack.
        errorType: 'PixReceiptDeliveryError',
      });
    }
  }

  deps.observability.logger.info('pagamento.aprovado', {
    idPagamento: aprovado.id,
    idIntencaoPagamento: aprovado.intencao.id,
    idCampanha: aprovado.intencao.idCampanha,
    numeroDeItens: aprovado.intencao.items.length,
    amountCents: aprovado.intencao.composicaoValoresAggregate.totalPaidCents,
    idTransacaoExterna: transacao.id,
  });
}
