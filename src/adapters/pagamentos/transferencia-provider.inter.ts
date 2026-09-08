import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { type MoneyCents, MoneyCentsSchema } from '../../domain/money.js';
import {
  describeResponseShape,
  extractInterErrorCode,
  InterHttpClient,
  type InterHttpConfig,
  type InterHttpResponse,
  type InterHttpTransport,
  isSuccess,
  parseJson,
} from './inter-http.js';
import {
  type BuscarPagamentosInput,
  type ConsultarPagamentoResult,
  type ConsultarPagamentoStatus,
  type PagamentoEncontrado,
  type PagarPixInput,
  type PagarPixOutcome,
  TransferenciaAmbiguaError,
  type TransferenciaProvider,
  type TransferenciaProviderDiagnostics,
  TransferenciaTransitoriaError,
} from './transferencia-provider.js';

const tracer = trace.getTracer('frame');

/**
 * aperture-gdyii diag — attach zero-PII response-shape metadata to a failure
 * span so "gateway rejected the request" is distinguishable from "bank
 * rejected the business operation" (a bank rejection is JSON with a codigo;
 * a gateway/WAF rejection is typically HTML/empty). Additive to — never a
 * replacement for — the codigo→title→HTTP_<status> erro_code precedence.
 */
function setRespShapeAttrs(span: Span, response: InterHttpResponse): void {
  const shape = describeResponseShape(response);
  span.setAttribute('transferencia.resp_http_status', shape.status);
  // finite classification, never the raw header (unbounded cardinality)
  span.setAttribute('transferencia.resp_content_class', shape.contentClass);
  span.setAttribute('transferencia.resp_body_bytes', shape.bodyByteLength);
  span.setAttribute('transferencia.resp_body_is_json', shape.bodyIsJson);
}

/**
 * Real Banco Inter PIX-out adapter (aperture-ju5w2) for the
 * `TransferenciaProvider` port (spec §3.1). Speaks Inter's Banking API v2
 * over mTLS. Mirrors `transferencia-provider.fake.ts`: an OTel span per
 * method, business outcomes RETURN-TYPED, only infra faults throw.
 *
 * The provider-agnostic HTTP plumbing (mTLS keep-alive agent, OAuth token
 * cache, error-code extraction, transport seam) lives in `inter-http.ts`
 * (aperture-imock, B1 of 2j2j1) and is shared with the PIX-in cobrança
 * adapter under a SEPARATE credential set. Everything money-safety-shaped
 * stays HERE — this file owns the classification policy.
 *
 * MONEY-SAFETY is the whole point of this file. The FSM behind the port
 * treats a `TransferenciaTransitoriaError` as "no payment was created,
 * safe to auto-retry" and EVERY OTHER throw as "a payment MAY exist,
 * divert to `verificando`". A wrong classification either double-pays a
 * repasse or strands one. Every throw site below documents which side of
 * that line it sits on and why.
 *
 * NO-PII (Cipher gate): the chave PIX, CPF/CNPJ and recipient name NEVER
 * appear in a log line, a span attribute, or a thrown/returned error
 * string. Span attributes carry only: the operation name, the repasse-side
 * `referencia`/`valorCents` (our own, non-PII), a boolean `tem_chave`, the
 * HTTP status, an Inter error CODE, and the `codigoSolicitacao`. Inter
 * error bodies are mined for a CODE/field-name only — the raw body may
 * contain the chave/name and is never echoed.
 */

/** Inter `descricao` hard limit (API rejects > 140 chars). */
const DESCRICAO_MAX_LEN = 140;

/** extrato/completo page size + a hard page cap so we never loop forever. */
const EXTRATO_PAGE_SIZE = 100;
const EXTRATO_MAX_PAGES = 200;

/**
 * Transport error codes that are UNAMBIGUOUSLY raised before any
 * application bytes reach Inter — DNS resolution and TCP connect. A
 * failure here guarantees the payment request never went out.
 */
const PRE_SEND_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
]);

/**
 * The PIX-out credential/config shape — structurally the shared
 * `InterHttpConfig`; the alias keeps this adapter's public API stable.
 */
export type InterProviderConfig = InterHttpConfig;

export type { InterHttpResponse, InterHttpTransport } from './inter-http.js';

interface InterPagarPixResponse {
  readonly tipoRetorno?: string;
  readonly codigoSolicitacao?: string;
  readonly codigo?: unknown;
  readonly title?: unknown;
  readonly correlationId?: unknown;
  readonly violacoes?: unknown;
}

interface InterViolation {
  readonly propriedade?: unknown;
  readonly razao?: unknown;
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const FIELD_CLASSIFICATIONS = new Map<
  string,
  NonNullable<TransferenciaProviderDiagnostics['diagnosticField']>
>([
  ['chave', 'pix_key'],
  ['destinatario.chave', 'pix_key'],
  ['valor', 'amount'],
  ['descricao', 'description'],
  ['destinatario', 'recipient'],
]);

const CODE_CLASSIFICATIONS = new Map<string, TransferenciaProviderDiagnostics['diagnosticCode']>([
  ['CHAVE_INVALIDA', 'invalid_pix_key'],
  ['Campo inválido', 'invalid_request'],
  ['Dados inválidos.', 'invalid_request'],
]);

function classifyReason(value: unknown): TransferenciaProviderDiagnostics['diagnosticReason'] {
  if (typeof value !== 'string' || value.length > 256) return 'diagnostic_unavailable';
  const reason = value.normalize('NFC').toLocaleLowerCase('pt-BR');
  if (reason.includes('obrigatório') || reason.includes('obrigatorio')) return 'required';
  if (
    reason.includes('não respeita o schema') ||
    reason.includes('nao respeita o schema') ||
    reason.includes('formato inválido') ||
    reason.includes('formato invalido')
  ) {
    return 'invalid_format';
  }
  if (
    reason.includes('maior que zero') ||
    reason.includes('menor que zero') ||
    reason.includes('não pode ser 0') ||
    reason.includes('nao pode ser 0') ||
    reason.includes('fora do limite')
  ) {
    return 'out_of_range';
  }
  if (reason.includes('não pertence') || reason.includes('nao pertence')) return 'not_owned';
  if (reason.includes('não suportad') || reason.includes('nao suportad')) return 'unsupported';
  return 'diagnostic_unavailable';
}

function readFirstMappedViolation(parsed: InterPagarPixResponse): {
  readonly field: TransferenciaProviderDiagnostics['diagnosticField'];
  readonly reason: TransferenciaProviderDiagnostics['diagnosticReason'];
} {
  if (!Array.isArray(parsed.violacoes)) {
    return { field: null, reason: 'diagnostic_unavailable' };
  }
  for (const candidate of parsed.violacoes) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const violation = candidate as InterViolation;
    if (typeof violation.propriedade !== 'string') continue;
    const field = FIELD_CLASSIFICATIONS.get(violation.propriedade);
    if (field === undefined) continue;
    return { field, reason: classifyReason(violation.razao) };
  }
  return { field: null, reason: 'diagnostic_unavailable' };
}

function readProviderRequestId(parsed: InterPagarPixResponse | null): string | null {
  return parsed !== null &&
    typeof parsed.correlationId === 'string' &&
    CORRELATION_ID_PATTERN.test(parsed.correlationId)
    ? parsed.correlationId
    : null;
}

function safeHttpStatus(statusCode: number): number | null {
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : null;
}

function baseDiagnostics(
  responseClass: TransferenciaProviderDiagnostics['responseClass'],
  overrides: Partial<TransferenciaProviderDiagnostics> = {},
): TransferenciaProviderDiagnostics {
  return {
    operation: 'pagar_pix',
    responseClass,
    httpStatus: null,
    providerRequestId: null,
    diagnosticCode: 'diagnostic_unavailable',
    diagnosticField: null,
    diagnosticReason: 'diagnostic_unavailable',
    ...overrides,
  };
}

/**
 * Converts Inter's documented problem response into a finite, PII-free
 * projection. `detail`, violation `valor`, and every unrecognised/free-text
 * member are ignored. An unknown response stays explicitly unavailable.
 */
export function classifyInterPayoutDiagnostics(
  response: InterHttpResponse,
): TransferenciaProviderDiagnostics {
  const parsed = parseJson<InterPagarPixResponse>(response.body);
  const codeCandidate =
    parsed !== null && typeof parsed.codigo === 'string'
      ? parsed.codigo
      : parsed !== null && typeof parsed.title === 'string'
        ? parsed.title
        : null;
  const isValidationRejection = response.statusCode === 400 || response.statusCode === 422;
  const diagnosticCode =
    codeCandidate === null
      ? 'diagnostic_unavailable'
      : (CODE_CLASSIFICATIONS.get(codeCandidate) ??
        (isValidationRejection ? 'provider_rejection' : 'diagnostic_unavailable'));
  const violation = parsed === null ? null : readFirstMappedViolation(parsed);
  return baseDiagnostics(isValidationRejection ? 'validation_rejection' : 'ambiguous_http', {
    httpStatus: safeHttpStatus(response.statusCode),
    providerRequestId: readProviderRequestId(parsed),
    diagnosticCode,
    diagnosticField: violation?.field ?? null,
    diagnosticReason: violation?.reason ?? 'diagnostic_unavailable',
  });
}

interface InterConsultaResponse {
  readonly transacaoPix?: { readonly status?: string };
}

interface InterExtratoDetalhePix {
  readonly codigoSolicitacao?: string;
  readonly descricaoPix?: string;
  readonly chavePixRecebedor?: string;
  readonly tipoDetalhe?: string;
}

interface InterExtratoTransacao {
  readonly tipoTransacao?: string;
  readonly tipoOperacao?: string;
  readonly valor?: string | number;
  /** Extrato movement date (yyyy-mm-dd), surfaced to admins on a candidate. */
  readonly dataInclusao?: string;
  readonly detalhes?: InterExtratoDetalhePix;
}

interface InterExtratoResponse {
  readonly transacoes?: readonly InterExtratoTransacao[];
  readonly ultimaPagina?: boolean;
  readonly totalPaginas?: number;
}

export class TransferenciaProviderInter implements TransferenciaProvider {
  /**
   * The shared Inter HTTP core: mTLS agent + OAuth token cache + transport,
   * all PER-INSTANCE (this adapter's credential set only).
   */
  private readonly http: InterHttpClient;

  constructor(config: InterProviderConfig, transport?: InterHttpTransport) {
    this.http = new InterHttpClient(config, transport);
  }

  async pagarPix(input: PagarPixInput): Promise<PagarPixOutcome> {
    return tracer.startActiveSpan('transferencia_provider.inter.pagarPix', async (span) => {
      span.setAttribute('transferencia.referencia', input.referencia);
      span.setAttribute('transferencia.valor_cents', input.valorCents);
      // NEVER the chave value — only a boolean presence flag.
      span.setAttribute('transferencia.tem_chave', Boolean(input.chave));

      try {
        // Pre-flight (local) validation. A failure here means we never even
        // built a request, so NO payment can exist → safe-to-retry class.
        if (!input.chave) {
          throw new TransferenciaTransitoriaError('pagarPix: chave ausente (pre-flight)', {
            diagnostics: baseDiagnostics('local_rejection', {
              diagnosticCode: 'invalid_pix_key',
              diagnosticField: 'pix_key',
              diagnosticReason: 'required',
            }),
          });
        }
        if (!Number.isInteger(input.valorCents) || input.valorCents <= 0) {
          throw new TransferenciaTransitoriaError('pagarPix: valorCents inválido (pre-flight)', {
            diagnostics: baseDiagnostics('local_rejection', {
              diagnosticCode: 'invalid_amount',
              diagnosticField: 'amount',
              diagnosticReason: 'out_of_range',
            }),
          });
        }

        // Token fetch. If this fails for ANY reason, the payment request was
        // never sent → TransferenciaTransitoriaError (safe to retry).
        const token = await this.getTokenForPagar(span);

        const requestBody = JSON.stringify({
          valor: centsToReais(input.valorCents),
          destinatario: { tipo: 'CHAVE', chave: input.chave },
          descricao: input.descricao.slice(0, DESCRICAO_MAX_LEN),
        });

        // The moment of truth: the payment request goes on the wire here.
        let response: InterHttpResponse;
        try {
          response = await this.http.request(
            'POST',
            '/banking/v2/pix',
            this.http.jsonHeaders(token),
            requestBody,
          );
        } catch (err: unknown) {
          // A transport failure BEFORE the bytes left (DNS/connect/TLS
          // handshake) is the only post-token case where we are certain no
          // payment exists → safe to retry. Everything else (timeout,
          // reset after send, socket hang up) is ambiguous → plain Error.
          if (isPreSendConnectionError(err)) {
            throw new TransferenciaTransitoriaError('pagarPix: falha de conexão pré-envio', {
              cause: err,
              diagnostics: baseDiagnostics('pre_send_failure'),
            });
          }
          throw new TransferenciaAmbiguaError(
            'pagarPix: falha de transporte pós-envio (ambígua)',
            baseDiagnostics('ambiguous_transport'),
            { cause: err },
          );
        }

        span.setAttribute('transferencia.http_status', response.statusCode);
        const outcome = this.classifyPagarResponse(response, span);
        span.setStatus({ code: SpanStatusCode.OK });
        return outcome;
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
      'transferencia_provider.inter.consultarPagamento',
      async (span) => {
        span.setAttribute('transferencia.codigo_solicitacao', codigoSolicitacao);
        try {
          const token = await this.http.getToken();
          const response = await this.http.request(
            'GET',
            `/banking/v2/pix/${encodeURIComponent(codigoSolicitacao)}`,
            this.http.jsonHeaders(token),
          );
          span.setAttribute('transferencia.http_status', response.statusCode);

          if (!isSuccess(response.statusCode)) {
            // A read failure is not money-moving; surface it as a plain
            // error so the caller can retry the poll.
            throw new Error(`consultarPagamento: HTTP ${response.statusCode}`);
          }

          const parsed = parseJson<InterConsultaResponse>(response.body);
          if (parsed === null) {
            throw new Error('consultarPagamento: resposta ilegível');
          }

          const status = mapConsultStatus(parsed.transacaoPix?.status);
          span.setAttribute('transferencia.status', status);
          span.setStatus({ code: SpanStatusCode.OK });
          return { status, raw: parsed };
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
    return tracer.startActiveSpan('transferencia_provider.inter.buscarPagamentos', async (span) => {
      span.setAttribute('transferencia.data_inicio', input.dataInicio);
      span.setAttribute('transferencia.data_fim', input.dataFim);
      try {
        const token = await this.http.getToken();
        const transacoes = await this.fetchExtratoCompleto(input, token);

        const resultados: PagamentoEncontrado[] = [];
        for (const transacao of transacoes) {
          const encontrado = mapPixOutTransacao(transacao);
          if (encontrado !== null) {
            resultados.push(encontrado);
          }
        }

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

  // --- private helpers -----------------------------------------------------

  /**
   * Token fetch specialised for `pagarPix`: ANY failure is rethrown as a
   * `TransferenciaTransitoriaError`, because failing to obtain a token means
   * the payment request was never sent (no payment can exist → safe retry).
   */
  private async getTokenForPagar(span: Span): Promise<string> {
    try {
      return await this.http.getToken();
    } catch (err: unknown) {
      span.setAttribute('transferencia.token_falhou', true);
      throw new TransferenciaTransitoriaError('pagarPix: falha ao obter token (pré-envio)', {
        cause: err,
        diagnostics: baseDiagnostics('pre_send_failure'),
      });
    }
  }

  /**
   * Maps an Inter PIX-payment HTTP response to a `PagarPixOutcome`.
   *  - 2xx + a "paid" tipoRetorno → `pago`.
   *  - 2xx + an "approval/scheduled" tipoRetorno → `agendado_aprovacao`
   *    (NOT success — the payment sits in Inter's approval workflow).
   *  - 2xx + unknown tipoRetorno or missing codigoSolicitacao → AMBIGUOUS
   *    (a payment likely exists but we cannot classify it) → plain Error.
   *  - 400/422 (clean validation rejection, definitely no payment) →
   *    `rejeitado` with an Inter error CODE.
   *  - any other status (401/403/404/409/429/5xx…) → AMBIGUOUS → plain Error.
   */
  private classifyPagarResponse(response: InterHttpResponse, span: Span): PagarPixOutcome {
    if (isSuccess(response.statusCode)) {
      const parsed = parseJson<InterPagarPixResponse>(response.body);
      if (parsed === null || typeof parsed.codigoSolicitacao !== 'string') {
        // 2xx but we can't recover a codigoSolicitacao — a payment may well
        // have been created. Ambiguous by contract.
        throw new TransferenciaAmbiguaError(
          'pagarPix: 2xx sem codigoSolicitacao (ambíguo)',
          baseDiagnostics('invalid_response', {
            httpStatus: safeHttpStatus(response.statusCode),
            providerRequestId: readProviderRequestId(parsed),
          }),
        );
      }
      const mapped = mapTipoRetorno(parsed.tipoRetorno);
      const diagnostics = baseDiagnostics('accepted', {
        httpStatus: safeHttpStatus(response.statusCode),
        providerRequestId: readProviderRequestId(parsed),
      });
      span.setAttribute('transferencia.codigo_solicitacao', parsed.codigoSolicitacao);
      span.setAttribute('transferencia.tipo_retorno', parsed.tipoRetorno ?? 'DESCONHECIDO');
      if (mapped === 'pago') {
        return { outcome: 'pago', codigoSolicitacao: parsed.codigoSolicitacao, diagnostics };
      }
      if (mapped === 'agendado_aprovacao') {
        return {
          outcome: 'agendado_aprovacao',
          codigoSolicitacao: parsed.codigoSolicitacao,
          diagnostics,
        };
      }
      // Unknown tipoRetorno on a 2xx: the safest reading is that a payment
      // may exist in an unclassifiable state. Do NOT guess a terminal
      // outcome — hand the ambiguity to the caller (→ verificando).
      throw new TransferenciaAmbiguaError(
        'pagarPix: tipoRetorno desconhecido em 2xx (ambíguo)',
        baseDiagnostics('invalid_response', {
          httpStatus: safeHttpStatus(response.statusCode),
          providerRequestId: readProviderRequestId(parsed),
        }),
      );
    }

    if (response.statusCode === 400 || response.statusCode === 422) {
      // A clean client-side validation rejection: Inter refuses the request
      // before creating any payment. Definite no-payment → rejeitado.
      const erro = extractInterErrorCode(response);
      const diagnostics = classifyInterPayoutDiagnostics(response);
      span.setAttribute('transferencia.erro_code', erro);
      setRespShapeAttrs(span, response);
      const codigoSolicitacao = parseJson<InterPagarPixResponse>(response.body)?.codigoSolicitacao;
      return typeof codigoSolicitacao === 'string'
        ? { outcome: 'rejeitado', erro, codigoSolicitacao, diagnostics }
        : { outcome: 'rejeitado', erro, diagnostics };
    }

    // 401/403/404/409/429 and every 5xx: we cannot assert no payment was
    // created (e.g. a 5xx after the payment already landed). Ambiguous.
    span.setAttribute('transferencia.erro_code', extractInterErrorCode(response));
    setRespShapeAttrs(span, response);
    throw new TransferenciaAmbiguaError(
      `pagarPix: HTTP ${response.statusCode} (ambíguo)`,
      classifyInterPayoutDiagnostics(response),
    );
  }

  /** Pages through extrato/completo, accumulating every transaction. */
  private async fetchExtratoCompleto(
    input: BuscarPagamentosInput,
    token: string,
  ): Promise<readonly InterExtratoTransacao[]> {
    const transacoes: InterExtratoTransacao[] = [];
    for (let pagina = 0; pagina < EXTRATO_MAX_PAGES; pagina += 1) {
      const query = new URLSearchParams({
        dataInicio: input.dataInicio,
        dataFim: input.dataFim,
        pagina: String(pagina),
        tamanhoPagina: String(EXTRATO_PAGE_SIZE),
      }).toString();

      const response = await this.http.request(
        'GET',
        `/banking/v2/extrato/completo?${query}`,
        this.http.jsonHeaders(token),
      );
      if (!isSuccess(response.statusCode)) {
        throw new Error(`buscarPagamentos: HTTP ${response.statusCode}`);
      }

      const parsed = parseJson<InterExtratoResponse>(response.body);
      if (parsed === null) {
        throw new Error('buscarPagamentos: resposta ilegível');
      }

      const pageItems = parsed.transacoes ?? [];
      transacoes.push(...pageItems);

      const totalPaginas = parsed.totalPaginas;
      const isLastPage =
        parsed.ultimaPagina === true ||
        pageItems.length === 0 ||
        (typeof totalPaginas === 'number' && pagina >= totalPaginas - 1);
      if (isLastPage) {
        break;
      }
    }
    return transacoes;
  }
}

// --- module-level pure helpers ---------------------------------------------

/** valorCents (integer cents) → reais NUMBER with 2-decimal precision. */
function centsToReais(valorCents: MoneyCents): number {
  return Number((valorCents / 100).toFixed(2));
}

/** reais (string or number, dot or comma decimal) → integer cents. */
function reaisToCents(valor: string | number): number {
  if (typeof valor === 'number') {
    return Math.round(valor * 100);
  }
  // Locale-formatted string: when a comma is present it is the DECIMAL
  // separator and any dots are THOUSANDS separators ('1.234,56' → 123456
  // cents); otherwise the dot is the decimal separator ('1234.56'). The old
  // first-comma-only replace turned '1.234,56' into NaN and silently dropped
  // the row from search — a false zero-candidate (aperture-477nz / GLaDOS).
  const normalized = valor.includes(',') ? valor.replace(/\./g, '').replace(',', '.') : valor;
  return Math.round(Number(normalized) * 100);
}

/**
 * True only for transport errors raised before any application bytes reach
 * Inter (DNS/connect/TLS handshake). These are the sole post-token faults
 * that guarantee no payment was created. ECONNRESET/timeouts are excluded
 * on purpose — they can occur after the request was sent.
 */
function isPreSendConnectionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== 'string') {
    return false;
  }
  if (PRE_SEND_ERROR_CODES.has(code)) {
    return true;
  }
  // TLS handshake failures happen before the HTTP payload is written.
  return code.startsWith('ERR_TLS') || code.includes('CERT') || code.includes('SSL');
}

/**
 * Maps Inter's PIX-payment-CREATE `tipoRetorno` to a coarse outcome.
 *
 * MONEY-SAFETY (aperture-ju5w2, Rex): `'pago'` here books the money
 * immediately (executar stamps transferido_em). So ONLY tipoRetorno values
 * that UNAMBIGUOUSLY assert the payment SETTLED map to `'pago'`:
 * `PAGAMENTO`/`REALIZADO`/`PAGO` (explicit "paid" words). Everything else
 * that a 2xx can carry — `PROCESSADO` (accepted/processing, NOT the same as
 * settled), `APROVACAO`/`AGENDADO` (parked in Inter's approval/schedule
 * flow) — maps to `'agendado_aprovacao'`, which diverts the repasse to
 * `verificando` where `consultarPagamento` confirms the REAL terminal status
 * (PAGO/REALIZADO) before any money is booked. The asymmetry is deliberate:
 * mis-labelling a settled payment as agendado costs one ~30s consult;
 * mis-labelling a still-processing one as `pago` is a false-settlement.
 * NOTE (spec 10.2 / prod smoke): a sandbox round-trip should confirm which
 * value Inter's CURRENT API actually returns on an instant PIX success — if
 * it is `PROCESSADO` and empirically means settled, it can be promoted to
 * the `pago` set THEN, behind that evidence. Unknown → `'desconhecido'`
 * (caller escalates as ambiguous → verificando).
 */
function mapTipoRetorno(
  tipoRetorno: string | undefined,
): 'pago' | 'agendado_aprovacao' | 'desconhecido' {
  switch (tipoRetorno) {
    case 'PAGAMENTO':
    case 'REALIZADO':
    case 'PAGO':
      return 'pago';
    case 'PROCESSADO':
    case 'APROVACAO':
    case 'AGENDADO':
    case 'AGENDADO_APROVACAO':
    case 'AGUARDANDO_APROVACAO':
      return 'agendado_aprovacao';
    default:
      return 'desconhecido';
  }
}

/**
 * Maps Inter's `StatusTransacaoPix` (verified against the SDK clone
 * `bancointer/banking/models/status_transaco_pix.py`) to the port's polling
 * status. Defensive by design: only clearly-settled states become `'pago'`,
 * only clearly-dead states become terminal-failure, and anything unknown or
 * in-flight stays `'em_processamento'` so the caller keeps polling rather
 * than guessing a terminal outcome (a false terminal is what double-pays).
 */
function mapConsultStatus(status: string | undefined): ConsultarPagamentoStatus {
  switch (status) {
    case 'PAGO':
    case 'REALIZADO':
      return 'pago';
    case 'AGUARDANDO_APROVACAO':
      return 'aguardando_aprovacao';
    case 'CANCELADO':
    case 'CANCELADO_SEM_SALDO':
    case 'AGENDAMENTO_CANCELADO':
      return 'cancelado';
    case 'REPROVADO':
    case 'FALHA':
    case 'EXPIRADO':
    case 'NAO_REALIZADO':
    case 'NAO_DEBITADO':
      return 'rejeitado';
    default:
      // CRIADO, TRANSACAO_CRIADA, APROVADO, AGENDADO, ENVIADO, DEBITADO,
      // PARCIALMENTE_*, EM_PROCESSAMENTO and any unknown value: keep polling.
      return 'em_processamento';
  }
}

/**
 * Maps one extrato/completo transaction to a `PagamentoEncontrado` iff it is
 * a PIX-out debit carrying a codigoSolicitacao. Returns null otherwise.
 *
 * `referencia` is populated ONLY from Inter's `descricaoPix` (else ''): the
 * adapter surfaces exactly what Inter returns and never fabricates a
 * reference — the caller owns the matching policy.
 */
function mapPixOutTransacao(transacao: InterExtratoTransacao): PagamentoEncontrado | null {
  const isDebit = transacao.tipoOperacao === 'D';
  const isPix = transacao.tipoTransacao === 'PIX';
  const detalhes = transacao.detalhes;
  const codigoSolicitacao = detalhes?.codigoSolicitacao;
  if (!isDebit || !isPix || typeof codigoSolicitacao !== 'string' || codigoSolicitacao === '') {
    return null;
  }
  if (transacao.valor === undefined) {
    return null;
  }

  const cents = reaisToCents(transacao.valor);
  let valorCents: MoneyCents;
  try {
    valorCents = MoneyCentsSchema.parse(cents);
  } catch {
    // A row whose valor cannot be read as positive integer cents is not a
    // safe reconciliation match; skip it rather than surface a bad amount.
    return null;
  }

  const chave = detalhes?.chavePixRecebedor;
  const dataMovimento = transacao.dataInclusao;
  return {
    codigoSolicitacao,
    valorCents,
    referencia: detalhes?.descricaoPix ?? '',
    // exactOptionalPropertyTypes: include optional fields only when present.
    ...(typeof chave === 'string' && chave !== '' ? { chave } : {}),
    ...(typeof dataMovimento === 'string' && dataMovimento !== '' ? { dataMovimento } : {}),
    status: transacao.tipoTransacao ?? '',
  };
}
