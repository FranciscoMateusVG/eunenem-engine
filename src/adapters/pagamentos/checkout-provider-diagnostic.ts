/** Provider strings can echo credentials/PII. Only LOGS use the generic-phrase allowlist.
 * Logs never serialize the error/body; DB-only projection explicitly retains provider responses.
 */
const SAFE_TEXT = new Set([
  'Internal Server Error',
  'Bad Request',
  'Unauthorized',
  'Forbidden',
  'Not Found',
  'Too Many Requests',
  'Service Unavailable',
  'Gateway Timeout',
  'Service temporarily unavailable',
  'An internal server error occurred',
  'Erro interno do servidor',
  'Serviço temporariamente indisponível',
]);
export interface CheckoutProviderDiagnostic {
  readonly endpoint:
    | '/pix/v2/cob/:txid'
    | '/v1/checkout/sessions'
    | '/v1/checkout/sessions/:id'
    | 'unknown';
  readonly httpStatus: number | null;
  readonly title: string | null;
  readonly detail: string | null;
}
const diagnostics = new WeakMap<Error, CheckoutProviderDiagnostic>();
const persisted = new WeakMap<Error, CheckoutProviderDiagnostic & { readonly body: unknown }>();

/** Private DB-only payload. Do not pass this projection to logs/traces/responses. */
export function readPersistedCheckoutProviderDiagnostic(error: unknown) {
  return error instanceof Error && persisted.has(error)
    ? persisted.get(error)!
    : { ...readCheckoutProviderDiagnostic(error), body: null };
}
function withoutOurSecrets(body: unknown, secrets: readonly string[]): unknown {
  if (body === undefined) return null;
  const isText = typeof body === 'string';
  let serialized = isText ? body : JSON.stringify(body);
  if (serialized === undefined) return null;
  for (const secret of secrets.filter(Boolean)) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    serialized = serialized.split(escaped).join('[our-auth-redacted]');
    serialized = serialized.split(secret).join('[our-auth-redacted]');
  }
  return isText ? serialized : JSON.parse(serialized);
}
function safeText(value: unknown): string | null {
  return typeof value === 'string' ? (SAFE_TEXT.has(value) ? value : '[redacted]') : null;
}
export function attachCheckoutProviderDiagnostic<T extends Error>(
  error: T,
  endpoint: CheckoutProviderDiagnostic['endpoint'],
  status: unknown,
  body?: unknown,
  ourSecrets: readonly string[] = [],
): T {
  const privateBody = withoutOurSecrets(body, ourSecrets);
  let parsed: unknown = privateBody;
  if (typeof privateBody === 'string') {
    try {
      parsed = JSON.parse(privateBody);
    } catch {
      /* preserve non-JSON body */
    }
  }
  const fields = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  diagnostics.set(error, {
    endpoint,
    httpStatus:
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    title: safeText(fields.title ?? fields.type),
    detail: safeText(fields.detail ?? fields.message),
  });
  const safe = diagnostics.get(error)!;
  persisted.set(error, {
    ...safe,
    title:
      typeof (fields.title ?? fields.type) === 'string'
        ? ((fields.title ?? fields.type) as string)
        : null,
    detail:
      typeof (fields.detail ?? fields.message) === 'string'
        ? ((fields.detail ?? fields.message) as string)
        : null,
    body: privateBody,
  });
  return error;
}
export function readCheckoutProviderDiagnostic(error: unknown): CheckoutProviderDiagnostic {
  return error instanceof Error && diagnostics.has(error)
    ? (diagnostics.get(error) as CheckoutProviderDiagnostic)
    : { endpoint: 'unknown', httpStatus: null, title: null, detail: null };
}
