import { metrics } from '@opentelemetry/api';
import type { Logger } from '../../../../src/observability/logger.js';

const failures = metrics.getMeter('eunenem.provider-fees').createCounter('provider_fees.registration_failures');
/** Optional expense collection must never take payment webhooks down. No raw errors. */
export async function startOptionalFeeJob(
  provider: 'stripe' | 'inter',
  register: () => Promise<void>,
  logger: Pick<Logger, 'error'>,
  counter: Pick<typeof failures, 'add'> = failures,
): Promise<void> {
  try {
    await register();
  } catch {
    // Telemetry itself must not turn an optional job into a fatal boot dependency.
    try { logger.error('provider_fees.registration_failed', { provider, reason: 'registration_failed' }); } catch {}
    try { counter.add(1, { provider }); } catch {}
  }
}
