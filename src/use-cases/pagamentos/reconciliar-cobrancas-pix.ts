import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { LivroFinanceiroRepository } from '../../adapters/pagamentos/financeiro/livro-repository.js';
import type { PixCobrancaProvider } from '../../adapters/pagamentos/pix-cobranca-provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { TransacaoExterna } from '../../domain/pagamentos/entities/pagamento.js';
import type { Observability } from '../../observability/observability.js';
import { finalizarPagamentoAprovadoComTransacaoVerificada } from '../checkout/finalizar-pagamento-aprovado.js';
import { rejeitarPagamentoComTransacaoVerificada } from './rejeitar-pagamento.js';

/**
 * The poll runs every five minutes. A ten-minute lease tolerates a slow Inter
 * read without allowing the next scheduled pickup to overlap it. A process
 * crash leaves the lease in PostgreSQL; a later run reclaims it after expiry.
 */
export const PIX_COBRANCA_RECONCILIATION_LEASE_MS = 10 * 60 * 1000;
export const PIX_COBRANCA_RECONCILIATION_BATCH_SIZE = 100;

export interface ReconciliarCobrancasPixDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pixCobrancaProvider: PixCobrancaProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly campanhaRepository: CampanhaRepository;
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface ReconciliarCobrancasPixResult {
  readonly claimed: number;
  readonly approved: number;
  readonly rejected: number;
  readonly deferred: number;
  readonly failed: number;
}

type MutableResult = {
  claimed: number;
  approved: number;
  rejected: number;
  deferred: number;
  failed: number;
};

/**
 * Reconciles due Banco Inter PIX charges from authoritative GET /cob reads.
 *
 * No transition is inferred from a webhook payload or local time alone. The
 * repository first leases only persisted, expired Inter intents. Each leased
 * txid is then read exactly once from Inter before an approved/rejected fact is
 * handed to the provider-free bookkeeping seams.
 *
 * Deliberate spec correction: this job does not call `/webhook/callbacks`.
 * That route belongs to a different Inter API product with different scopes
 * and PII-rich payloads; it is not part of the Pix v2 cobrança contract. B4 is
 * therefore bounded to the authoritative GET `/cob/{txid}` reconciliation
 * surface already implemented by PixCobrancaProvider.
 */
export async function reconciliarCobrancasPix(
  deps: ReconciliarCobrancasPixDeps,
): Promise<ReconciliarCobrancasPixResult> {
  const now = deps.clock();
  const leaseUntil = new Date(now.getTime() + PIX_COBRANCA_RECONCILIATION_LEASE_MS);
  const candidates = await deps.pagamentoRepository.claimPixCobrancaReconciliationCandidates({
    now,
    leaseUntil,
    limit: PIX_COBRANCA_RECONCILIATION_BATCH_SIZE,
  });
  const result: MutableResult = {
    claimed: candidates.length,
    approved: 0,
    rejected: 0,
    deferred: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const authoritative = await deps.pixCobrancaProvider.consultarCobranca(candidate.txid);

      switch (authoritative.status) {
        case 'concluida': {
          await finalizarPagamentoAprovadoComTransacaoVerificada(
            {
              pagamentoRepository: deps.pagamentoRepository,
              pagamentoEventPublisher: deps.pagamentoEventPublisher,
              contribuicaoRepository: deps.contribuicaoRepository,
              campanhaRepository: deps.campanhaRepository,
              livroFinanceiroRepository: deps.livroFinanceiroRepository,
              clock: deps.clock,
              observability: deps.observability,
            },
            {
              idPagamento: candidate.idPagamento,
              transacao: {
                id: authoritative.e2eId,
                provedor: 'inter',
                status: 'aprovado',
                amountCents: authoritative.valorPagoCents,
                criadaEm: authoritative.horario,
              },
            },
          );
          result.approved += 1;
          break;
        }

        case 'ativa':
        case 'removida': {
          const pagamento = await deps.pagamentoRepository.findById(candidate.idPagamento);
          if (!pagamento) {
            throw new Error('payment_missing');
          }
          const transacao: TransacaoExterna = {
            id: candidate.txid,
            provedor: 'inter',
            status: 'rejeitado',
            amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
            criadaEm: deps.clock(),
            statusBruto: authoritative.status === 'ativa' ? 'ATIVA_EXPIRADA' : 'REMOVIDA',
          };
          await rejeitarPagamentoComTransacaoVerificada(
            {
              pagamentoRepository: deps.pagamentoRepository,
              pagamentoEventPublisher: deps.pagamentoEventPublisher,
              clock: deps.clock,
              observability: deps.observability,
            },
            { idPagamento: candidate.idPagamento, transacao },
          );
          result.rejected += 1;
          break;
        }

        case 'desconhecido':
          result.deferred += 1;
          deps.observability.logger.warn('pix_cobranca.reconciliation.deferred', {
            idPagamento: candidate.idPagamento,
            reason: 'unknown_provider_status',
          });
          break;

        default:
          result.deferred += 1;
          deps.observability.logger.warn('pix_cobranca.reconciliation.deferred', {
            idPagamento: candidate.idPagamento,
            reason: 'malformed_provider_status',
          });
      }
    } catch (error) {
      result.failed += 1;
      deps.observability.logger.warn('pix_cobranca.reconciliation.failed', {
        idPagamento: candidate.idPagamento,
        // Provider/user payloads and raw exception messages are deliberately
        // excluded. The category is sufficient for alerting and is NO-PII.
        reason: classifyFailure(error),
      });
    } finally {
      const released = await deps.pagamentoRepository.releasePixCobrancaReconciliationClaim(
        candidate.idPagamento,
        leaseUntil,
      );
      if (!released) {
        deps.observability.logger.warn('pix_cobranca.reconciliation.lease_not_released', {
          idPagamento: candidate.idPagamento,
          reason: 'lease_replaced_or_already_cleared',
        });
      }
    }
  }

  return result;
}

function classifyFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_failure';
  if (error.name === 'PixCobrancaTransitoriaError') return 'provider_transient';
  if (error.name === 'ZodError') return 'provider_response_invalid';
  if (error.message === 'payment_missing') return 'payment_missing';
  return 'transition_or_provider_failed';
}
