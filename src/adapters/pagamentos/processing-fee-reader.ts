/** Read-only provider observation. Missing evidence is never an estimated zero. */
export interface ProcessingFeeObservation {
  readonly provider: 'stripe' | 'inter';
  readonly accountRef: string;
  readonly environment: 'test' | 'live';
  readonly externalRef: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly source: string;
}
export interface ProcessingFeeReader {
  read(input: {
    chargeRef: string | null;
    paymentIntentRef: string | null;
  }): Promise<ProcessingFeeObservation | null>;
}

export type FeeFailureReason =
  | 'missing_reference'
  | 'provider_not_found'
  | 'provider_auth'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'identity_conflict'
  | 'not_available';
export class ProcessingFeeReadError extends Error {
  constructor(
    readonly reason: FeeFailureReason,
    readonly permanent = false,
  ) {
    super(reason);
    this.name = 'ProcessingFeeReadError';
  }
}
/** Never inspect/store provider message or body. */
export function classifyFeeFailure(error: unknown): {
  reason: FeeFailureReason;
  permanent: boolean;
} {
  if (error instanceof ProcessingFeeReadError) return error;
  const e = error as { statusCode?: unknown; code?: unknown; type?: unknown } | null;
  if (e?.statusCode === 404) return { reason: 'provider_not_found', permanent: true };
  if (e?.statusCode === 401 || e?.statusCode === 403)
    return { reason: 'provider_auth', permanent: true };
  if (
    e?.code === 'ETIMEDOUT' ||
    e?.code === 'ESOCKETTIMEDOUT' ||
    e?.type === 'StripeConnectionError'
  )
    return { reason: 'provider_timeout', permanent: false };
  return { reason: 'provider_unavailable', permanent: false };
}
