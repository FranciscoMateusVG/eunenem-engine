import type { Pagamento } from '../../../../src/domain/pagamentos/entities/pagamento.js';
import type { ServerDeps } from '../auth/setup.js';
import { consumeRateLimit } from './rate-limit.js';

export type PixStatusResult = {
  status: 'pendente' | 'confirmado' | 'expirado' | 'rejeitado';
  retryableError?: boolean;
};

type Deps = Pick<
  ServerDeps,
  | 'db'
  | 'clock'
  | 'observability'
  | 'pagamentoRepository'
  | 'pixCobrancaProvider'
  | 'cobrancaPixProviderKind'
>;

function terminal(payment: Pagamento | undefined): PixStatusResult | undefined {
  if (payment?.status === 'aprovado') return { status: 'confirmado' };
  if (payment?.status === 'rejeitado' || payment?.status === 'estornado')
    return { status: 'rejeitado' };
  return undefined;
}

/** Public display only: never settles a payment or holds the webhook's reconciliation lease. */
export async function readPixStatus(
  deps: Deps,
  payment: Pagamento,
  txid: string,
): Promise<PixStatusResult> {
  const final = terminal(payment);
  if (final) return final;
  if (
    deps.cobrancaPixProviderKind === 'stripe' ||
    deps.clock().getTime() - Math.max(payment.criadoEm.getTime(), payment.atualizadoEm.getTime()) <
      60_000
  ) {
    return { status: 'pendente' };
  }
  // Independent durable admission: one provider GET/payment/minute across tabs,
  // processes and restarts. Never steal the lease used by pix.recebido/5min worker.
  try {
    const admission = await consumeRateLimit(deps.db, {
      key: `pix-status:provider-read:${payment.id}`,
      max: 1,
      windowMs: 60_000,
      clock: deps.clock,
    });
    if (!admission.allowed) return { status: 'pendente' };
  } catch {
    return { status: 'pendente', retryableError: true };
  }
  const latest = await deps.pagamentoRepository.findById(payment.id);
  const committed = terminal(latest);
  if (committed) return committed;
  if (!latest || latest.intencao.externalRef !== txid) return { status: 'pendente' };

  const started = performance.now();
  let outcome = 'error';
  try {
    const charge = await deps.pixCobrancaProvider.consultarCobranca(txid);
    outcome = charge.status;
    // A webhook may have committed while the GET was in flight; DB wins.
    const after = terminal(await deps.pagamentoRepository.findById(payment.id));
    if (after) return after;
    if (charge.status === 'concluida') return { status: 'confirmado' };
    if (charge.status === 'removida') return { status: 'expirado' };
    return { status: 'pendente' };
  } catch {
    const after = terminal(await deps.pagamentoRepository.findById(payment.id));
    return after ?? { status: 'pendente', retryableError: true };
  } finally {
    try {
      deps.observability.logger.info('pix.status.provider_read', {
        paymentId: payment.id,
        callCount: 1,
        outcome,
        durationMs: Math.round(performance.now() - started),
      });
    } catch {
      /* Logging cannot change the public status. */
    }
  }
}
