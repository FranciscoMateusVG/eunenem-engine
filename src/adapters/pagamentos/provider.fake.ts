import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { MoneyCents } from '../../domain/money.js';
import {
  type StatusTransacaoExterna,
  type TransacaoExterna,
  TransacaoExternaSchema,
} from '../../domain/pagamentos/entities/pagamento.js';
import type { NomeProvedorPagamento } from '../../domain/pagamentos/value-objects/evento-pagamento.js';
import {
  type IdTransacaoExterna,
  IdTransacaoExternaSchema,
} from '../../domain/pagamentos/value-objects/ids.js';
import type {
  CheckoutSessionProvider,
  CriarSessaoCheckoutInput,
  CriarSessaoCheckoutResult,
  ObterSessaoCheckoutResult,
} from './checkout-session-provider.js';
import type {
  PagamentoProvider,
  RefundarPagamentoInput,
  RefundarPagamentoResult,
  SolicitarPagamentoInput,
} from './provider.js';

const tracer = trace.getTracer('frame');

export interface PagamentoProviderFakeOptions {
  readonly nomeProvedor?: NomeProvedorPagamento;
  readonly statusResultado?: StatusTransacaoExterna;
  readonly idTransacaoFactory?: () => string;
  readonly clock?: () => Date;
  readonly amountCentsTransacao?: MoneyCents;
  /**
   * Session id factory for the CheckoutSessionProvider stubs
   * (aperture-xaha2). Defaults to a `cs_fake_<uuid>` shape so test
   * assertions can pattern-match. Override in deterministic tests.
   */
  readonly idSessaoFactory?: () => string;
  /**
   * Plan 0015 / aperture-ucgok. Controls what `refundarPagamento` returns.
   * Defaults to 'aceito' (happy-path estorno tests). Set 'recusado' for
   * the rollback-path test (provider refuses; the use-case must not
   * transition pagamento → estornado).
   */
  readonly statusRefund?: 'aceito' | 'recusado';
  readonly idRefundFactory?: () => string;
  /**
   * Plan 0015 / aperture-mjgxe. Controls what
   * `obterAvailableOnDoCharge` returns.
   *   - 'known' (default): returns a deterministic Date offset from the
   *     fake clock by `availableOnOffsetSeconds` (defaults to 6 days,
   *     matching Stripe test-mode).
   *   - 'unknown': returns `null` (the Stripe API "no balance_transaction
   *     yet" or transient-failure path; the dispatcher logs + falls
   *     back to NULL on the pagamento).
   */
  readonly statusBalanceTransaction?: 'known' | 'unknown';
  readonly availableOnOffsetSeconds?: number;
}

/**
 * Provedor fake determinístico para testes e aprendizagem, sem rede e sem
 * SDK externo. Implementa AMBAS as portas — `PagamentoProvider` (síncrono)
 * e `CheckoutSessionProvider` (sessão + webhook, aperture-xaha2) — para
 * que testes de cada fluxo possam injetar uma única instância.
 *
 * **Behaviours under CheckoutSessionProvider:**
 * - `criarSessaoCheckout` returns a deterministic `cs_fake_<uuid>` session
 *   id + a `cs_secret_<uuid>` clientSecret. Stores the session in-memory
 *   keyed by sessionId so `obterSessaoCheckout` can read it back. NO network
 *   call.
 * - `obterSessaoCheckout` returns the in-memory record (status='complete',
 *   paymentStatus='approved' by default — configurable via the constructor
 *   option for failure-path tests). Returns `undefined` for unknown ids.
 */
export class PagamentoProviderFake implements PagamentoProvider, CheckoutSessionProvider {
  private readonly nomeProvedor: NomeProvedorPagamento;
  private readonly statusResultado: StatusTransacaoExterna;
  private readonly idTransacaoFactory: () => string;
  private readonly clock: () => Date;
  private readonly amountCentsTransacao: MoneyCents | undefined;
  private readonly idSessaoFactory: () => string;
  private readonly statusRefund: 'aceito' | 'recusado';
  private readonly idRefundFactory: () => string;
  private readonly statusBalanceTransaction: 'known' | 'unknown';
  private readonly availableOnOffsetSeconds: number;

  /**
   * In-memory ledger of sessions created via criarSessaoCheckout. Keyed
   * by sessionId so obterSessaoCheckout can resolve. Tests inspecting
   * the map directly should use the (internal) `_sessoes` accessor.
   */
  private readonly sessoes = new Map<
    string,
    {
      input: CriarSessaoCheckoutInput;
      result: CriarSessaoCheckoutResult;
    }
  >();

  constructor(options: PagamentoProviderFakeOptions = {}) {
    this.nomeProvedor = options.nomeProvedor ?? 'fake-provider';
    this.statusResultado = options.statusResultado ?? 'aprovado';
    this.idTransacaoFactory = options.idTransacaoFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
    this.amountCentsTransacao = options.amountCentsTransacao;
    this.idSessaoFactory = options.idSessaoFactory ?? (() => `cs_fake_${randomUUID()}`);
    this.statusRefund = options.statusRefund ?? 'aceito';
    this.idRefundFactory = options.idRefundFactory ?? (() => `re_fake_${randomUUID()}`);
    this.statusBalanceTransaction = options.statusBalanceTransaction ?? 'known';
    this.availableOnOffsetSeconds = options.availableOnOffsetSeconds ?? 6 * 24 * 60 * 60;
  }

  async obterAvailableOnDoCharge(chargeRef: string): Promise<Date | null> {
    return tracer.startActiveSpan(
      'payment_provider.fake.obterAvailableOnDoCharge',
      async (span) => {
        span.setAttribute('charge.ref', chargeRef);
        try {
          if (this.statusBalanceTransaction === 'unknown') {
            span.setStatus({ code: SpanStatusCode.OK });
            return null;
          }
          const date = new Date(this.clock().getTime() + this.availableOnOffsetSeconds * 1000);
          span.setStatus({ code: SpanStatusCode.OK });
          return date;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async refundarPagamento(input: RefundarPagamentoInput): Promise<RefundarPagamentoResult> {
    return tracer.startActiveSpan('payment_provider.fake.refundarPagamento', async (span) => {
      span.setAttribute('payment.id', input.idPagamento);
      span.setAttribute('payment.amount_cents', input.amountCents);
      span.setAttribute('refund.reason', input.reason ?? 'requested_by_customer');
      try {
        const result: RefundarPagamentoResult = {
          id: this.idRefundFactory(),
          status: this.statusRefund,
          amountCents: input.amountCents,
          statusBruto: this.statusRefund === 'aceito' ? 'succeeded' : 'failed',
        };
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async solicitarPagamento(input: SolicitarPagamentoInput): Promise<TransacaoExterna> {
    return tracer.startActiveSpan('payment_provider.fake.solicitarPagamento', async (span) => {
      span.setAttribute('payment.id', input.idPagamento);
      span.setAttribute('payment.intent.id', input.idIntencaoPagamento);
      span.setAttribute('payment.amount_cents', input.amountCents);
      span.setAttribute('payment.method', input.metodo);

      try {
        const idTransacao = IdTransacaoExternaSchema.parse(
          this.idTransacaoFactory(),
        ) as IdTransacaoExterna;
        const transacao = TransacaoExternaSchema.parse({
          id: idTransacao,
          provedor: this.nomeProvedor,
          status: this.statusResultado,
          amountCents: this.amountCentsTransacao ?? input.amountCents,
          criadaEm: this.clock(),
          statusBruto: this.statusResultado,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return transacao;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async criarSessaoCheckout(input: CriarSessaoCheckoutInput): Promise<CriarSessaoCheckoutResult> {
    return tracer.startActiveSpan('payment_provider.fake.criarSessaoCheckout', async (span) => {
      span.setAttribute('payment.id', input.idPagamento);
      span.setAttribute('payment.intent.id', input.idIntencaoPagamento);
      span.setAttribute('payment.amount_cents', input.amountCents);
      span.setAttribute('payment.method', input.metodo);
      span.setAttribute('checkout.tipo_opcao', input.tipoOpcao);

      try {
        // Idempotency: same idPagamento → same sessionId on replay. Mirrors
        // the contract documented in CheckoutSessionProvider.
        for (const entry of this.sessoes.values()) {
          if (entry.input.idPagamento === input.idPagamento) {
            span.setStatus({ code: SpanStatusCode.OK });
            return entry.result;
          }
        }

        const sessionId = this.idSessaoFactory();
        const result: CriarSessaoCheckoutResult = {
          sessionId,
          clientSecret: `cs_secret_${randomUUID()}`,
          externalRef: sessionId,
        };
        this.sessoes.set(sessionId, { input, result });

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async obterSessaoCheckout(sessionId: string): Promise<ObterSessaoCheckoutResult | undefined> {
    return tracer.startActiveSpan('payment_provider.fake.obterSessaoCheckout', async (span) => {
      span.setAttribute('checkout.session.id', sessionId);
      try {
        const entry = this.sessoes.get(sessionId);
        if (!entry) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }

        // Default fake behaviour: session completed, payment approved.
        // aperture-m95f3: contribuinte data no longer comes through the
        // CriarSessaoCheckoutInput — the real provider (Stripe) collects
        // it in the iframe. The fake returns deterministic stub values
        // for tests that assert on the post-session read shape.
        const result: ObterSessaoCheckoutResult = {
          sessionId: entry.result.sessionId,
          externalRef: entry.result.externalRef,
          status: 'complete',
          paymentStatus: this.statusResultado === 'aprovado' ? 'approved' : 'rejected',
          customFields: {
            nome: 'Fake Visitor',
            mensagem: '',
          },
          amountTotalCents: entry.input.amountCents,
          contribuinteEmail: 'fake-visitor@example.com',
          contribuinteNome: 'Fake Visitor',
        };

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
