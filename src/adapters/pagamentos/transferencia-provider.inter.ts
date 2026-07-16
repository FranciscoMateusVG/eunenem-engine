import https from 'node:https';
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { type MoneyCents, MoneyCentsSchema } from '../../domain/money.js';
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
 * Real Banco Inter PIX-out adapter (aperture-ju5w2) for the
 * `TransferenciaProvider` port (spec §3.1). Speaks Inter's Banking API v2
 * over mTLS. Mirrors `transferencia-provider.fake.ts`: an OTel span per
 * method, business outcomes RETURN-TYPED, only infra faults throw.
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

/** Milliseconds of headroom before token expiry at which we refresh. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Per-request socket timeout. A timeout is ALWAYS ambiguous (post-send). */
const REQUEST_TIMEOUT_MS = 30_000;

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

export interface InterProviderConfig {
  /** e.g. prod `https://cdpj.partners.bancointer.com.br`. Never hardcoded. */
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Space-separated OAuth scopes, e.g. `pagamento-pix.write extrato.read`. */
  readonly scope: string;
  /** Already-decoded client certificate PEM text (mTLS). */
  readonly certPem: string;
  /** Already-decoded private key PEM text (mTLS). */
  readonly keyPem: string;
  /** Optional Inter conta-corrente; sent as `x-conta-corrente` when set. */
  readonly contaCorrente?: string;
}

export interface InterHttpResponse {
  readonly statusCode: number;
  readonly body: string;
}

/**
 * The mTLS transport seam. Production uses {@link TransferenciaProviderInter}'s
 * own `node:https` implementation; tests inject a scripted transport to
 * exercise the money-safety classification WITHOUT a live Inter or real TLS.
 * A transport MUST reject (throw) on a connection-level failure (so the caller
 * can classify pre-send vs ambiguous) and MUST resolve — never reject — on any
 * received HTTP status.
 */
export type InterHttpTransport = (
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<InterHttpResponse>;

interface InterTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

interface InterPagarPixResponse {
  readonly tipoRetorno?: string;
  readonly codigoSolicitacao?: string;
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
  readonly detalhes?: InterExtratoDetalhePix;
}

interface InterExtratoResponse {
  readonly transacoes?: readonly InterExtratoTransacao[];
  readonly ultimaPagina?: boolean;
  readonly totalPaginas?: number;
}

interface InterErrorBody {
  readonly codigo?: unknown;
  readonly title?: unknown;
}

type TokenCache = { readonly accessToken: string; readonly expiresAtMs: number };

export class TransferenciaProviderInter implements TransferenciaProvider {
  private readonly config: InterProviderConfig;

  /** ONE mTLS agent, reused for every request (token + banking). */
  private readonly agent: https.Agent;

  /** In-memory OAuth token cache; refreshed within the safety margin. */
  private tokenCache: TokenCache | null = null;

  /** The transport actually used for every request (real mTLS or injected). */
  private readonly transport: InterHttpTransport;

  constructor(config: InterProviderConfig, transport?: InterHttpTransport) {
    this.config = config;
    // Default TLS verification MUST stay ON: no `rejectUnauthorized`, no
    // custom `ca`, no `NODE_TLS_REJECT_UNAUTHORIZED`. We only present the
    // client cert/key for mutual TLS.
    this.agent = new https.Agent({
      cert: config.certPem,
      key: config.keyPem,
      keepAlive: true,
    });
    // Injected transport (tests) or the real mTLS `node:https` sender.
    this.transport = transport ?? this.sendOverMtls.bind(this);
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
          throw new TransferenciaTransitoriaError('pagarPix: chave ausente (pre-flight)');
        }
        if (!Number.isInteger(input.valorCents) || input.valorCents <= 0) {
          throw new TransferenciaTransitoriaError('pagarPix: valorCents inválido (pre-flight)');
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
          response = await this.transport(
            'POST',
            '/banking/v2/pix',
            this.jsonHeaders(token),
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
            });
          }
          throw new Error('pagarPix: falha de transporte pós-envio (ambígua)', { cause: err });
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
          const token = await this.getToken();
          const response = await this.transport(
            'GET',
            `/banking/v2/pix/${encodeURIComponent(codigoSolicitacao)}`,
            this.jsonHeaders(token),
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
        const token = await this.getToken();
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
      return await this.getToken();
    } catch (err: unknown) {
      span.setAttribute('transferencia.token_falhou', true);
      throw new TransferenciaTransitoriaError('pagarPix: falha ao obter token (pré-envio)', {
        cause: err,
      });
    }
  }

  /** Returns a cached token when still fresh, else fetches and caches one. */
  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache !== null && this.tokenCache.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now) {
      return this.tokenCache.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: this.config.scope,
    }).toString();

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    this.applyContaCorrente(headers);

    const response = await this.transport('POST', '/oauth/v2/token', headers, body);
    if (!isSuccess(response.statusCode)) {
      // NO-PII: never echo the token error body (it echoes nothing sensitive
      // here, but we keep to codes on principle).
      throw new Error(`token: HTTP ${response.statusCode}`);
    }

    const parsed = parseJson<InterTokenResponse>(response.body);
    if (parsed === null || typeof parsed.access_token !== 'string' || !parsed.access_token) {
      throw new Error('token: resposta sem access_token');
    }

    const expiresInMs =
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0
        ? parsed.expires_in * 1000
        : TOKEN_REFRESH_MARGIN_MS;
    this.tokenCache = {
      accessToken: parsed.access_token,
      expiresAtMs: Date.now() + expiresInMs,
    };
    return parsed.access_token;
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
        throw new Error('pagarPix: 2xx sem codigoSolicitacao (ambíguo)');
      }
      const mapped = mapTipoRetorno(parsed.tipoRetorno);
      span.setAttribute('transferencia.codigo_solicitacao', parsed.codigoSolicitacao);
      span.setAttribute('transferencia.tipo_retorno', parsed.tipoRetorno ?? 'DESCONHECIDO');
      if (mapped === 'pago') {
        return { outcome: 'pago', codigoSolicitacao: parsed.codigoSolicitacao };
      }
      if (mapped === 'agendado_aprovacao') {
        return { outcome: 'agendado_aprovacao', codigoSolicitacao: parsed.codigoSolicitacao };
      }
      // Unknown tipoRetorno on a 2xx: the safest reading is that a payment
      // may exist in an unclassifiable state. Do NOT guess a terminal
      // outcome — hand the ambiguity to the caller (→ verificando).
      throw new Error('pagarPix: tipoRetorno desconhecido em 2xx (ambíguo)');
    }

    if (response.statusCode === 400 || response.statusCode === 422) {
      // A clean client-side validation rejection: Inter refuses the request
      // before creating any payment. Definite no-payment → rejeitado.
      const erro = extractInterErrorCode(response);
      span.setAttribute('transferencia.erro_code', erro);
      const codigoSolicitacao = parseJson<InterPagarPixResponse>(response.body)?.codigoSolicitacao;
      return typeof codigoSolicitacao === 'string'
        ? { outcome: 'rejeitado', erro, codigoSolicitacao }
        : { outcome: 'rejeitado', erro };
    }

    // 401/403/404/409/429 and every 5xx: we cannot assert no payment was
    // created (e.g. a 5xx after the payment already landed). Ambiguous.
    span.setAttribute('transferencia.erro_code', extractInterErrorCode(response));
    throw new Error(`pagarPix: HTTP ${response.statusCode} (ambíguo)`);
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

      const response = await this.transport(
        'GET',
        `/banking/v2/extrato/completo?${query}`,
        this.jsonHeaders(token),
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

  /** Builds a Promise around a single mTLS request. Never rejects on status. */
  private sendOverMtls(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<InterHttpResponse> {
    return new Promise<InterHttpResponse>((resolve, reject) => {
      const url = new URL(path, this.config.baseUrl);
      const options: https.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers,
        agent: this.agent,
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        // A timeout is ambiguous by design: the request may already be
        // sitting at Inter. We destroy with a NON-pre-send code so the
        // caller classifies it as ambiguous, never as safe-to-retry.
        req.destroy(Object.assign(new Error('inter request timeout'), { code: 'INTER_TIMEOUT' }));
      });
      req.on('error', (err: unknown) => reject(err));

      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }

  private jsonHeaders(token: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    this.applyContaCorrente(headers);
    return headers;
  }

  private applyContaCorrente(headers: Record<string, string>): void {
    if (this.config.contaCorrente !== undefined && this.config.contaCorrente !== '') {
      headers['x-conta-corrente'] = this.config.contaCorrente;
    }
  }
}

// --- module-level pure helpers ---------------------------------------------

function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

/** valorCents (integer cents) → reais NUMBER with 2-decimal precision. */
function centsToReais(valorCents: MoneyCents): number {
  return Number((valorCents / 100).toFixed(2));
}

/** reais (string or number, dot or comma decimal) → integer cents. */
function reaisToCents(valor: string | number): number {
  const normalized = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
  return Math.round(normalized * 100);
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
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
 * Extracts a NO-PII error code from an Inter error response. Prefers a
 * machine `codigo`, falls back to the short error `title` (a generic error
 * label, never the chave/name value), and finally to the HTTP status. The
 * `detail`/`violacoes` fields are deliberately ignored — they can echo the
 * chave or recipient name.
 */
function extractInterErrorCode(response: InterHttpResponse): string {
  const parsed = parseJson<InterErrorBody>(response.body);
  if (parsed !== null) {
    if (typeof parsed.codigo === 'string' && parsed.codigo !== '') {
      return parsed.codigo;
    }
    if (typeof parsed.codigo === 'number') {
      return String(parsed.codigo);
    }
    if (typeof parsed.title === 'string' && parsed.title !== '') {
      return parsed.title;
    }
  }
  return `HTTP_${response.statusCode}`;
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
  return {
    codigoSolicitacao,
    valorCents,
    referencia: detalhes?.descricaoPix ?? '',
    // exactOptionalPropertyTypes: include `chave` only when present.
    ...(typeof chave === 'string' && chave !== '' ? { chave } : {}),
    status: transacao.tipoTransacao ?? '',
  };
}
