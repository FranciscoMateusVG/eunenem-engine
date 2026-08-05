import { describe, expect, it } from 'vitest';
import {
  createInterMtlsAgent,
  extractInterErrorCode,
  InterHttpClient,
  type InterHttpConfig,
  type InterHttpResponse,
  type InterHttpTransport,
} from '../../../src/adapters/pagamentos/inter-http.js';

/**
 * aperture-imock (B1 of 2j2j1 §4.1) — contract tests for the shared Inter
 * HTTP core extracted from the PIX-out adapter. The invariants under test
 * are the ones BOTH adapters (PIX-out transfers + PIX-in cobrança) depend on:
 *   - the OAuth token cache is PER-INSTANCE: two clients with two credential
 *     sets never share (or clobber) each other's tokens;
 *   - stale tokens are refreshed inside the 60s safety margin;
 *   - error-code extraction is a NO-PII gate: codigo → title → HTTP_<status>,
 *     `detail`/`violacoes` never surfaced;
 *   - the mTLS agent presents cert/key + keepAlive ONLY — TLS verification
 *     stays ON (no `rejectUnauthorized`, no custom `ca`).
 */

function config(overrides: Partial<InterHttpConfig> = {}): InterHttpConfig {
  return {
    baseUrl: 'https://inter.test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    scope: 'cob.write cob.read',
    certPem: 'CERT-PEM',
    keyPem: 'KEY-PEM',
    ...overrides,
  };
}

function tokenOk(accessToken: string, expiresIn = 3600): InterHttpResponse {
  return {
    statusCode: 200,
    body: JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
    }),
  };
}

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
}

describe('InterHttpClient — token cache is per-instance (two credential sets)', () => {
  it('caches the token inside one instance (one fetch across calls)', async () => {
    const t = new ScriptedTransport().push(tokenOk('tkn-1'));
    const client = new InterHttpClient(config(), t.fn);
    expect(await client.getToken()).toBe('tkn-1');
    expect(await client.getToken()).toBe('tkn-1');
    expect(t.tokenCalls()).toBe(1);
  });

  it('two instances with different credentials fetch and hold SEPARATE tokens', async () => {
    const tA = new ScriptedTransport().push(tokenOk('tkn-transferencia'));
    const tB = new ScriptedTransport().push(tokenOk('tkn-cobranca'));
    const clientA = new InterHttpClient(
      config({ clientId: 'id-a', scope: 'pagamento-pix.write' }),
      tA.fn,
    );
    const clientB = new InterHttpClient(config({ clientId: 'id-b', scope: 'cob.write' }), tB.fn);

    expect(await clientA.getToken()).toBe('tkn-transferencia');
    expect(await clientB.getToken()).toBe('tkn-cobranca');
    // Re-reads stay isolated: neither instance sees (or refreshes) the other's cache.
    expect(await clientA.getToken()).toBe('tkn-transferencia');
    expect(await clientB.getToken()).toBe('tkn-cobranca');
    expect(tA.tokenCalls()).toBe(1);
    expect(tB.tokenCalls()).toBe(1);
  });

  it('refreshes a token expiring inside the 60s safety margin', async () => {
    // expires_in 30s < 60s margin → the cached token is already "stale" on
    // the next call and must be refetched.
    const t = new ScriptedTransport().push(tokenOk('tkn-old', 30), tokenOk('tkn-new'));
    const client = new InterHttpClient(config(), t.fn);
    expect(await client.getToken()).toBe('tkn-old');
    expect(await client.getToken()).toBe('tkn-new');
    expect(t.tokenCalls()).toBe(2);
  });

  it('sends client-credentials form body + conta-corrente header on the token call', async () => {
    const t = new ScriptedTransport().push(tokenOk('tkn'));
    const client = new InterHttpClient(config({ contaCorrente: '12345' }), t.fn);
    await client.getToken();

    const call = t.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe('/oauth/v2/token');
    expect(call?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call?.headers['x-conta-corrente']).toBe('12345');
    const params = new URLSearchParams(call?.body ?? '');
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('client_secret')).toBe('client-secret');
    expect(params.get('scope')).toBe('cob.write cob.read');
  });

  it('token HTTP failure throws a code-only error (no body echo)', async () => {
    const t = new ScriptedTransport().push({ statusCode: 401, body: '{"detail":"secret stuff"}' });
    const client = new InterHttpClient(config(), t.fn);
    await expect(client.getToken()).rejects.toThrow('token: HTTP 401');
  });

  it('token 2xx without access_token throws', async () => {
    const t = new ScriptedTransport().push({ statusCode: 200, body: '{}' });
    const client = new InterHttpClient(config(), t.fn);
    await expect(client.getToken()).rejects.toThrow('token: resposta sem access_token');
  });
});

describe('InterHttpClient — jsonHeaders', () => {
  it('carries bearer token, JSON content negotiation and conta-corrente when set', () => {
    const client = new InterHttpClient(config({ contaCorrente: '999' }), async () => {
      throw new Error('unused');
    });
    expect(client.jsonHeaders('tkn')).toEqual({
      Authorization: 'Bearer tkn',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-conta-corrente': '999',
    });
  });

  it('omits x-conta-corrente when the config has none', () => {
    const client = new InterHttpClient(config(), async () => {
      throw new Error('unused');
    });
    expect(client.jsonHeaders('tkn')).not.toHaveProperty('x-conta-corrente');
  });
});

describe('extractInterErrorCode — NO-PII gate (codigo → title → HTTP_<status>)', () => {
  const res = (statusCode: number, body: string): InterHttpResponse => ({ statusCode, body });

  it('prefers a machine codigo string', () => {
    expect(extractInterErrorCode(res(400, '{"codigo":"CHAVE_INVALIDA","title":"Bad"}'))).toBe(
      'CHAVE_INVALIDA',
    );
  });

  it('stringifies a numeric codigo', () => {
    expect(extractInterErrorCode(res(400, '{"codigo":4711}'))).toBe('4711');
  });

  it('falls back to the short title when codigo is absent/empty', () => {
    expect(extractInterErrorCode(res(400, '{"codigo":"","title":"Campo inválido"}'))).toBe(
      'Campo inválido',
    );
  });

  it('falls back to HTTP_<status> on an unparseable body', () => {
    expect(extractInterErrorCode(res(503, 'gateway timeout'))).toBe('HTTP_503');
  });

  it('falls back to HTTP_<status> on a JSON body with no usable code', () => {
    expect(extractInterErrorCode(res(429, '{}'))).toBe('HTTP_429');
  });

  it('NEVER surfaces detail/violacoes — they can echo PII', () => {
    const body = JSON.stringify({
      detail: 'chave someone@example.com inválida',
      violacoes: [{ razao: 'cpf 123.456.789-00', propriedade: 'devedor.cpf' }],
    });
    const code = extractInterErrorCode(res(400, body));
    expect(code).toBe('HTTP_400');
    expect(code).not.toContain('someone@example.com');
    expect(code).not.toContain('123.456.789-00');
  });
});

describe('createInterMtlsAgent — TLS verification stays ON', () => {
  it('presents cert/key with keepAlive and touches NOTHING else about TLS', () => {
    const agent = createInterMtlsAgent('CERT-PEM', 'KEY-PEM');
    expect(agent.options.cert).toBe('CERT-PEM');
    expect(agent.options.key).toBe('KEY-PEM');
    expect(agent.options.keepAlive).toBe(true);
    // The whole point: no rejectUnauthorized, no custom ca — default
    // verification remains in force.
    expect(agent.options).not.toHaveProperty('rejectUnauthorized');
    expect(agent.options).not.toHaveProperty('ca');
    agent.destroy();
  });
});
