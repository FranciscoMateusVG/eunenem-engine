import { createHash } from 'node:crypto';
import {
  InterHttpClient,
  type InterHttpConfig,
  type InterHttpTransport,
  parseJson,
} from './inter-http.js';

export interface InterFeeObservation {
  externalRef: string;
  e2e: string;
  amountCents: number;
  occurredAt: Date;
}
export interface InterFeePage {
  fees: InterFeeObservation[];
  unmatched: number;
  /** Invalid candidate rows; the day remains pending even when valid fees are saved. */
  invalid: number;
}
export interface InterFeeReader {
  readonly accountRef: string;
  readonly environment: 'test' | 'live';
  readDay(day: string): Promise<InterFeePage>;
}
export class InterFeeReadError extends Error {
  constructor(
    readonly reason: 'rate_limited' | 'auth' | 'unavailable' | 'incomplete' | 'invalid_fee',
  ) {
    super(reason);
  }
}
/** GET extrato + OAuth only. Account scope never depends on a rotating secret/client ID. */
export class InterProcessingFeeReader implements InterFeeReader {
  readonly accountRef: string;
  readonly environment: 'test' | 'live';
  private readonly http: InterHttpClient;
  constructor(config: InterHttpConfig, transport?: InterHttpTransport) {
    if (!config.contaCorrente?.trim()) throw new Error('inter_fee_account_required');
    const origin = new URL(config.baseUrl).origin;
    this.accountRef = createHash('sha256')
      .update(`${origin}\0${config.contaCorrente.trim()}`)
      .digest('hex');
    this.environment = origin === 'https://cdpj.partners.bancointer.com.br' ? 'live' : 'test';
    this.http = new InterHttpClient({ ...config, scope: 'extrato.read' }, transport);
  }
  async readDay(day: string): Promise<InterFeePage> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new InterFeeReadError('incomplete');
    const token = await this.http.getToken();
    const result: InterFeePage = { fees: [], unmatched: 0, invalid: 0 };
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({
        dataInicio: day,
        dataFim: day,
        pagina: String(page),
        tamanhoPagina: '1000',
      });
      const response = await this.http.request(
        'GET',
        `/banking/v2/extrato/completo?${query}`,
        this.http.jsonHeaders(token),
      );
      checkStatus(response.statusCode);
      const body = parseJson<{
        transacoes?: unknown[];
        ultimaPagina?: boolean;
        totalPaginas?: number;
      }>(response.body);
      if (!body || !Array.isArray(body.transacoes)) throw new InterFeeReadError('incomplete');
      for (const raw of body.transacoes) appendFeeOrMarkInvalid(raw, day, result);
      if (
        body.ultimaPagina === true ||
        (typeof body.totalPaginas === 'number' && page + 1 >= body.totalPaginas)
      )
        return result;
      // Empty ambiguous pages are not proof of completion.
      if (body.transacoes.length === 0) throw new InterFeeReadError('incomplete');
    }
    throw new InterFeeReadError('incomplete');
  }
}

function appendFeeOrMarkInvalid(raw: unknown, day: string, result: InterFeePage): void {
  try {
    appendFee(raw, day, result);
  } catch (error) {
    if (!(error instanceof InterFeeReadError) || error.reason !== 'invalid_fee') throw error;
    result.invalid++;
  }
}

function appendFee(raw: unknown, day: string, result: InterFeePage): void {
  const row = raw as {
    tipoTransacao?: unknown;
    tipoOperacao?: unknown;
    idTransacao?: unknown;
    valor?: unknown;
    dataTransacao?: unknown;
    detalhes?: { endToEndId?: unknown };
  } | null;
  if (!row || row.tipoTransacao !== 'TARIFA' || row.tipoOperacao !== 'D') return;
  const e2e = row.detalhes?.endToEndId;
  // No E2E may be a boleto/other fee: never guess that it belongs to PIX.
  if (typeof e2e !== 'string' || !/^[A-Za-z0-9]{32}$/.test(e2e)) {
    result.unmatched++;
    return;
  }
  // Inter specifies a decimal string, not a fixed-width display amount.
  // Extra fractional digits are accepted only when zero: never round money.
  const match =
    typeof row.valor === 'string' ? /^(\d{1,10})(?:\.(\d{1,2})0*)?$/.exec(row.valor) : null;
  if (
    typeof row.idTransacao !== 'string' ||
    !row.idTransacao.trim() ||
    !match ||
    typeof row.dataTransacao !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(row.dataTransacao) ||
    row.dataTransacao !== day
  )
    throw new InterFeeReadError('invalid_fee');
  result.fees.push({
    externalRef: row.idTransacao,
    e2e,
    amountCents: Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')),
    occurredAt: new Date(`${day}T00:00:00-03:00`),
  });
}

function checkStatus(status: number): void {
  if (status === 429) throw new InterFeeReadError('rate_limited');
  if (status === 401 || status === 403) throw new InterFeeReadError('auth');
  if (status !== 200) throw new InterFeeReadError('unavailable');
}
