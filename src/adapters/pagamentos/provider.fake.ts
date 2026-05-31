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
import type { PagamentoProvider, SolicitarPagamentoInput } from './provider.js';

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
        // Tests that need 'pending' / 'rejected' / 'expired' shape can
        // post-process via __setStubObterSessao below.
        const result: ObterSessaoCheckoutResult = {
          sessionId: entry.result.sessionId,
          externalRef: entry.result.externalRef,
          status: 'complete',
          paymentStatus: this.statusResultado === 'aprovado' ? 'approved' : 'rejected',
          customFields: {
            nome: entry.input.contribuinte.nome,
            mensagem: '',
          },
          amountTotalCents: entry.input.amountCents,
          contribuinteEmail: entry.input.contribuinte.email,
          contribuinteNome: entry.input.contribuinte.nome,
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
