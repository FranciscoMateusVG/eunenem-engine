import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import type { MoneyCents } from '../../domain/money.js';
import {
  IdIntencaoPagamentoSchema,
  IdPagamentoSchema,
} from '../../domain/pagamentos/value-objects/ids.js';
import {
  extractInterErrorCode,
  InterHttpClient,
  type InterHttpConfig,
  type InterHttpResponse,
  type InterHttpTransport,
  isSuccess,
  parseJson,
} from './inter-http.js';
import {
  type CobrancaCriada,
  type ConsultarCobrancaResult,
  type CriarCobrancaInput,
  type DevolucaoOutcome,
  PixCobrancaAmbiguaError,
  type PixCobrancaProvider,
  PixCobrancaTransitoriaError,
  type SolicitarDevolucaoInput,
} from './pix-cobranca-provider.js';

const tracer = trace.getTracer('frame');

const CHARGE_EXPIRATION_SECONDS = 600;
const DESCRIPTION_MAX_LENGTH = 140;
// Inter's Pix OpenAPI money schema is `\d{1,10}\.\d{2}`. Keep both outgoing
// formatting and authoritative response parsing inside that exact wire domain.
const INTER_MAX_AMOUNT_CENTS = 999_999_999_999;
const INTER_MONEY_PATTERN = /^(\d{1,10})\.(\d{2})$/;
const TXID_PATTERN = /^[A-Za-z0-9]{26,35}$/;
const E2E_ID_PATTERN = /^[A-Za-z0-9]{32}$/;
const REFUND_ID_PATTERN = /^[A-Za-z0-9]{1,35}$/;

/** Errors which prove no HTTP application bytes reached Inter. */
const PRE_SEND_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
]);

export interface InterPixCobrancaConfig extends InterHttpConfig {
  /** Receiving PIX key registered for this cobrança integration. Never logged. */
  readonly pixKey: string;
}

export type { InterHttpResponse, InterHttpTransport } from './inter-http.js';

interface InterCalendario {
  readonly criacao?: unknown;
  readonly expiracao?: unknown;
}

interface InterPixSettlement {
  readonly endToEndId?: unknown;
  readonly valor?: unknown;
  readonly horario?: unknown;
}

interface InterCobrancaResponse {
  readonly txid?: unknown;
  readonly pixCopiaECola?: unknown;
  readonly calendario?: InterCalendario;
  readonly status?: unknown;
  readonly pix?: unknown;
}

interface InterDevolucaoResponse {
  readonly id?: unknown;
  readonly valor?: unknown;
  readonly status?: unknown;
  readonly rtrId?: unknown;
  readonly motivo?: unknown;
}

/**
 * Real Banco Inter PIX-in adapter. The shared client owns this credential
 * set's mTLS agent and token cache; all money-direction classification stays
 * here. No response body, PIX key, payer data or BR Code is ever logged or
 * embedded in an error message.
 */
export class PixCobrancaProviderInter implements PixCobrancaProvider {
  private readonly http: InterHttpClient;
  private readonly pixKey: string;

  constructor(config: InterPixCobrancaConfig, transport?: InterHttpTransport) {
    this.http = new InterHttpClient(config, transport);
    this.pixKey = config.pixKey;
  }

  async criarCobranca(input: CriarCobrancaInput): Promise<CobrancaCriada> {
    return this.withSpan('pix_cobranca.inter.criar', async (span) => {
      validateCreateInput(input);
      span.setAttribute('cobranca.valor_cents', input.amountCents);

      const txid = input.idPagamento.replaceAll('-', '');
      span.setAttribute('cobranca.txid', txid);

      const token = await this.getTokenTransient('criarCobranca');
      const payload = {
        calendario: { expiracao: CHARGE_EXPIRATION_SECONDS },
        valor: { original: formatCents(input.amountCents) },
        chave: this.pixKey,
        ...(input.solicitacaoPagador !== undefined
          ? { solicitacaoPagador: input.solicitacaoPagador }
          : {}),
      };

      let response: InterHttpResponse;
      try {
        response = await this.http.request(
          'PUT',
          `/pix/v2/cob/${txid}`,
          this.http.jsonHeaders(token),
          JSON.stringify(payload),
        );
      } catch {
        // PUT + deterministic txid converges on retry, even when the first
        // response was lost after Inter received the request.
        throw new PixCobrancaTransitoriaError('criarCobranca: falha de transporte');
      }
      span.setAttribute('cobranca.http_status', response.statusCode);

      if (!isSuccess(response.statusCode)) {
        const code = extractInterErrorCode(response);
        span.setAttribute('cobranca.inter_error_code', code);
        throw new PixCobrancaTransitoriaError(`criarCobranca: ${code}`);
      }

      const parsed = parseJson<InterCobrancaResponse>(response.body);
      const result = parseCreatedCharge(parsed, txid);
      if (result === null) {
        // An identically-keyed PUT is safe and is the only recovery path for
        // a malformed/lost create response.
        throw new PixCobrancaTransitoriaError('criarCobranca: resposta inválida');
      }
      return result;
    });
  }

  async consultarCobranca(txid: string): Promise<ConsultarCobrancaResult> {
    return this.withSpan('pix_cobranca.inter.consultar', async (span) => {
      if (!TXID_PATTERN.test(txid)) {
        throw new PixCobrancaTransitoriaError('consultarCobranca: txid inválido');
      }
      span.setAttribute('cobranca.txid', txid);

      const token = await this.getTokenTransient('consultarCobranca');
      let response: InterHttpResponse;
      try {
        response = await this.http.request(
          'GET',
          `/pix/v2/cob/${encodeURIComponent(txid)}`,
          this.http.jsonHeaders(token),
        );
      } catch {
        throw new PixCobrancaTransitoriaError('consultarCobranca: falha de transporte');
      }
      span.setAttribute('cobranca.http_status', response.statusCode);

      if (!isSuccess(response.statusCode)) {
        const code = extractInterErrorCode(response);
        span.setAttribute('cobranca.inter_error_code', code);
        throw new PixCobrancaTransitoriaError(`consultarCobranca: ${code}`);
      }

      const parsed = parseJson<InterCobrancaResponse>(response.body);
      return classifyCharge(parsed, txid);
    });
  }

  async solicitarDevolucao(input: SolicitarDevolucaoInput): Promise<DevolucaoOutcome> {
    return this.withSpan('pix_cobranca.inter.solicitar_devolucao', async (span) => {
      validateRefundInput(input);
      span.setAttribute('cobranca.valor_cents', input.amountCents);

      // Token/pre-flight failure happens before the money-out PUT exists.
      const token = await this.getTokenTransient('solicitarDevolucao');
      const body = JSON.stringify({
        valor: formatCents(input.amountCents),
        ...(input.descricao !== undefined ? { descricao: input.descricao } : {}),
      });

      let response: InterHttpResponse;
      try {
        response = await this.http.request(
          'PUT',
          refundPath(input.e2eId, input.idDevolucao),
          this.http.jsonHeaders(token),
          body,
        );
      } catch (error: unknown) {
        if (isPreSendConnectionError(error)) {
          throw new PixCobrancaTransitoriaError('solicitarDevolucao: falha de conexão pré-envio');
        }
        throw new PixCobrancaAmbiguaError('solicitarDevolucao: falha de transporte pós-envio');
      }
      span.setAttribute('cobranca.http_status', response.statusCode);
      return classifyRefundResponse(
        response,
        span,
        'solicitarDevolucao',
        input.idDevolucao,
        input.amountCents,
        true,
      );
    });
  }

  async consultarDevolucao(e2eId: string, idDevolucao: string): Promise<DevolucaoOutcome> {
    return this.withSpan('pix_cobranca.inter.consultar_devolucao', async (span) => {
      validateRefundIds(e2eId, idDevolucao, 'consultarDevolucao');
      const token = await this.getTokenTransient('consultarDevolucao');

      let response: InterHttpResponse;
      try {
        response = await this.http.request(
          'GET',
          refundPath(e2eId, idDevolucao),
          this.http.jsonHeaders(token),
        );
      } catch {
        // GET cannot move money; retrying the read is always safe.
        throw new PixCobrancaTransitoriaError('consultarDevolucao: falha de transporte');
      }
      span.setAttribute('cobranca.http_status', response.statusCode);
      return classifyRefundResponse(
        response,
        span,
        'consultarDevolucao',
        idDevolucao,
        undefined,
        false,
      );
    });
  }

  private async getTokenTransient(operation: string): Promise<string> {
    try {
      return await this.http.getToken();
    } catch {
      throw new PixCobrancaTransitoriaError(`${operation}: falha ao obter token`);
    }
  }

  private async withSpan<T>(operation: string, action: (span: Span) => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(operation, async (span) => {
      try {
        const result = await action(span);
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

function validateCreateInput(input: CriarCobrancaInput): void {
  if (
    !IdPagamentoSchema.safeParse(input.idPagamento).success ||
    !IdIntencaoPagamentoSchema.safeParse(input.idIntencaoPagamento).success
  ) {
    throw new PixCobrancaTransitoriaError('criarCobranca: identificador inválido');
  }
  validateAmount(input.amountCents, 'criarCobranca');
  if (
    input.solicitacaoPagador !== undefined &&
    input.solicitacaoPagador.length > DESCRIPTION_MAX_LENGTH
  ) {
    throw new PixCobrancaTransitoriaError('criarCobranca: descrição inválida');
  }
}

function validateRefundInput(input: SolicitarDevolucaoInput): void {
  validateRefundIds(input.e2eId, input.idDevolucao, 'solicitarDevolucao');
  validateAmount(input.amountCents, 'solicitarDevolucao');
  if (input.descricao !== undefined && input.descricao.length > DESCRIPTION_MAX_LENGTH) {
    throw new PixCobrancaTransitoriaError('solicitarDevolucao: descrição inválida');
  }
}

function validateRefundIds(e2eId: string, idDevolucao: string, operation: string): void {
  if (!E2E_ID_PATTERN.test(e2eId) || !REFUND_ID_PATTERN.test(idDevolucao)) {
    throw new PixCobrancaTransitoriaError(`${operation}: identificador inválido`);
  }
}

function validateAmount(amountCents: MoneyCents, operation: string): void {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > INTER_MAX_AMOUNT_CENTS
  ) {
    throw new PixCobrancaTransitoriaError(`${operation}: valor inválido`);
  }
}

function parseCreatedCharge(
  response: InterCobrancaResponse | null,
  expectedTxid: string,
): CobrancaCriada | null {
  if (
    response === null ||
    response.txid !== expectedTxid ||
    typeof response.pixCopiaECola !== 'string' ||
    response.pixCopiaECola.length === 0 ||
    response.pixCopiaECola.length > 512 ||
    response.calendario === undefined ||
    typeof response.calendario.criacao !== 'string' ||
    typeof response.calendario.expiracao !== 'number' ||
    !Number.isSafeInteger(response.calendario.expiracao) ||
    response.calendario.expiracao <= 0
  ) {
    return null;
  }

  const createdAtMs = Date.parse(response.calendario.criacao);
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }
  const expiresAtMs = createdAtMs + response.calendario.expiracao * 1000;
  if (!Number.isSafeInteger(expiresAtMs)) {
    return null;
  }
  return {
    txid: expectedTxid,
    pixCopiaECola: response.pixCopiaECola,
    expiraEm: new Date(expiresAtMs),
  };
}

function classifyCharge(
  response: InterCobrancaResponse | null,
  expectedTxid: string,
): ConsultarCobrancaResult {
  if (
    response === null ||
    response.txid !== expectedTxid ||
    typeof response.status !== 'string' ||
    response.status.length === 0
  ) {
    throw new PixCobrancaTransitoriaError('consultarCobranca: resposta inválida');
  }
  const rawStatus = response.status;
  switch (rawStatus.toUpperCase()) {
    case 'ATIVA':
      return { status: 'ativa' };
    case 'REMOVIDA_PELO_USUARIO_RECEBEDOR':
    case 'REMOVIDA_PELO_PSP':
      return { status: 'removida' };
    case 'CONCLUIDA': {
      const settlement = parseSingleSettlement(response?.pix);
      if (settlement === null) {
        // Inter asserted the hazardous paid transition but did not provide
        // exactly one complete settlement. Do not downgrade that malformed
        // assertion to an ordinary unknown status: fail the authoritative
        // read so the caller retries/reconciles instead of accepting or
        // silently parking corrupt settlement evidence.
        throw new PixCobrancaTransitoriaError('consultarCobranca: liquidação CONCLUIDA inválida');
      }
      return settlement;
    }
    default:
      return { status: 'desconhecido', statusBruto: rawStatus };
  }
}

function parseSingleSettlement(value: unknown): ConsultarCobrancaResult | null {
  if (!Array.isArray(value) || value.length !== 1) {
    return null;
  }
  const settlement = value[0] as InterPixSettlement | undefined;
  if (
    settlement === undefined ||
    typeof settlement.endToEndId !== 'string' ||
    !E2E_ID_PATTERN.test(settlement.endToEndId) ||
    typeof settlement.horario !== 'string'
  ) {
    return null;
  }
  const valorPagoCents = parseReaisToCents(settlement.valor);
  const horarioMs = Date.parse(settlement.horario);
  if (valorPagoCents === null || !Number.isFinite(horarioMs)) {
    return null;
  }
  return {
    status: 'concluida',
    e2eId: settlement.endToEndId,
    valorPagoCents,
    horario: new Date(horarioMs),
  };
}

function classifyRefundResponse(
  response: InterHttpResponse,
  span: Span,
  operation: string,
  expectedIdDevolucao: string,
  expectedAmountCents: MoneyCents | undefined,
  requestMayHaveMovedMoney: boolean,
): DevolucaoOutcome {
  if (requestMayHaveMovedMoney && response.statusCode === 400) {
    const code = extractInterErrorCode(response);
    span.setAttribute('cobranca.inter_error_code', code);
    return { status: 'rejeitada', codigo: code };
  }
  if (!isSuccess(response.statusCode)) {
    const code = extractInterErrorCode(response);
    span.setAttribute('cobranca.inter_error_code', code);
    if (requestMayHaveMovedMoney) {
      throw new PixCobrancaAmbiguaError(`${operation}: ${code}`);
    }
    throw new PixCobrancaTransitoriaError(`${operation}: ${code}`);
  }

  const parsed = parseJson<InterDevolucaoResponse>(response.body);
  if (!matchesRefundIdentity(parsed, expectedIdDevolucao, expectedAmountCents)) {
    // A successful response is authoritative only for the refund identity
    // (and, on PUT, the amount) we requested. Accepting another refund's
    // state could terminalize the wrong ledger entry.
    throw new PixCobrancaAmbiguaError(`${operation}: identidade de devolução inválida`);
  }
  const status = typeof parsed?.status === 'string' ? parsed.status.toUpperCase() : '';
  switch (status) {
    case 'EM_PROCESSAMENTO':
      if (typeof parsed?.rtrId === 'string' && parsed.rtrId.length > 0) {
        return { status: 'em_processamento', rtrId: parsed.rtrId };
      }
      break;
    case 'DEVOLVIDO':
      return { status: 'devolvida' };
    case 'NAO_REALIZADO':
      return typeof parsed?.motivo === 'string' && parsed.motivo.length > 0
        ? { status: 'nao_realizada', motivo: parsed.motivo }
        : { status: 'nao_realizada' };
    default:
      break;
  }

  // A 2xx with an unknown/malformed refund state is never terminal evidence.
  throw new PixCobrancaAmbiguaError(`${operation}: estado de devolução desconhecido`);
}

function matchesRefundIdentity(
  response: InterDevolucaoResponse | null,
  expectedIdDevolucao: string,
  expectedAmountCents: MoneyCents | undefined,
): boolean {
  if (response?.id !== expectedIdDevolucao) {
    return false;
  }
  return (
    expectedAmountCents === undefined || parseReaisToCents(response.valor) === expectedAmountCents
  );
}

function refundPath(e2eId: string, idDevolucao: string): string {
  return `/pix/v2/pix/${encodeURIComponent(e2eId)}/devolucao/${encodeURIComponent(idDevolucao)}`;
}

/** Integer-only formatting: no binary floating-point currency arithmetic. */
function formatCents(amountCents: MoneyCents): string {
  const cents = BigInt(amountCents);
  const whole = cents / 100n;
  const fractional = cents % 100n;
  return `${whole}.${String(fractional).padStart(2, '0')}`;
}

/** Parses Inter's decimal money without routing through floating point. */
function parseReaisToCents(value: unknown): MoneyCents | null {
  // Inter's wire contract is a decimal string. Accepting JSON numbers would
  // route authoritative money through IEEE-754 before this integer parser.
  if (typeof value !== 'string') {
    return null;
  }
  const match = INTER_MONEY_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt(match[2] ?? '0');
  const cents = whole * 100n + fraction;
  if (cents <= 0n || cents > BigInt(INTER_MAX_AMOUNT_CENTS)) {
    return null;
  }
  return Number(cents) as MoneyCents;
}

function isPreSendConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== 'string') {
    return false;
  }
  return (
    PRE_SEND_ERROR_CODES.has(code) ||
    code.startsWith('ERR_TLS') ||
    code.includes('CERT') ||
    code.includes('SSL')
  );
}
