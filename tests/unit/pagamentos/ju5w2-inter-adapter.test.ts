import { describe, expect, it } from 'vitest';
import {
  type InterHttpResponse,
  type InterHttpTransport,
  type InterProviderConfig,
  TransferenciaProviderInter,
} from '../../../src/adapters/pagamentos/transferencia-provider.inter.js';
import { TransferenciaTransitoriaError } from '../../../src/adapters/pagamentos/transferencia-provider.js';
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
  it.each(['PAGAMENTO', 'REALIZADO', 'PAGO'])('%s → pago (settled)', async (tipo) => {
    const t = new ScriptedTransport().push(TOKEN_OK, pagar(tipo, 'cod-x'));
    const out = await newProvider(t).pagarPix(input);
    expect(out).toEqual({ outcome: 'pago', codigoSolicitacao: 'cod-x' });
  });

  it.each([
    'PROCESSADO',
    'APROVACAO',
    'AGENDADO',
    'AGUARDANDO_APROVACAO',
  ])('%s → agendado_aprovacao (NOT booked — consult confirms settlement)', async (tipo) => {
    const t = new ScriptedTransport().push(TOKEN_OK, pagar(tipo, 'cod-y'));
    const out = await newProvider(t).pagarPix(input);
    expect(out).toEqual({ outcome: 'agendado_aprovacao', codigoSolicitacao: 'cod-y' });
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

  it('503 → throws AMBIGUOUS (a payment may have landed before the 5xx)', async () => {
    const t = new ScriptedTransport().push(TOKEN_OK, { statusCode: 503, body: '{}' });
    const p = newProvider(t).pagarPix(input);
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toBeInstanceOf(TransferenciaTransitoriaError);
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
