/** Provider strings can echo credentials/PII. Only exact generic phrases pass.
 * Never serialize the thrown error, SDK raw object, headers or response body.
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
function safeText(value: unknown): string | null {
  return typeof value === 'string' ? (SAFE_TEXT.has(value) ? value : '[redacted]') : null;
}
export function attachCheckoutProviderDiagnostic<T extends Error>(
  error: T,
  endpoint: CheckoutProviderDiagnostic['endpoint'],
  status: unknown,
  body?: unknown,
): T {
  const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  diagnostics.set(error, {
    endpoint,
    httpStatus:
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    title: safeText(fields.title ?? fields.type),
    detail: safeText(fields.detail ?? fields.message),
  });
  return error;
}
export function readCheckoutProviderDiagnostic(error: unknown): CheckoutProviderDiagnostic {
  return error instanceof Error && diagnostics.has(error)
    ? (diagnostics.get(error) as CheckoutProviderDiagnostic)
    : { endpoint: 'unknown', httpStatus: null, title: null, detail: null };
}
