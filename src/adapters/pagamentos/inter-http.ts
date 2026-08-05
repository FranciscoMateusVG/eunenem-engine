import https from 'node:https';

/**
 * Shared Banco Inter HTTP plumbing (aperture-imock, B1 of 2j2j1 §4.1),
 * lifted from `transferencia-provider.inter.ts` so the PIX-out transfer
 * adapter and the PIX-in cobrança adapter can reuse it with SEPARATE
 * credential sets: mTLS keep-alive agent, OAuth client-credentials token
 * cache, NO-PII error-code extraction, and the injectable transport seam.
 *
 * Provider-AGNOSTIC by design: NO money-safety classification lives here.
 * Retry/ambiguity POLICY (`TransferenciaTransitoriaError`, pre-send error
 * code decisions, tipoRetorno/status mapping, timeout-ambiguity handling)
 * stays with each adapter — this module only reports faithfully (transports
 * reject ONLY on connection-level failure and resolve on any HTTP status)
 * so the adapter on top can classify.
 *
 * The token cache is PER-INSTANCE, never module-global: each adapter holds
 * its own `InterHttpClient` with its own credentials, so two Inter
 * integrations never share (or clobber) each other's tokens.
 */

/** Milliseconds of headroom before token expiry at which we refresh. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Per-request socket timeout. A timeout is ALWAYS ambiguous (post-send). */
const REQUEST_TIMEOUT_MS = 30_000;

export interface InterHttpConfig {
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
 * The mTLS transport seam. Production uses {@link InterHttpClient}'s own
 * `node:https` implementation; tests inject a scripted transport to exercise
 * each adapter's money-safety classification WITHOUT a live Inter or real TLS.
 * A transport MUST reject (throw) on a connection-level failure (so the caller
 * can classify pre-send vs ambiguous) and MUST resolve — never reject — on any
 * received HTTP status.
 */
export type InterHttpTransport = (
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<InterHttpResponse>;

interface InterTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

interface InterErrorBody {
  readonly codigo?: unknown;
  readonly title?: unknown;
}

type TokenCache = { readonly accessToken: string; readonly expiresAtMs: number };

/**
 * Builds the ONE mTLS keep-alive agent an `InterHttpClient` reuses for every
 * request (token + API calls).
 *
 * Default TLS verification MUST stay ON: no `rejectUnauthorized`, no
 * custom `ca`, no `NODE_TLS_REJECT_UNAUTHORIZED`. We only present the
 * client cert/key for mutual TLS.
 */
export function createInterMtlsAgent(certPem: string, keyPem: string): https.Agent {
  return new https.Agent({
    cert: certPem,
    key: keyPem,
    keepAlive: true,
  });
}

/**
 * One Inter credential set = one `InterHttpClient`: mTLS agent, OAuth token
 * cache and transport are all instance state. Adapters delegate raw HTTP +
 * token acquisition here and keep every classification decision to themselves.
 */
export class InterHttpClient {
  private readonly config: InterHttpConfig;

  /** ONE mTLS agent, reused for every request (token + API). */
  private readonly agent: https.Agent;

  /** In-memory OAuth token cache; refreshed within the safety margin. */
  private tokenCache: TokenCache | null = null;

  /**
   * Single-flight slot: the token fetch currently in flight, if any.
   * Instance-local by design — the per-credential-set token isolation
   * (one client = one cache) must hold, so no module-global state.
   */
  private tokenInFlight: Promise<string> | null = null;

  /** The transport actually used for every request (real mTLS or injected). */
  private readonly transport: InterHttpTransport;

  constructor(config: InterHttpConfig, transport?: InterHttpTransport) {
    this.config = config;
    this.agent = createInterMtlsAgent(config.certPem, config.keyPem);
    // Injected transport (tests) or the real mTLS `node:https` sender.
    this.transport = transport ?? this.sendOverMtls.bind(this);
  }

  /**
   * Sends one request over the resolved transport. Propagates the transport
   * contract untouched: resolves on ANY received HTTP status, rejects only on
   * a connection-level failure — classification belongs to the caller.
   */
  async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<InterHttpResponse> {
    return this.transport(method, path, headers, body);
  }

  /**
   * Returns a cached token when still fresh, else fetches and caches one.
   *
   * Single-flight: when a fetch is already in flight, concurrent callers
   * await the SAME promise instead of issuing new fetches — Inter's OAuth
   * endpoint is rate-limited (5/min), so a cold/refresh concurrency burst
   * would otherwise self-DoS. A FAILED fetch clears the slot so the next
   * caller retries fresh; a rejection is never cached.
   */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache !== null && this.tokenCache.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now) {
      return this.tokenCache.accessToken;
    }
    if (this.tokenInFlight === null) {
      this.tokenInFlight = this.fetchToken().finally(() => {
        this.tokenInFlight = null;
      });
    }
    return this.tokenInFlight;
  }

  /** Performs one OAuth client-credentials fetch and caches the result. */
  private async fetchToken(): Promise<string> {
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

  /** Standard JSON headers for an authenticated API call. */
  jsonHeaders(token: string): Record<string, string> {
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

  /** Builds a Promise around a single mTLS request. Never rejects on status. */
  private sendOverMtls(
    method: 'GET' | 'POST' | 'PUT',
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
}

// --- module-level pure helpers ---------------------------------------------

export function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * Machine-code grammars for `codigo`. Inter can echo payer identifiers —
 * CPF, CNPJ, phone numbers, e-mail addresses, PIX keys — in free-text error
 * fields, so `codigo` is only trusted when it matches a strict machine-code
 * shape:
 *   - short numeric codes (1–8 digits) — deliberately too short for an
 *     11-digit CPF, a 14-digit CNPJ, or a phone number;
 *   - uppercase machine tokens (starts A–Z; then A–Z/0–9/_ up to 32 chars
 *     total) — excludes e-mail addresses (@ / dot), UUID/EVP PIX keys
 *     (lowercase + hyphens), and formatted CPFs (dots / hyphens).
 * Anything else is ignored.
 */
const CODIGO_NUMERIC = /^\d{1,8}$/;
const CODIGO_TOKEN = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * `title` is free text with no length bound on Inter's side, so it can echo
 * the same payer identifiers (and be arbitrarily large). It is only trusted
 * when it EXACTLY matches a known, generic Inter error label. Seeded from
 * the title values the existing contract tests depend on
 * (tests/unit/pagamentos/imock-inter-http.test.ts). Absent an allowlist
 * entry, title is never surfaced.
 */
const TITLE_ALLOWLIST: ReadonlySet<string> = new Set(['Campo inválido']);

/** Cheap pre-allowlist bound: no legit Inter error label approaches this. */
const MAX_TITLE_LENGTH = 64;

/**
 * Extracts a NO-PII error code from an Inter error response. Prefers a
 * machine `codigo` (only if it matches the strict grammar above), falls back
 * to the error `title` ONLY when it exactly matches the allowlist of known
 * generic labels, and finally to the HTTP status. The `detail`/`violacoes`
 * fields are deliberately ignored — they can echo the chave or recipient
 * name — and `codigo`/`title` are gated because Inter can echo payer
 * identifiers (CPF, e-mail, PIX key) in those fields too.
 */
export function extractInterErrorCode(response: InterHttpResponse): string {
  const parsed = parseJson<InterErrorBody>(response.body);
  if (parsed !== null) {
    const codigo =
      typeof parsed.codigo === 'string'
        ? parsed.codigo
        : typeof parsed.codigo === 'number'
          ? String(parsed.codigo)
          : null;
    if (codigo !== null && (CODIGO_NUMERIC.test(codigo) || CODIGO_TOKEN.test(codigo))) {
      return codigo;
    }
    if (
      typeof parsed.title === 'string' &&
      parsed.title.length <= MAX_TITLE_LENGTH &&
      TITLE_ALLOWLIST.has(parsed.title)
    ) {
      return parsed.title;
    }
  }
  return `HTTP_${response.statusCode}`;
}
