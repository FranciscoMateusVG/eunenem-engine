import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type BuscarPagamentosInput,
  type ConsultarPagamentoResult,
  type ConsultarPagamentoStatus,
  type PagamentoEncontrado,
  type PagarPixInput,
  type PagarPixOutcome,
  type TransferenciaProvider,
  TransferenciaTransitoriaError,
} from './transferencia-provider.js';

const tracer = trace.getTracer('frame');

/**
 * Drives what `pagarPix` does on the fake. See the port contract
 * (`provider.ts`, spec §3.1/§6) for why each outcome matters:
 *  - 'pago' / 'agendado_aprovacao' / 'rejeitado' → RETURN-TYPED outcomes.
 *  - 'transitorio' → THROWS `TransferenciaTransitoriaError` (asserts NO
 *    payment created; the sole safe-to-retry class).
 *  - 'ambiguo' → THROWS a plain `Error` (a payment MAY exist; the caller
 *    diverts the repasse to `verificando`).
 *  - 'timeout' → THROWS a plain `Error` (modelled as a thrown error, never
 *    an actual hang, so unit tests stay fast; treated as ambiguous).
 */
export type PagarPixFakeOutcome =
  | 'pago'
  | 'agendado_aprovacao'
  | 'rejeitado'
  | 'transitorio'
  | 'ambiguo'
  | 'timeout';

export interface TransferenciaProviderFakeOptions {
  /** What `pagarPix` does. Default 'pago'. */
  readonly pagarPixOutcome?: PagarPixFakeOutcome;
  /** codigoSolicitacao generator. Default `inter_fake_<uuid>`. */
  readonly codigoSolicitacaoFactory?: () => string;
  /** When false, the 'rejeitado' outcome omits codigoSolicitacao. Default true. */
  readonly incluiCodigoNaRejeicao?: boolean;
  /** Inter-style error CODE (no PII) on rejection. Default 'FAKE_REJECTED'. */
  readonly erroRejeicao?: string;
  /** Message for the transitorio/ambiguo throw paths. */
  readonly erroMensagem?: string;
  /**
   * Scripted QUEUE of statuses that `consultarPagamento` shifts through on
   * successive calls. Each call shifts the next status off a private mutable
   * copy; once exhausted, the LAST status repeats forever (so a caller
   * polling after settlement keeps seeing the terminal status). Default
   * `['pago']`.
   */
  readonly consultSequence?: readonly ConsultarPagamentoStatus[];
  /** Reconciliation-search results returned by `buscarPagamentos`. Default `[]`. */
  readonly buscarResultados?: readonly PagamentoEncontrado[];
}

/**
 * Deterministic test/staging adapter for the `TransferenciaProvider` port
 * (aperture-vvh2j). No network, no Inter SDK. Mirrors `PagamentoProviderFake`:
 * constructor-options-object with `??` defaults, OTel span per method, and a
 * write-path try/catch/finally that records exceptions on the throw paths.
 *
 * Business outcomes of `pagarPix` are RETURN-TYPED; only infra-shaped faults
 * throw (see `PagarPixFakeOutcome`). The chave PIX is NEVER set as a span
 * attribute — only a boolean `transferencia.tem_chave` flag.
 */
export class TransferenciaProviderFake implements TransferenciaProvider {
  private readonly pagarPixOutcome: PagarPixFakeOutcome;
  private readonly codigoSolicitacaoFactory: () => string;
  private readonly incluiCodigoNaRejeicao: boolean;
  private readonly erroRejeicao: string;
  private readonly erroMensagem: string;
  private readonly buscarResultados: readonly PagamentoEncontrado[];

  /**
   * Private mutable copy of the scripted consult queue. `consultarPagamento`
   * shifts off the head each call; the last element is retained and repeated
   * once the queue drains.
   */
  private readonly consultQueue: ConsultarPagamentoStatus[];

  private _pagarPixCalls = 0;
  private _consultarPagamentoCalls = 0;

  constructor(options: TransferenciaProviderFakeOptions = {}) {
    this.pagarPixOutcome = options.pagarPixOutcome ?? 'pago';
    this.codigoSolicitacaoFactory =
      options.codigoSolicitacaoFactory ?? (() => `inter_fake_${randomUUID()}`);
    this.incluiCodigoNaRejeicao = options.incluiCodigoNaRejeicao ?? true;
    this.erroRejeicao = options.erroRejeicao ?? 'FAKE_REJECTED';
    this.erroMensagem = options.erroMensagem ?? 'fake transient/ambiguous failure';
    this.consultQueue = [...(options.consultSequence ?? ['pago'])];
    this.buscarResultados = options.buscarResultados ?? [];
  }

  /** Times `pagarPix` was invoked — for idempotency assertions (exactly once / never). */
  get pagarPixCalls(): number {
    return this._pagarPixCalls;
  }

  /** Times `consultarPagamento` was invoked. */
  get consultarPagamentoCalls(): number {
    return this._consultarPagamentoCalls;
  }

  async pagarPix(input: PagarPixInput): Promise<PagarPixOutcome> {
    return tracer.startActiveSpan('transferencia_provider.fake.pagarPix', async (span) => {
      this._pagarPixCalls += 1;
      span.setAttribute('transferencia.referencia', input.referencia);
      span.setAttribute('transferencia.valor_cents', input.valorCents);
      // NEVER set the chave PIX as a span attribute — only a boolean flag.
      span.setAttribute('transferencia.tem_chave', Boolean(input.chave));
      span.setAttribute('transferencia.outcome', this.pagarPixOutcome);

      try {
        switch (this.pagarPixOutcome) {
          case 'pago': {
            const outcome: PagarPixOutcome = {
              outcome: 'pago',
              codigoSolicitacao: this.codigoSolicitacaoFactory(),
            };
            span.setStatus({ code: SpanStatusCode.OK });
            return outcome;
          }
          case 'agendado_aprovacao': {
            const outcome: PagarPixOutcome = {
              outcome: 'agendado_aprovacao',
              codigoSolicitacao: this.codigoSolicitacaoFactory(),
            };
            span.setStatus({ code: SpanStatusCode.OK });
            return outcome;
          }
          case 'rejeitado': {
            const outcome: PagarPixOutcome = {
              outcome: 'rejeitado',
              erro: this.erroRejeicao,
              ...(this.incluiCodigoNaRejeicao
                ? { codigoSolicitacao: this.codigoSolicitacaoFactory() }
                : {}),
            };
            span.setStatus({ code: SpanStatusCode.OK });
            return outcome;
          }
          case 'transitorio':
            // Safe-to-retry: asserts the request never created a payment.
            throw new TransferenciaTransitoriaError(this.erroMensagem);
          case 'ambiguo':
            // Ambiguous: a payment MAY exist → caller diverts to `verificando`.
            throw new Error(this.erroMensagem);
          case 'timeout':
            // Modelled as a thrown error (never an actual hang). Ambiguous.
            throw new Error('transferencia fake timeout');
        }
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async consultarPagamento(codigoSolicitacao: string): Promise<ConsultarPagamentoResult> {
    return tracer.startActiveSpan(
      'transferencia_provider.fake.consultarPagamento',
      async (span) => {
        this._consultarPagamentoCalls += 1;
        span.setAttribute('transferencia.codigo_solicitacao', codigoSolicitacao);
        try {
          // Shift the next scripted status; once the queue has a single
          // element left, keep returning it forever (terminal status sticks).
          const status =
            this.consultQueue.length > 1
              ? (this.consultQueue.shift() as ConsultarPagamentoStatus)
              : (this.consultQueue[0] as ConsultarPagamentoStatus);
          const result: ConsultarPagamentoResult = {
            status,
            raw: { fake: true, status },
          };
          span.setAttribute('transferencia.status', status);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
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

  async buscarPagamentos(input: BuscarPagamentosInput): Promise<readonly PagamentoEncontrado[]> {
    return tracer.startActiveSpan('transferencia_provider.fake.buscarPagamentos', async (span) => {
      span.setAttribute('transferencia.data_inicio', input.dataInicio);
      span.setAttribute('transferencia.data_fim', input.dataFim);
      try {
        const resultados = this.buscarResultados;
        span.setAttribute('transferencia.resultados_count', resultados.length);
        span.setStatus({ code: SpanStatusCode.OK });
        return resultados;
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
