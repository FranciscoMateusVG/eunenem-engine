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
  /**
   * aperture-4ifbm — enable MAGIC-CHAVE outcome selection for browser E2E.
   * Default false. When true, `pagarPix` inspects `input.chave` for a magic
   * marker and, if present, OVERRIDES the constructor default outcome per that
   * marker (so a single booted server can produce any outcome per-repasse,
   * selected by the recebedor's chave PIX the E2E test sets). When false — OR
   * when the chave carries no marker — behaviour is UNCHANGED (constructor
   * default). See {@link parseE2eMagicChave} for the convention. FAKE-ONLY:
   * the boot guard already prevents the fake in production, and this flag adds
   * a second gate (EUNENEM_FAKE_E2E_MAGIC) so it is off unless E2E opts in.
   */
  readonly e2eMagicOutcomes?: boolean;
}

/**
 * aperture-4ifbm — E2E magic-chave convention (FAKE adapter ONLY; NEVER present
 * in provider.inter.ts). A browser E2E sets the recebedor's chave PIX to:
 *
 *   e2e-outcome-<OUTCOME>[-consult-<STATUS>]@<anything>
 *
 * OUTCOME (drives `pagarPix`): pago | rejeitado | transitorio | ambiguo |
 * timeout | agendado. Two optional segments follow, IN THIS ORDER:
 *
 *   e2e-outcome-<OUTCOME>[-consult-<STATUS>][-search-hit]@<anything>
 *
 * `-consult-<STATUS>` — only meaningful for the `agendado` path
 * (agendado_aprovacao → verificando WITH a codigo → `confirmar` polls
 * `consultarPagamento`); the requested consult status is encoded into the
 * generated codigoSolicitacao so the consult resolves data-driven. STATUS:
 * pago | rejeitado | cancelado | processando | aprovacao. Defaults to `pago`.
 *
 * `-search-hit` — only meaningful for the `ambiguo`/`timeout` paths (which
 * throw → repasse verificando with codigo=null → `confirmar` reconciles via
 * `buscarPagamentos`). When present, `pagarPix` RECORDS a candidate matching
 * this repasse (its valorCents + chave + referencia) so `buscarPagamentos`
 * returns it → `confirmar` flags needs-manual-resolution WITH a candidate list.
 * Absent → the search returns empty → the disarmed zero-candidate path. Each
 * E2E scenario should use a DISTINCT chave (the candidate carries it, and
 * confirmar's match is chave-scoped, so distinct chaves keep scenarios isolated
 * on a shared server).
 */
const E2E_OUTCOME_TOKENS: Readonly<Record<string, PagarPixFakeOutcome>> = {
  pago: 'pago',
  rejeitado: 'rejeitado',
  transitorio: 'transitorio',
  ambiguo: 'ambiguo',
  timeout: 'timeout',
  agendado: 'agendado_aprovacao',
};

const E2E_CONSULT_TOKENS: Readonly<Record<string, ConsultarPagamentoStatus>> = {
  pago: 'pago',
  rejeitado: 'rejeitado',
  cancelado: 'cancelado',
  processando: 'em_processamento',
  aprovacao: 'aguardando_aprovacao',
};

/** Prefix that carries the encoded consult status inside a magic codigoSolicitacao. */
const E2E_CONSULT_CODIGO_PREFIX = 'inter_fake_e2ec-';

/**
 * Parse the E2E magic-chave convention. Returns the selected pagarPix outcome
 * plus the consult short-token (defaults to `pago`), or null when the chave
 * carries no valid marker. Pure — no side effects. The consult token is echoed
 * into the generated codigoSolicitacao and decoded by {@link decodeE2eConsult}.
 */
export function parseE2eMagicChave(chave: string | undefined): {
  readonly outcome: PagarPixFakeOutcome;
  readonly consultToken: string;
  readonly searchHit: boolean;
} | null {
  if (!chave) return null;
  const match = chave.match(/e2e-outcome-([a-z]+)(?:-consult-([a-z]+))?(?:-search-([a-z]+))?/);
  if (!match) return null;
  const outcome = E2E_OUTCOME_TOKENS[match[1] as string];
  if (!outcome) return null;
  const consultToken = match[2] && E2E_CONSULT_TOKENS[match[2]] ? match[2] : 'pago';
  const searchHit = match[3] === 'hit';
  return { outcome, consultToken, searchHit };
}

/**
 * If a codigoSolicitacao was minted by the magic path, decode the consult
 * status it carries; otherwise null (fall back to the scripted consult queue).
 */
function decodeE2eConsult(codigoSolicitacao: string): ConsultarPagamentoStatus | null {
  if (!codigoSolicitacao.startsWith(E2E_CONSULT_CODIGO_PREFIX)) return null;
  const match = codigoSolicitacao.match(/^inter_fake_e2ec-([a-z]+)_/);
  if (!match) return null;
  return E2E_CONSULT_TOKENS[match[1] as string] ?? null;
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
  private readonly e2eMagicOutcomes: boolean;
  /**
   * aperture-4ifbm — candidates recorded by the magic `-search-hit` path so
   * `buscarPagamentos` surfaces them (the E2E reconciliation-with-candidates
   * flow). Appended per magic `pagarPix` call; empty unless a `-search-hit`
   * chave fired.
   */
  private readonly e2eSearchHits: PagamentoEncontrado[] = [];

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
    this.e2eMagicOutcomes = options.e2eMagicOutcomes ?? false;
  }

  /** Times `pagarPix` was invoked — for idempotency assertions (exactly once / never). */
  get pagarPixCalls(): number {
    return this._pagarPixCalls;
  }

  /** Times `consultarPagamento` was invoked. */
  get consultarPagamentoCalls(): number {
    return this._consultarPagamentoCalls;
  }

  /**
   * aperture-4ifbm — resolve the effective outcome + a codigoSolicitacao minter
   * for this pagarPix call, applying the E2E magic-chave override when enabled.
   * Also records the search candidate for the `-search-hit` reconciliation flow
   * (before pagarPix's ambiguo/timeout throw). Pure passthrough (constructor
   * outcome, factory codigo) when magic is off or the chave carries no marker.
   */
  private resolveE2eOutcome(
    input: PagarPixInput,
    span: { setAttribute: (k: string, v: string | number | boolean) => void },
  ): { effectiveOutcome: PagarPixFakeOutcome; mintCodigo: () => string } {
    const magic = this.e2eMagicOutcomes ? parseE2eMagicChave(input.chave) : null;
    const effectiveOutcome: PagarPixFakeOutcome = magic ? magic.outcome : this.pagarPixOutcome;
    const mintCodigo = (): string =>
      magic
        ? `${E2E_CONSULT_CODIGO_PREFIX}${magic.consultToken}_${randomUUID()}`
        : this.codigoSolicitacaoFactory();
    span.setAttribute('transferencia.outcome', effectiveOutcome);
    if (magic) span.setAttribute('transferencia.e2e_magic', true);

    // Record a search candidate for the ambiguo/timeout reconciliation-with-
    // candidates flow (BEFORE the throw so a later buscarPagamentos surfaces it).
    // valorCents matches this repasse so confirmar's valor-guard adopts it;
    // chave is carried for its chave-guard.
    if (magic?.searchHit) {
      this.e2eSearchHits.push({
        codigoSolicitacao: mintCodigo(),
        valorCents: input.valorCents,
        referencia: input.referencia,
        status: 'pago',
        ...(input.chave ? { chave: input.chave } : {}),
      });
    }
    return { effectiveOutcome, mintCodigo };
  }

  async pagarPix(input: PagarPixInput): Promise<PagarPixOutcome> {
    return tracer.startActiveSpan('transferencia_provider.fake.pagarPix', async (span) => {
      this._pagarPixCalls += 1;
      span.setAttribute('transferencia.referencia', input.referencia);
      span.setAttribute('transferencia.valor_cents', input.valorCents);
      // NEVER set the chave PIX as a span attribute — only a boolean flag.
      span.setAttribute('transferencia.tem_chave', Boolean(input.chave));

      const { effectiveOutcome, mintCodigo } = this.resolveE2eOutcome(input, span);

      try {
        switch (effectiveOutcome) {
          case 'pago': {
            const outcome: PagarPixOutcome = {
              outcome: 'pago',
              codigoSolicitacao: mintCodigo(),
            };
            span.setStatus({ code: SpanStatusCode.OK });
            return outcome;
          }
          case 'agendado_aprovacao': {
            const outcome: PagarPixOutcome = {
              outcome: 'agendado_aprovacao',
              codigoSolicitacao: mintCodigo(),
            };
            span.setStatus({ code: SpanStatusCode.OK });
            return outcome;
          }
          case 'rejeitado': {
            const outcome: PagarPixOutcome = {
              outcome: 'rejeitado',
              erro: this.erroRejeicao,
              ...(this.incluiCodigoNaRejeicao ? { codigoSolicitacao: mintCodigo() } : {}),
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
          // aperture-4ifbm — a magic codigoSolicitacao (minted by the E2E magic
          // pagarPix path) carries its consult status; decode it and return
          // that terminal status directly. Otherwise use the scripted queue.
          const encoded = this.e2eMagicOutcomes ? decodeE2eConsult(codigoSolicitacao) : null;
          // Shift the next scripted status; once the queue has a single
          // element left, keep returning it forever (terminal status sticks).
          const status =
            encoded ??
            (this.consultQueue.length > 1
              ? (this.consultQueue.shift() as ConsultarPagamentoStatus)
              : (this.consultQueue[0] as ConsultarPagamentoStatus));
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
        // aperture-4ifbm — union the boot-configured results with any
        // magic `-search-hit` candidates recorded by pagarPix.
        const resultados = [...this.buscarResultados, ...this.e2eSearchHits];
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
