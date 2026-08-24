import { describe, expect, it } from 'vitest';
import {
  type InterHttpResponse,
  type InterHttpTransport,
  type InterPixCobrancaConfig,
  PixCobrancaProviderInter,
} from '../../../src/adapters/pagamentos/pix-cobranca-provider.inter.js';
import {
  PixCobrancaAmbiguaError,
  PixCobrancaTransitoriaError,
} from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';
import type { MoneyCents } from '../../../src/domain/money.js';
import type {
  IdIntencaoPagamento,
  IdPagamento,
} from '../../../src/domain/pagamentos/value-objects/ids.js';

const cents = (value: number) => value as MoneyCents;
const idPagamento = '550e8400-e29b-41d4-a716-446655440000' as IdPagamento;
const idIntencaoPagamento = 'a6f3be1a-5ef5-4aaa-9b98-60f607552298' as IdIntencaoPagamento;
const txid = '550e8400e29b41d4a716446655440000';
const e2eId = 'E'.repeat(32);
const idDevolucao = 'RefundStable123';
const refundConsultInput = { e2eId, idDevolucao, amountCents: cents(1005) };
const pixKey = 'merchant-pix-key@example.com';
const pii = 'payer.sensitive@example.com';

const CONFIG: InterPixCobrancaConfig = {
  baseUrl: 'https://inter.test',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scope: 'cob.write cob.read pix.read pix.write',
  certPem: 'CERT-PEM',
  keyPem: 'KEY-PEM',
  pixKey,
};

const TOKEN_OK: InterHttpResponse = {
  statusCode: 200,
  body: JSON.stringify({ access_token: 'token', token_type: 'Bearer', expires_in: 3600 }),
};

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

class ScriptedTransport {
  readonly calls: RecordedCall[] = [];
  private readonly queue: Array<InterHttpResponse | Error> = [];

  push(...items: Array<InterHttpResponse | Error>): this {
    this.queue.push(...items);
    return this;
  }

  readonly fn: InterHttpTransport = async (method, path, headers, body) => {
    this.calls.push({ method, path, headers, ...(body === undefined ? {} : { body }) });
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(`ScriptedTransport: no response queued for ${method} ${path}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };

  tokenCalls(): number {
    return this.calls.filter((call) => call.path === '/oauth/v2/token').length;
  }

  apiCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.path !== '/oauth/v2/token');
  }
}

function provider(transport: ScriptedTransport): PixCobrancaProviderInter {
  return new PixCobrancaProviderInter(CONFIG, transport.fn);
}

function createResponse(overrides: Record<string, unknown> = {}): InterHttpResponse {
  return {
    statusCode: 200,
    body: JSON.stringify({
      txid,
      pixCopiaECola: '000201010212br-code',
      calendario: { criacao: '2026-08-05T12:00:00.000Z', expiracao: 600 },
      ...overrides,
    }),
  };
}

function chargeResponse(status: string, pix?: unknown): InterHttpResponse {
  return {
    statusCode: 200,
    body: JSON.stringify({ txid, status, ...(pix === undefined ? {} : { pix }) }),
  };
}

function refundResponse(status: string, extra: Record<string, unknown> = {}): InterHttpResponse {
  return {
    statusCode: 200,
    body: JSON.stringify({ id: idDevolucao, valor: '10.05', status, ...extra }),
  };
}

function transportError(code: string): Error {
  return Object.assign(new Error(`transport ${code}`), { code });
}

const createInput = {
  idPagamento,
  idIntencaoPagamento,
  amountCents: cents(12_345),
  solicitacaoPagador: 'EuNeném — contribuição',
};

const refundInput = {
  e2eId,
  idDevolucao,
  amountCents: cents(1_005),
  descricao: 'Estorno solicitado',
};

describe('PixCobrancaProviderInter — criarCobranca request + create response', () => {
  it('uses UUID-without-hyphens txid, exact Inter body and authoritative expiry', async () => {
    const transport = new ScriptedTransport().push(TOKEN_OK, createResponse());
    const result = await provider(transport).criarCobranca(createInput);

    expect(result).toEqual({
      txid,
      pixCopiaECola: '000201010212br-code',
      expiraEm: new Date('2026-08-05T12:10:00.000Z'),
    });
    const call = transport.apiCalls()[0];
    expect(call).toMatchObject({
      method: 'PUT',
      path: `/pix/v2/cob/${txid}`,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      calendario: { expiracao: 600 },
      valor: { original: '123.45' },
      chave: pixKey,
      solicitacaoPagador: 'EuNeném — contribuição',
    });
    expect(call?.body).not.toContain('devedor');
    expect(txid).toMatch(/^[A-Za-z0-9]{26,35}$/);
  });

  it.each([
    [1, '0.01'],
    [10, '0.10'],
    [101, '1.01'],
    [1_005, '10.05'],
    [999_999_999_999, '9999999999.99'],
  ])('formats %i cents as %s without floating-point money arithmetic', async (amount, expected) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, createResponse());
    await provider(transport).criarCobranca({ ...createInput, amountCents: cents(amount) });
    const body = JSON.parse(transport.apiCalls()[0]?.body ?? '{}') as {
      valor?: { original?: string };
    };
    expect(body.valor?.original).toBe(expected);
  });

  it('omits solicitacaoPagador when absent instead of sending a phantom field', async () => {
    const transport = new ScriptedTransport().push(TOKEN_OK, createResponse());
    await provider(transport).criarCobranca({
      idPagamento,
      idIntencaoPagamento,
      amountCents: cents(100),
    });
    expect(JSON.parse(transport.apiCalls()[0]?.body ?? '{}')).not.toHaveProperty(
      'solicitacaoPagador',
    );
  });

  it.each([
    ['mismatched txid', { txid: 'A'.repeat(32) }],
    ['missing BR Code', { pixCopiaECola: '' }],
    ['malformed creation time', { calendario: { criacao: 'not-a-date', expiracao: 600 } }],
    ['malformed expiry', { calendario: { criacao: '2026-08-05T12:00:00Z', expiracao: 0 } }],
  ])('%s is retry-safe because deterministic PUT converges', async (_label, overrides) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, createResponse(overrides));
    await expect(provider(transport).criarCobranca(createInput)).rejects.toBeInstanceOf(
      PixCobrancaTransitoriaError,
    );
  });

  it.each([
    'ECONNRESET',
    'INTER_TIMEOUT',
    'EPIPE',
  ])('create transport %s remains retry-safe because txid is deterministic', async (code) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, transportError(code));
    await expect(provider(transport).criarCobranca(createInput)).rejects.toBeInstanceOf(
      PixCobrancaTransitoriaError,
    );
  });
});

describe('PixCobrancaProviderInter — charge status classification', () => {
  it.each([
    ['ATIVA', { status: 'ativa' }],
    ['REMOVIDA_PELO_USUARIO_RECEBEDOR', { status: 'removida' }],
    ['REMOVIDA_PELO_PSP', { status: 'removida' }],
    ['QUALQUER_STATUS_NOVO', { status: 'desconhecido', statusBruto: 'QUALQUER_STATUS_NOVO' }],
  ])('%s maps defensively', async (status, expected) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, chargeResponse(status));
    await expect(provider(transport).consultarCobranca(txid)).resolves.toEqual(expected);
  });

  it('CONCLUIDA requires exactly one complete settlement record', async () => {
    const transport = new ScriptedTransport().push(
      TOKEN_OK,
      chargeResponse('CONCLUIDA', [
        { endToEndId: e2eId, valor: '10.05', horario: '2026-08-05T12:03:04.000Z' },
      ]),
    );
    await expect(provider(transport).consultarCobranca(txid)).resolves.toEqual({
      status: 'concluida',
      e2eId,
      valorPagoCents: 1005,
      horario: new Date('2026-08-05T12:03:04.000Z'),
    });
  });

  it.each([
    ['zero settlements', []],
    [
      'multiple settlements',
      [
        { endToEndId: e2eId, valor: '1.00', horario: '2026-08-05T12:00:00Z' },
        { endToEndId: 'F'.repeat(32), valor: '1.00', horario: '2026-08-05T12:00:01Z' },
      ],
    ],
    ['missing endToEndId', [{ valor: '1.00', horario: '2026-08-05T12:00:00Z' }]],
    ['malformed amount', [{ endToEndId: e2eId, valor: '1e3', horario: '2026-08-05T12:00:00Z' }]],
    ['comma amount', [{ endToEndId: e2eId, valor: '10,05', horario: '2026-08-05T12:00:00Z' }]],
    ['integer-only amount', [{ endToEndId: e2eId, valor: '10', horario: '2026-08-05T12:00:00Z' }]],
    ['one-decimal amount', [{ endToEndId: e2eId, valor: '10.5', horario: '2026-08-05T12:00:00Z' }]],
    [
      'amount over the provider wire cap',
      [{ endToEndId: e2eId, valor: '10000000000.00', horario: '2026-08-05T12:00:00Z' }],
    ],
    [
      'numeric amount that already crossed IEEE-754',
      [{ endToEndId: e2eId, valor: 10.05, horario: '2026-08-05T12:00:00Z' }],
    ],
    [
      'non-positive amount',
      [{ endToEndId: e2eId, valor: '0.00', horario: '2026-08-05T12:00:00Z' }],
    ],
    ['malformed time', [{ endToEndId: e2eId, valor: '1.00', horario: 'not-a-date' }]],
  ])('CONCLUIDA with %s never marks the charge paid', async (_label, settlements) => {
    const transport = new ScriptedTransport().push(
      TOKEN_OK,
      chargeResponse('CONCLUIDA', settlements),
    );
    await expect(provider(transport).consultarCobranca(txid)).rejects.toBeInstanceOf(
      PixCobrancaTransitoriaError,
    );
  });

  it.each([
    ['malformed JSON', { statusCode: 200, body: 'not-json' }],
    ['missing status', { statusCode: 200, body: '{}' }],
    ['missing txid', { statusCode: 200, body: JSON.stringify({ status: 'ATIVA' }) }],
    [
      'mismatched txid',
      { statusCode: 200, body: JSON.stringify({ txid: 'A'.repeat(32), status: 'ATIVA' }) },
    ],
  ])('%s fails the authoritative read instead of inventing an unknown status', async (_label, response) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, response);
    await expect(provider(transport).consultarCobranca(txid)).rejects.toBeInstanceOf(
      PixCobrancaTransitoriaError,
    );
  });
});

describe('PixCobrancaProviderInter — devolução request + status matrix', () => {
  it('sends deterministic refund path and integer-safe request body', async () => {
    const transport = new ScriptedTransport().push(
      TOKEN_OK,
      refundResponse('EM_PROCESSAMENTO', { rtrId: 'RTR-1' }),
    );
    await expect(provider(transport).solicitarDevolucao(refundInput)).resolves.toEqual({
      status: 'em_processamento',
      rtrId: 'RTR-1',
    });
    const call = transport.apiCalls()[0];
    expect(call).toMatchObject({
      method: 'PUT',
      path: `/pix/v2/pix/${e2eId}/devolucao/${idDevolucao}`,
      headers: { Authorization: 'Bearer token' },
    });
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      valor: '10.05',
      descricao: 'Estorno solicitado',
    });
  });

  it.each([
    ['EM_PROCESSAMENTO', { rtrId: 'RTR-9' }, { status: 'em_processamento', rtrId: 'RTR-9' }],
    ['DEVOLVIDO', {}, { status: 'devolvida' }],
    [
      'NAO_REALIZADO',
      { motivo: 'SALDO_INSUFICIENTE' },
      { status: 'nao_realizada', motivo: 'SALDO_INSUFICIENTE' },
    ],
    ['NAO_REALIZADO', {}, { status: 'nao_realizada' }],
  ])('%s maps to its exact port outcome', async (status, extra, expected) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, refundResponse(status, extra));
    await expect(provider(transport).solicitarDevolucao(refundInput)).resolves.toEqual(expected);
  });

  it('consultarDevolucao uses GET and the same status mapping', async () => {
    const transport = new ScriptedTransport().push(TOKEN_OK, refundResponse('DEVOLVIDO'));
    await expect(provider(transport).consultarDevolucao(refundConsultInput)).resolves.toEqual({
      status: 'devolvida',
    });
    expect(transport.apiCalls()[0]).toMatchObject({
      method: 'GET',
      path: `/pix/v2/pix/${e2eId}/devolucao/${idDevolucao}`,
    });
  });

  it.each([
    ['unknown status', refundResponse('INVENTADO')],
    ['missing rtrId', refundResponse('EM_PROCESSAMENTO')],
    ['malformed JSON', { statusCode: 200, body: 'not-json' }],
  ])('%s on a 2xx is ambiguous, never terminal', async (_label, response) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, response);
    await expect(provider(transport).solicitarDevolucao(refundInput)).rejects.toBeInstanceOf(
      PixCobrancaAmbiguaError,
    );
  });

  it('unknown refund 2xx is also ambiguous on authoritative GET', async () => {
    const transport = new ScriptedTransport().push(TOKEN_OK, refundResponse('INVENTADO'));
    await expect(provider(transport).consultarDevolucao(refundConsultInput)).rejects.toBeInstanceOf(
      PixCobrancaAmbiguaError,
    );
  });

  it.each([
    ['missing id', { id: undefined }],
    ['mismatched id', { id: 'AnotherRefund123' }],
    ['mismatched PUT amount', { valor: '10.06' }],
    ['comma PUT amount', { valor: '10,05' }],
    ['integer-only PUT amount', { valor: '10' }],
    ['one-decimal PUT amount', { valor: '10.5' }],
    ['PUT amount over the provider wire cap', { valor: '10000000000.00' }],
  ])('%s on refund PUT cannot terminalize the requested refund', async (_label, extra) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, refundResponse('DEVOLVIDO', extra));
    await expect(provider(transport).solicitarDevolucao(refundInput)).rejects.toBeInstanceOf(
      PixCobrancaAmbiguaError,
    );
  });

  it.each([
    ['missing id', { id: undefined }],
    ['mismatched id', { id: 'AnotherRefund123' }],
    ['wrong amount', { valor: '10.06' }],
    ['missing amount', { valor: undefined }],
    ['numeric amount', { valor: 10.05 }],
    ['comma amount', { valor: '10,05' }],
    ['integer-only amount', { valor: '10' }],
    ['one-decimal amount', { valor: '10.5' }],
    ['zero amount', { valor: '0.00' }],
    ['amount over the provider wire cap', { valor: '10000000000.00' }],
  ])('%s on refund GET cannot terminalize the requested refund', async (_label, extra) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, refundResponse('DEVOLVIDO', extra));
    await expect(provider(transport).consultarDevolucao(refundConsultInput)).rejects.toBeInstanceOf(
      PixCobrancaAmbiguaError,
    );
  });

  it('HTTP 400 is the only terminal rejection and uses the NO-PII error extractor', async () => {
    const transport = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 400,
      body: JSON.stringify({ codigo: 'CHAVE_INVALIDA', detail: pii }),
    });
    await expect(provider(transport).solicitarDevolucao(refundInput)).resolves.toEqual({
      status: 'rejeitada',
      codigo: 'CHAVE_INVALIDA',
    });
  });

  it.each([
    401, 404, 409, 422, 429, 500, 503,
  ])('refund PUT HTTP %i is ambiguous (only exactly 400 is terminal)', async (statusCode) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, { statusCode, body: '{}' });
    await expect(provider(transport).solicitarDevolucao(refundInput)).rejects.toBeInstanceOf(
      PixCobrancaAmbiguaError,
    );
  });

  it.each([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('refund pre-send %s is definitely retry-safe', async (code) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, transportError(code));
    await expect(provider(transport).solicitarDevolucao(refundInput)).rejects.toBeInstanceOf(
      PixCobrancaTransitoriaError,
    );
  });

  it.each([
    'ECONNRESET',
    'INTER_TIMEOUT',
    'EPIPE',
  ])('refund post-send %s is ambiguous', async (code) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, transportError(code));
    await expect(provider(transport).solicitarDevolucao(refundInput)).rejects.toBeInstanceOf(
      PixCobrancaAmbiguaError,
    );
  });

  it('refund GET transport/HTTP faults are transient because a read cannot move money', async () => {
    const transportFailure = new ScriptedTransport().push(
      TOKEN_OK,
      transportError('INTER_TIMEOUT'),
    );
    await expect(
      provider(transportFailure).consultarDevolucao(refundConsultInput),
    ).rejects.toBeInstanceOf(PixCobrancaTransitoriaError);

    for (const statusCode of [400, 503]) {
      const httpFailure = new ScriptedTransport().push(TOKEN_OK, { statusCode, body: '{}' });
      await expect(
        provider(httpFailure).consultarDevolucao(refundConsultInput),
      ).rejects.toBeInstanceOf(PixCobrancaTransitoriaError);
    }
  });
});

describe('PixCobrancaProviderInter — preflight, token cache and NO-PII errors', () => {
  it('refund GET rejects an invalid expected amount before token or transport', async () => {
    const transport = new ScriptedTransport();
    await expect(
      provider(transport).consultarDevolucao({
        ...refundConsultInput,
        amountCents: cents(0),
      }),
    ).rejects.toBeInstanceOf(PixCobrancaTransitoriaError);
    expect(transport.calls).toHaveLength(0);
  });

  it.each([
    ['invalid idPagamento', { ...createInput, idPagamento: 'not-a-uuid' as IdPagamento }],
    [
      'invalid idIntencaoPagamento',
      { ...createInput, idIntencaoPagamento: 'not-a-uuid' as IdIntencaoPagamento },
    ],
    ['zero amount', { ...createInput, amountCents: cents(0) }],
    ['amount over provider wire cap', { ...createInput, amountCents: cents(1_000_000_000_000) }],
    ['unsafe integer amount', { ...createInput, amountCents: cents(Number.MAX_SAFE_INTEGER + 1) }],
    ['description > 140', { ...createInput, solicitacaoPagador: 'x'.repeat(141) }],
  ])('charge %s fails before token/transport', async (_label, input) => {
    const transport = new ScriptedTransport();
    await expect(provider(transport).criarCobranca(input)).rejects.toBeInstanceOf(
      PixCobrancaTransitoriaError,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it.each([
    ['invalid e2eId', { ...refundInput, e2eId: 'short' }],
    ['invalid idDevolucao', { ...refundInput, idDevolucao: 'contains-hyphen' }],
    ['zero amount', { ...refundInput, amountCents: cents(0) }],
    ['amount over provider wire cap', { ...refundInput, amountCents: cents(1_000_000_000_000) }],
    ['unsafe integer amount', { ...refundInput, amountCents: cents(Number.MAX_SAFE_INTEGER + 1) }],
    ['description > 140', { ...refundInput, descricao: 'x'.repeat(141) }],
  ])('refund %s fails before token/transport', async (_label, input) => {
    const transport = new ScriptedTransport();
    await expect(provider(transport).solicitarDevolucao(input)).rejects.toBeInstanceOf(
      PixCobrancaTransitoriaError,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('one provider instance fetches one token across charge/refund operations', async () => {
    const transport = new ScriptedTransport().push(
      TOKEN_OK,
      createResponse(),
      chargeResponse('ATIVA'),
      refundResponse('EM_PROCESSAMENTO', { rtrId: 'RTR-1' }),
      refundResponse('DEVOLVIDO'),
    );
    const inter = provider(transport);
    await inter.criarCobranca(createInput);
    await inter.consultarCobranca(txid);
    await inter.solicitarDevolucao(refundInput);
    await inter.consultarDevolucao(refundConsultInput);
    expect(transport.tokenCalls()).toBe(1);
    expect(transport.apiCalls()).toHaveLength(4);
  });

  it('token failures are transient and never echo Inter body PII', async () => {
    const transport = new ScriptedTransport().push({
      statusCode: 401,
      body: JSON.stringify({ detail: pii }),
    });
    const promise = provider(transport).solicitarDevolucao(refundInput);
    await expect(promise).rejects.toBeInstanceOf(PixCobrancaTransitoriaError);
    await expect(promise).rejects.not.toThrow(pii);
  });

  it.each([
    ['codigo', { codigo: pii }],
    ['title', { title: `payer ${pii}` }],
    ['detail', { detail: pii }],
    ['violacoes', { violacoes: [{ razao: pii }] }],
  ])('refund rejection never leaks a PII sentinel from %s', async (_field, errorBody) => {
    const transport = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 400,
      body: JSON.stringify(errorBody),
    });
    const result = await provider(transport).solicitarDevolucao(refundInput);
    expect(result).toEqual({ status: 'rejeitada', codigo: 'HTTP_400' });
    expect(JSON.stringify(result)).not.toContain(pii);
  });

  it('create HTTP error never leaks PIX key, payer sentinel or raw response fields', async () => {
    const transport = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 422,
      body: JSON.stringify({ codigo: pii, detail: pixKey, violacoes: [{ razao: pii }] }),
    });
    const promise = provider(transport).criarCobranca(createInput);
    await expect(promise).rejects.toThrow('criarCobranca: HTTP_422');
    await expect(promise).rejects.not.toThrow(pii);
    await expect(promise).rejects.not.toThrow(pixKey);
  });
});
