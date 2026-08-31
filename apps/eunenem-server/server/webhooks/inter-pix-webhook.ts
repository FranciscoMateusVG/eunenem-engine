import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, Hono } from 'hono';
import {
  archiveAndDispatchInterPixWebhook,
  finalizarPagamentoAprovadoComTransacaoVerificada,
  hashClientPII,
  type InterPixRefundConfirmed,
  type PixCobrancaProvider,
} from '../../../../src/index.js';
import {
  shouldBindInterCobrancaAdapter,
  type ServerDeps,
  type ServerEnv,
} from '../auth/setup.js';
import { trustedClientIp } from '../lib/security/trusted-client-ip.js';
import { consumeRateLimit } from '../trpc/rate-limit.js';

const tracer = trace.getTracer('eunenem-server');

export const INTER_PIX_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const INTER_PIX_WEBHOOK_RATE_LIMIT_MAX = 600;
export const INTER_PIX_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * One unsigned callback may cause at most one provider read per known txid
 * during a rate-limit window. The durable repository lease is shared with
 * B4 reconciliation, so another process cannot race this cooldown and a
 * crashed worker becomes reclaimable after expiry.
 */
export const INTER_PIX_WEBHOOK_PROVIDER_READ_LEASE_MS = 60_000;
export const INTER_PIX_WEBHOOK_PATHS = [
  '/api/webhooks/inter/pix',
  '/api/webhooks/inter/pix/pix',
] as const;

type ConsumeInterPixRateLimit = typeof consumeRateLimit;

export interface InterPixWebhookDeps
  extends Pick<
    ServerDeps,
    | 'db'
    | 'webhookEventArchive'
    | 'pagamentoRepository'
    | 'pixCobrancaDevolucaoRepository'
    | 'pagamentoEventPublisher'
    | 'pixReceiptNotifier'
    | 'contribuicaoRepository'
    | 'campanhaRepository'
    | 'livroFinanceiroRepository'
    | 'observability'
    | 'clock'
    | 'trustedHopCount'
    | 'logPiiHashSalt'
    | 'serverAnalytics'
  > {
  readonly pixCobrancaProvider: PixCobrancaProvider;
  /**
   * B6 supplies the provider-free refund bookkeeping seam. Until then a
   * verified refund is archived as failed and recovered after B6/B4; this
   * handler never initiates a second refund from a refund notification.
   */
  readonly onInterPixRefundConfirmed?: (
    confirmed: InterPixRefundConfirmed,
  ) => Promise<{ pagamentoId: string | null }>;
}

export interface InterPixWebhookHandlerOptions {
  /** Test seam; production always uses the durable Postgres limiter. */
  readonly consumeRateLimit?: ConsumeInterPixRateLimit;
}

/**
 * Register the public Inter callback only when the real Inter adapter is
 * available. This deliberately shares the composition-root predicate so a
 * rollback to Stripe keeps callbacks alive while complete Inter credentials
 * remain configured for in-flight charges.
 */
export function mountInterPixWebhookRoutesWhenBound(
  app: Hono,
  env: ServerEnv,
  deps: InterPixWebhookDeps,
  options: InterPixWebhookHandlerOptions = {},
): boolean {
  if (!shouldBindInterCobrancaAdapter(env)) {
    return false;
  }
  mountInterPixWebhookRoutes(app, deps, options);
  return true;
}

class InterPixWebhookBodyTooLargeError extends Error {
  constructor() {
    super('inter_pix_webhook_body_too_large');
    this.name = 'InterPixWebhookBodyTooLargeError';
  }
}

/**
 * Banco Inter Pix callback handler.
 *
 * Inter supplies no payload signature. The payload is only a routing hint;
 * `archiveAndDispatchInterPixWebhook` first binds charge txids to eligible
 * local Inter payments, then re-queries the authoritative cobrança API before
 * either verified-result callback can run. Accepted, durably archived
 * envelopes return 200 even when an item remains unconfirmed so the route
 * stays fast and B4 reconciliation owns eventual recovery.
 */
export function createInterPixWebhookHandler(
  deps: InterPixWebhookDeps,
  options: InterPixWebhookHandlerOptions = {},
) {
  const consume = options.consumeRateLimit ?? consumeRateLimit;
  return async (c: Context): Promise<Response> => {
    return tracer.startActiveSpan('webhook.inter.pix', async (span) => {
      const { logger } = deps.observability;

      try {
        const clientIp = trustedClientIp(c.req.raw.headers, deps.trustedHopCount);
        const clientIpHash = hashClientPII(clientIp, deps.logPiiHashSalt);
        const rateLimit = await consume(deps.db, {
          key: `webhook:inter-pix:${clientIpHash}`,
          max: INTER_PIX_WEBHOOK_RATE_LIMIT_MAX,
          windowMs: INTER_PIX_WEBHOOK_RATE_LIMIT_WINDOW_MS,
          clock: deps.clock,
        });
        if (!rateLimit.allowed) {
          logger.warn('webhook.inter.pix.rate_limited', { clientIpHash });
          span.setAttribute('webhook.outcome', 'rate_limited');
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'rate limited' });
          c.header('Retry-After', String(Math.ceil(rateLimit.windowMs / 1000)));
          return c.text('too many requests', 429);
        }

        const rawBody = await readBoundedBody(c.req.raw, INTER_PIX_WEBHOOK_MAX_BODY_BYTES);
        const result = await archiveAndDispatchInterPixWebhook(deps.webhookEventArchive, {
          rawBody,
          pixCobrancaProvider: deps.pixCobrancaProvider,
          resolveChargeBinding: async (identity) => {
            const now = deps.clock();
            const pagamentoId =
              await deps.pagamentoRepository.claimPixCobrancaProviderReadByTxid({
                txid: identity.txid,
                e2eId: identity.e2eId,
                now,
                leaseUntil: new Date(now.getTime() + INTER_PIX_WEBHOOK_PROVIDER_READ_LEASE_MS),
              });
            return pagamentoId === undefined
              ? null
              : { pagamentoId, txid: identity.txid };
          },
          onChargeConfirmed: async (confirmed) => {
            const finalized = await finalizarPagamentoAprovadoComTransacaoVerificada(
              {
                pagamentoRepository: deps.pagamentoRepository,
                pagamentoEventPublisher: deps.pagamentoEventPublisher,
                contribuicaoRepository: deps.contribuicaoRepository,
                campanhaRepository: deps.campanhaRepository,
                livroFinanceiroRepository: deps.livroFinanceiroRepository,
                clock: deps.clock,
                observability: deps.observability,
                pixReceiptNotifier: deps.pixReceiptNotifier,
              },
              {
                idPagamento: confirmed.pagamentoId,
                transacao: {
                  id: confirmed.e2eId,
                  provedor: 'inter',
                  status: 'aprovado',
                  amountCents: confirmed.amountCents,
                  criadaEm: confirmed.horario,
                },
              },
            );
            const campanha = await deps.campanhaRepository.findById(
              finalized.pagamento.intencao.idCampanha,
            );
            deps.serverAnalytics?.track(
              'pagamento_aprovado',
              campanha?.idsAdministradores[0] ?? null,
              {
                idPagamento: finalized.pagamento.id,
                idCampanha: finalized.pagamento.intencao.idCampanha,
                provider: 'inter',
              },
            );
            return { pagamentoId: finalized.pagamento.id };
          },
          resolveRefundBinding: async (identity) => {
            const record = await deps.pixCobrancaDevolucaoRepository.findByIdentity(
              identity.e2eId,
              identity.idDevolucao,
            );
            return record === undefined
              ? null
              : {
                  e2eId: record.e2eId,
                  idDevolucao: record.idDevolucao,
                  amountCents: record.amountCents,
                };
          },
          onRefundConfirmed: async (confirmed) => {
            if (!deps.onInterPixRefundConfirmed) {
              throw new Error('inter_refund_bookkeeping_not_configured');
            }
            return deps.onInterPixRefundConfirmed(confirmed);
          },
        });

        span.setAttribute('webhook.outcome', result.outcome);
        span.setAttribute('webhook.items.count', result.items.length);
        const pendingItems = result.items.filter(
          (item) =>
            item.outcome !== 'dispatched_success' && !item.outcome.startsWith('duplicate_'),
        );
        if (pendingItems.length > 0) {
          logger.warn('webhook.inter.pix.items_pending', {
            failedCount: pendingItems.length,
            outcomes: pendingItems.map((item) => item.outcome),
            archiveIds: pendingItems.map((item) => item.archiveId),
          });
        } else {
          logger.info('webhook.inter.pix.accepted', {
            itemCount: result.items.length,
          });
        }
        span.setStatus({
          code: result.status === 200 ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          ...(result.status === 200 ? {} : { message: result.outcome }),
        });
        return c.text(result.body, result.status);
      } catch (error) {
        if (error instanceof InterPixWebhookBodyTooLargeError) {
          logger.warn('webhook.inter.pix.body_too_large', {});
          span.setAttribute('webhook.outcome', 'body_too_large');
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'body too large' });
          return c.text('payload too large', 413);
        }

        // Do not log/record arbitrary provider or payload errors. Inter error
        // bodies can carry payer data; a categorical outcome is sufficient.
        logger.error('webhook.inter.pix.unexpected_error', {});
        span.setAttribute('webhook.outcome', 'unexpected_error');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'unexpected error' });
        return c.text('internal error', 500);
      } finally {
        span.end();
      }
    });
  };
}

/** Mount both the registered base URL and Inter's delivery-time `/pix` suffix. */
export function mountInterPixWebhookRoutes(
  app: Hono,
  deps: InterPixWebhookDeps,
  options: InterPixWebhookHandlerOptions = {},
): void {
  const handler = createInterPixWebhookHandler(deps, options);
  for (const path of INTER_PIX_WEBHOOK_PATHS) app.post(path, handler);
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new InterPixWebhookBodyTooLargeError();
    }
  }

  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new InterPixWebhookBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
