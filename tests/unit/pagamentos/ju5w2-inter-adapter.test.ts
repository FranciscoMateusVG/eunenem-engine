import { describe, expect, it } from 'vitest';
import {
  capturePrivateProviderErrorBody,
  classifyInterPayoutDiagnostics,
  type InterHttpResponse,
  type InterHttpTransport,
  type InterProviderConfig,
  PRIVATE_PROVIDER_ERROR_BODY_MAX_BYTES,
  TransferenciaProviderInter,
} from '../../../src/adapters/pagamentos/transferencia-provider.inter.js';
import {
  TransferenciaAmbiguaError,
  TransferenciaTransitoriaError,
} from '../../../src/adapters/pagamentos/transferencia-provider.js';
import type { MoneyCents } from '../../../src/domain/money.js';

/**
 * aperture-ju5w2 — money-safety contract tests for the real Banco Inter PIX
 * adapter. The transport seam lets us drive the classification + mapping with
 * ZERO real network/TLS. The invariants under test are the ones Cipher's gate
 * and the FSM depend on:
 *   - a TransferenciaTransitoriaError is thrown ONLY when no payment can exist
 *     (pre-flight / token / pre-send connection) — never after the request went;
 *   - tipoRetorno mapping only books `pago` for definitively-settled values
 *     (PROCESSADO is NOT settled → agendado_aprovacao → consult confirms);
 *   - no chave/PII leaks into a returned/thrown error string.
 */

const cents = (n: number) => n as MoneyCents;

const CONFIG: InterProviderConfig = {
  baseUrl: 'https://inter.test',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scope: 'pagamento-pix.write extrato.read',
  certPem: 'CERT-PEM',
  keyPem: 'KEY-PEM',
};

const CHAVE = 'recipient-pix-key@example.com';
const TOKEN_OK: InterHttpResponse = {
  statusCode: 200,
  body: JSON.stringify({ access_token: 'tkn', token_type: 'Bearer', expires_in: 3600 }),
};

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** A transport that returns queued responses (or throws queued errors) in order. */
class ScriptedTransport {
  readonly calls: RecordedCall[] = [];
  private readonly queue: Array<InterHttpResponse | Error> = [];

  push(...items: Array<InterHttpResponse | Error>): this {
    this.queue.push(...items);
    return this;
  }

  readonly fn: InterHttpTransport = async (method, path, headers, body) => {
    this.calls.push({ method, path, headers, ...(body !== undefined ? { body } : {}) });
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
    return this.calls.filter((c) => c.path === '/oauth/v2/token').length;
  }

  lastPixBody(): Record<string, unknown> {
    const pix = [...this.calls].reverse().find((c) => c.path === '/banking/v2/pix');
    return pix?.body ? (JSON.parse(pix.body) as Record<string, unknown>) : {};
  }
}

function conn(code: string): Error {
  return Object.assign(new Error(`transport ${code}`), { code });
}

function pagar(outcome: string, codigo = 'cod-1'): InterHttpResponse {
  return {
    statusCode: 200,
    body: JSON.stringify({ tipoRetorno: outcome, codigoSolicitacao: codigo }),
  };
}

function newProvider(t: ScriptedTransport): TransferenciaProviderInter {
  return new TransferenciaProviderInter(CONFIG, t.fn);
}

const input = {
  chave: CHAVE,
  valorCents: cents(12345),
  descricao: 'ref:EN123',
  referencia: 'EN123',
};

describe('TransferenciaProviderInter — pagarPix tipoRetorno mapping (money-safety)', () => {
  it.each([
    'PAGAMENTO',
    'REALIZADO',
    'PAGO',
  ])('%s → aceito_pelo_banco (platform handoff)', async (tipo) => {
    const t = new ScriptedTransport().push(TOKEN_OK, pagar(tipo, 'cod-x'));
    const out = await newProvider(t).pagarPix(input);
    expect(out).toMatchObject({ outcome: 'aceito_pelo_banco', codigoSolicitacao: 'cod-x' });
    expect(out.diagnostics).toMatchObject({ responseClass: 'accepted', httpStatus: 200 });
    expect(out.diagnostics?.privateProviderError).toBeNull();
  });

  it.each([
    'PROCESSADO',
    'APROVACAO',
    'AGENDADO',
    'AGUARDANDO_APROVACAO',
  ])('%s → aceito_pelo_banco (platform handoff)', async (tipo) => {
    const t = new ScriptedTransport().push(TOKEN_OK, pagar(tipo, 'cod-y'));
    const out = await newProvider(t).pagarPix(input);
    expect(out).toMatchObject({ outcome: 'aceito_pelo_banco', codigoSolicitacao: 'cod-y' });
    expect(out.diagnostics).toMatchObject({ responseClass: 'accepted', httpStatus: 200 });
  });

  it('unknown tipoRetorno on 2xx → throws AMBIGUOUS (not Transitoria)', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, pagar('QUEM_SABE', 'cod-z'));
    await expect(newProvider(t).pagarPix(input)).rejects.not.toBeInstanceOf(
      TransferenciaTransitoriaError,
    );
  });

  it('2xx without codigoSolicitacao → throws AMBIGUOUS', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 200,
      body: JSON.stringify({ tipoRetorno: 'PAGAMENTO' }),
    });
    const p = newProvider(t).pagarPix(input);
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toBeInstanceOf(TransferenciaTransitoriaError);
  });

  it('400 validation rejection → rejeitado with Inter CODE, NO chave/PII in erro', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 400,
      // detail deliberately echoes the chave — the adapter must NOT surface it.
      body: JSON.stringify({ codigo: 'CHAVE_INVALIDA', detail: `chave ${CHAVE} inválida` }),
    });
    const out = await newProvider(t).pagarPix(input);
    expect(out.outcome).toBe('rejeitado');
    if (out.outcome === 'rejeitado') {
      expect(out.erro).toBe('CHAVE_INVALIDA');
      expect(out.erro).not.toContain(CHAVE);
    }
  });

  it('persists only canonical validation field/reason and a bounded documented correlation id', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 422,
      body: JSON.stringify({
        title: 'Dados inválidos.',
        correlationId: 'req-2026.09:abc',
        detail: `never persist ${CHAVE}`,
        violacoes: [
          {
            propriedade: 'destinatario.chave',
            razao: `O campo não respeita o schema. never persist ${CHAVE}`,
            valor: CHAVE,
          },
        ],
      }),
    });

    const out = await newProvider(t).pagarPix(input);
    expect(out.outcome).toBe('rejeitado');
    expect(out.diagnostics).toEqual({
      operation: 'pagar_pix',
      responseClass: 'validation_rejection',
      httpStatus: 422,
      providerRequestId: 'req-2026.09:abc',
      diagnosticCode: 'invalid_request',
      diagnosticField: 'pix_key',
      diagnosticReason: 'invalid_format',
      privateProviderError: {
        body: expect.any(String),
        truncated: false,
      },
    });
    const { privateProviderError, ...safeProjection } = out.diagnostics ?? {};
    expect(privateProviderError?.body).toContain(CHAVE);
    expect(JSON.stringify(safeProjection)).not.toContain(CHAVE);
  });

  it('keeps unknown details out of the safe projection while retaining the private body', async () => {
    const pii = '52998224725-secret@example.com';
    const t = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 400,
      body: JSON.stringify({
        codigo: pii,
        title: pii,
        correlationId: `bad ${pii}`,
        detail: pii,
        violacoes: [{ propriedade: 'campo.secreto', razao: pii, valor: pii }],
      }),
    });

    const out = await newProvider(t).pagarPix(input);
    expect(out.outcome).toBe('rejeitado');
    expect(out.diagnostics).toMatchObject({
      providerRequestId: null,
      diagnosticCode: 'provider_rejection',
      diagnosticField: null,
      diagnosticReason: 'diagnostic_unavailable',
    });
    const { privateProviderError, ...safeProjection } = out.diagnostics ?? {};
    expect(privateProviderError?.body).toContain(pii);
    expect(JSON.stringify(safeProjection)).not.toContain(pii);
  });

  it('captures an exact non-2xx body privately without truncation', async () => {
    const body = JSON.stringify({
      title: 'Dados inválidos.',
      detail: 'Verifique os dados informados.',
      violacoes: [{ propriedade: 'destinatario.chave', razao: 'Formato inválido.' }],
    });
    const t = new ScriptedTransport().push(TOKEN_OK, { statusCode: 400, body });

    const out = await newProvider(t).pagarPix(input);

    expect(out.diagnostics?.privateProviderError).toEqual({ body, truncated: false });
  });

  it('truncates a multibyte body at a complete UTF-8 boundary within 16 KiB', () => {
    const prefix = 'a'.repeat(PRIVATE_PROVIDER_ERROR_BODY_MAX_BYTES - 1);
    const captured = capturePrivateProviderErrorBody(`${prefix}€suffix`);

    expect(captured).toEqual({ body: prefix, truncated: true });
    expect(Buffer.byteLength(captured.body, 'utf8')).toBeLessThanOrEqual(
      PRIVATE_PROVIDER_ERROR_BODY_MAX_BYTES,
    );
    expect(captured.body).not.toContain('�');
  });

  it('preserves an exact 16 KiB multibyte body without a false truncation flag', () => {
    const body = `${'a'.repeat(PRIVATE_PROVIDER_ERROR_BODY_MAX_BYTES - 3)}€`;

    expect(Buffer.byteLength(body, 'utf8')).toBe(PRIVATE_PROVIDER_ERROR_BODY_MAX_BYTES);
    expect(capturePrivateProviderErrorBody(body)).toEqual({ body, truncated: false });
  });

  it('503 → throws AMBIGUOUS (a payment may have landed before the 5xx)', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, { statusCode: 503, body: '{}' });
    const p = newProvider(t).pagarPix(input);
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toBeInstanceOf(TransferenciaTransitoriaError);
  });

  it('503 carries safe HTTP evidence without changing the ambiguous money outcome', async () => {
    const body = JSON.stringify({ correlationId: 'req-503' });
    const t = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 503,
      body,
    });
    const error = await newProvider(t)
      .pagarPix(input)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransferenciaAmbiguaError);
    expect((error as TransferenciaAmbiguaError).diagnostics).toMatchObject({
      responseClass: 'ambiguous_http',
      httpStatus: 503,
      providerRequestId: 'req-503',
      diagnosticCode: 'diagnostic_unavailable',
      privateProviderError: { body, truncated: false },
    });
  });
});

describe('TransferenciaProviderInter — finite validation diagnostics', () => {
  it.each([
    ['valor', 'O valor deve ser maior que zero.', 'amount', 'out_of_range'],
    ['destinatario.chave', 'Campo obrigatório.', 'pix_key', 'required'],
    ['destinatario.chave', 'A chave não pertence à conta.', 'pix_key', 'not_owned'],
    ['destinatario', 'Tipo não suportado.', 'recipient', 'unsupported'],
  ] as const)('%s maps a documented-style reason to %s/%s', (property, reason, field, expected) => {
    const diagnostics = classifyInterPayoutDiagnostics({
      statusCode: 422,
      body: JSON.stringify({
        title: 'Dados inválidos.',
        violacoes: [{ propriedade: property, razao: reason }],
      }),
    });
    expect(diagnostics).toMatchObject({
      diagnosticCode: 'invalid_request',
      diagnosticField: field,
      diagnosticReason: expected,
    });
  });
});

describe('TransferenciaProviderInter — pagarPix throw classification', () => {
  it.each([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('pre-send connection error %s → TransferenciaTransitoriaError (safe retry)', async (code) => {
    const t = new ScriptedTransport().push(TOKEN_OK, conn(code));
    await expect(newProvider(t).pagarPix(input)).rejects.toBeInstanceOf(
      TransferenciaTransitoriaError,
    );
  });

  it.each([
    'ECONNRESET',
    'INTER_TIMEOUT',
    'EPIPE',
  ])('post-send error %s → plain Error (AMBIGUOUS, never Transitoria)', async (code) => {
    const t = new ScriptedTransport().push(TOKEN_OK, conn(code));
    const p = newProvider(t).pagarPix(input);
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toBeInstanceOf(TransferenciaTransitoriaError);
  });

  it('token HTTP failure → TransferenciaTransitoriaError (payment never sent)', async () => {
    const t = new ScriptedTransport().push({ statusCode: 401, body: '{}' });
    await expect(newProvider(t).pagarPix(input)).rejects.toBeInstanceOf(
      TransferenciaTransitoriaError,
    );
  });

  it('token transport error → TransferenciaTransitoriaError', async () => {
    const t = new ScriptedTransport().push(conn('ECONNREFUSED'));
    await expect(newProvider(t).pagarPix(input)).rejects.toBeInstanceOf(
      TransferenciaTransitoriaError,
    );
  });

  it('pre-flight empty chave → Transitoria, no request sent', async () => {
    const t = new ScriptedTransport();
    await expect(newProvider(t).pagarPix({ ...input, chave: '' })).rejects.toBeInstanceOf(
      TransferenciaTransitoriaError,
    );
    expect(t.calls).toHaveLength(0);
  });

  it('pre-flight non-positive valorCents → Transitoria, no request sent', async () => {
    const t = new ScriptedTransport();
    await expect(
      newProvider(t).pagarPix({ ...input, valorCents: cents(0) }),
    ).rejects.toBeInstanceOf(TransferenciaTransitoriaError);
    expect(t.calls).toHaveLength(0);
  });
});

describe('TransferenciaProviderInter — pagarPix request body', () => {
  it('sends valor in reais (2dp), destinatario CHAVE, descricao passed through', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, pagar('PAGAMENTO'));
    await newProvider(t).pagarPix({ ...input, valorCents: cents(12345), descricao: 'ref:EN9' });
    const body = t.lastPixBody();
    expect(body.valor).toBe(123.45);
    expect(body.destinatario).toEqual({ tipo: 'CHAVE', chave: CHAVE });
    expect(body.descricao).toBe('ref:EN9');
  });

  it('truncates descricao to 140 chars', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, pagar('PAGAMENTO'));
    const long = 'x'.repeat(300);
    await newProvider(t).pagarPix({ ...input, descricao: long });
    expect((t.lastPixBody().descricao as string).length).toBe(140);
  });
});

describe('TransferenciaProviderInter — consultarPagamento status mapping (defensive)', () => {
  const cases: Array<[string, string]> = [
    ['PAGO', 'pago'],
    ['REALIZADO', 'pago'],
    ['AGUARDANDO_APROVACAO', 'aguardando_aprovacao'],
    ['CANCELADO', 'cancelado'],
    ['REPROVADO', 'rejeitado'],
    ['NAO_REALIZADO', 'rejeitado'],
    ['CRIADO', 'em_processamento'],
    ['ENVIADO', 'em_processamento'],
    ['QUALQUER_COISA', 'em_processamento'],
  ];
  it.each(cases)('Inter status %s → %s', async (interStatus, expected) => {
    const t = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 200,
      body: JSON.stringify({ transacaoPix: { status: interStatus } }),
    });
    const res = await newProvider(t).consultarPagamento('cod-1');
    expect(res.status).toBe(expected);
  });

  it('unknown/in-flight never maps to a terminal — a false terminal double-pays', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 200,
      body: JSON.stringify({ transacaoPix: { status: 'DEBITADO' } }),
    });
    const res = await newProvider(t).consultarPagamento('cod-1');
    expect(res.status).toBe('em_processamento');
  });
});

describe('TransferenciaProviderInter — buscarPagamentos', () => {
  it('returns only PIX-out debits with codigoSolicitacao; referencia from descricaoPix', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, {
      statusCode: 200,
      body: JSON.stringify({
        ultimaPagina: true,
        transacoes: [
          {
            tipoOperacao: 'D',
            tipoTransacao: 'PIX',
            valor: '123.45',
            detalhes: {
              codigoSolicitacao: 'cod-a',
              descricaoPix: 'EN123',
              chavePixRecebedor: CHAVE,
            },
          },
          {
            tipoOperacao: 'C', // credit — skipped
            tipoTransacao: 'PIX',
            valor: '10.00',
            detalhes: { codigoSolicitacao: 'cod-b' },
          },
          {
            tipoOperacao: 'D',
            tipoTransacao: 'BOLETO', // not pix — skipped
            valor: '5.00',
            detalhes: { codigoSolicitacao: 'cod-c' },
          },
          {
            tipoOperacao: 'D',
            tipoTransacao: 'PIX',
            valor: '50.00',
            detalhes: { codigoSolicitacao: 'cod-d' }, // no descricaoPix → referencia ''
          },
        ],
      }),
    });
    const res = await newProvider(t).buscarPagamentos({
      dataInicio: '2026-07-01',
      dataFim: '2026-07-16',
    });
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({
      codigoSolicitacao: 'cod-a',
      valorCents: 12345,
      referencia: 'EN123',
      chave: CHAVE,
    });
    expect(res[1]).toMatchObject({ codigoSolicitacao: 'cod-d', referencia: '' });
    expect(res[1]?.chave).toBeUndefined();
  });
});

describe('TransferenciaProviderInter — token caching', () => {
  it('reuses the cached token across calls (one token fetch)', async () => {
    const consultOk = {
      statusCode: 200,
      body: JSON.stringify({ transacaoPix: { status: 'PAGO' } }),
    };
    const t = new ScriptedTransport().push(TOKEN_OK, consultOk, consultOk);
    const provider = newProvider(t);
    await provider.consultarPagamento('cod-1');
    await provider.consultarPagamento('cod-2');
    expect(t.tokenCalls()).toBe(1);
  });
});
