import { SpanStatusCode } from '@opentelemetry/api';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseJobEnqueuer } from '../../../adapters/pagamentos/transferencia-enqueuer.js';
import {
  type TransferenciaProvider,
  TransferenciaTransitoriaError,
} from '../../../adapters/pagamentos/transferencia-provider.js';
import type { IdRepasse } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import type { Observability } from '../../../observability/observability.js';

/**
 * aperture-vvh2j — `repasse.executar` job handler. Fires one PIX attempt
 * for an approved (or admin-retried) pix repasse.
 *
 * This handler is where the core invariant — "at most one successful PIX
 * per repasse, ever" — is enforced at runtime:
 *
 *  - The intent row is committed (iniciar) BEFORE pagarPix, so no payment
 *    can exist without a record.
 *  - A crash mid-attempt leaves the repasse in `transferindo`; the
 *    re-delivered job sees `acao: 'reconciliar'` and diverts to
 *    `verificando` WITHOUT calling pagarPix again.
 *  - Only a `TransferenciaTransitoriaError` (definitely no payment) is
 *    auto-retried (revert → aprovado, rethrow → pg-boss retries). EVERY
 *    other throw / timeout is treated as ambiguous → `verificando`.
 *  - The stable `transferReferencia` is reused for every attempt.
 *
 * Worker concurrency is pinned to 1 at registration — serialization
 * removes a whole class of races on top of the per-row FOR UPDATE.
 */

/** First confirmar poll fires 30s after we enter `verificando`. */
export const CONFIRMAR_DELAY_INICIAL_SEGUNDOS = 30;

/**
 * Max fresh attempts before a persistently-transient failure is surfaced
 * to the admin as `falhou` (matches the spec's retryLimit intent). The
 * attempt counter increments on every fresh claim, including transient
 * reverts, so this bounds retry storms.
 */
export const MAX_TENTATIVAS_TRANSITORIAS = 4;

export interface ExecutarTransferenciaRepasseDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly transferenciaProvider: TransferenciaProvider;
  readonly repasseJobEnqueuer: RepasseJobEnqueuer;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface ExecutarTransferenciaRepasseInput {
  readonly idRepasse: IdRepasse;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this handler carries the "at most one successful PIX per repasse" invariant; every branch (acao gate, transient-vs-ambiguous classification, outcome switch) is deliberately explicit and linear for money-path auditability. Extracting helpers would hide the invariant across call boundaries.
export async function executarTransferenciaRepasse(
  deps: ExecutarTransferenciaRepasseDeps,
  input: ExecutarTransferenciaRepasseInput,
): Promise<void> {
  const {
    livroFinanceiroRepository,
    transferenciaProvider,
    repasseJobEnqueuer,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;
  const { idRepasse } = input;

  return tracer.startActiveSpan('executarTransferenciaRepasse', async (span) => {
    span.setAttribute('financeiro.repasse.id', idRepasse);
    try {
      // Load repasse + recebedor for chave/valor + a PII-free audit summary.
      const repasse = await livroFinanceiroRepository.findRepasseById(idRepasse);
      if (!repasse) {
        logger.warn('financeiro.repasse.executar.nao_encontrado', { idRepasse });
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }
      const recebedor = await livroFinanceiroRepository.findRecebedorAtivoPorIdCampanha(
        repasse.idCampanha,
      );
      if (!recebedor || recebedor.metodo !== 'pix') {
        // A non-pix repasse should never be in this queue. Fail it safely
        // rather than call pagarPix without a chave.
        const agora = clock();
        const iniciado = await livroFinanceiroRepository.iniciarTransferenciaTransaction({
          idRepasse,
          requestSummary: 'recebedor_nao_pix',
          agora,
        });
        if (iniciado.acao === 'prosseguir') {
          await livroFinanceiroRepository.finalizarTentativaTransferencia({
            idRepasse,
            attemptId: iniciado.attemptId,
            resultado: { tipo: 'falhou', erro: 'RECEBEDOR_NAO_PIX' },
            agora,
          });
        }
        logger.error('financeiro.repasse.executar.recebedor_nao_pix', { idRepasse });
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      const agora = clock();
      // Non-PII audit summary: amount + chave TYPE only (never the chave value).
      const requestSummary = `valor:${repasse.amountCents};tipo_chave:${recebedor.tipoChavePix}`;

      const iniciado = await livroFinanceiroRepository.iniciarTransferenciaTransaction({
        idRepasse,
        requestSummary,
        agora,
      });
      span.setAttribute('financeiro.repasse.acao', iniciado.acao);
      span.setAttribute('financeiro.repasse.attempt_no', iniciado.attemptNo);

      // Terminal / already-resolved → nothing to do.
      if (iniciado.acao === 'concluido') {
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Crash re-delivery — a payment MAY exist. Do NOT call pagarPix.
      // Divert to verificando and let confirmar reconcile.
      if (iniciado.acao === 'reconciliar') {
        await livroFinanceiroRepository.finalizarTentativaTransferencia({
          idRepasse,
          attemptId: iniciado.attemptId,
          resultado: {
            tipo: 'verificando',
            codigoSolicitacao: iniciado.repasse.interCodigoSolicitacao,
          },
          agora,
        });
        await repasseJobEnqueuer.enqueueConfirmar(
          { idRepasse, tentativaConfirmacao: 1 },
          CONFIRMAR_DELAY_INICIAL_SEGUNDOS,
        );
        logger.warn('financeiro.repasse.executar.reconciliar', { idRepasse });
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // acao === 'prosseguir' — fresh claim. Fire the PIX.
      const referencia = iniciado.repasse.transferReferencia;
      if (referencia === null) {
        // Guarded by the domain; defensive.
        await livroFinanceiroRepository.finalizarTentativaTransferencia({
          idRepasse,
          attemptId: iniciado.attemptId,
          resultado: { tipo: 'falhou', erro: 'SEM_REFERENCIA' },
          agora,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      const shortId = String(idRepasse).slice(0, 8);
      let outcome: Awaited<ReturnType<TransferenciaProvider['pagarPix']>>;
      try {
        outcome = await transferenciaProvider.pagarPix({
          chave: recebedor.chavePix,
          valorCents: repasse.amountCents,
          descricao: `EuNeném — repasse ${shortId}`,
          referencia,
        });
      } catch (err: unknown) {
        const finalizar = livroFinanceiroRepository.finalizarTentativaTransferencia;
        if (err instanceof TransferenciaTransitoriaError) {
          // Definitely no payment created. Exhausted → falhou; else revert
          // to aprovado and rethrow so pg-boss retries a clean fresh claim.
          if (iniciado.attemptNo >= MAX_TENTATIVAS_TRANSITORIAS) {
            await finalizar({
              idRepasse,
              attemptId: iniciado.attemptId,
              resultado: { tipo: 'falhou', erro: 'TRANSITORIO_ESGOTADO' },
              agora,
            });
            logger.error('financeiro.repasse.executar.transitorio_esgotado', {
              idRepasse,
              attemptNo: iniciado.attemptNo,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }
          await finalizar({
            idRepasse,
            attemptId: iniciado.attemptId,
            resultado: { tipo: 'transitorio', erro: 'TRANSITORIO' },
            agora,
          });
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'transitorio' });
          throw err; // pg-boss retries
        }

        // AMBIGUOUS — a payment may exist. Never auto-retry; reconcile.
        await finalizar({
          idRepasse,
          attemptId: iniciado.attemptId,
          resultado: { tipo: 'verificando', codigoSolicitacao: null },
          agora,
        });
        await repasseJobEnqueuer.enqueueConfirmar(
          { idRepasse, tentativaConfirmacao: 1 },
          CONFIRMAR_DELAY_INICIAL_SEGUNDOS,
        );
        logger.warn('financeiro.repasse.executar.ambiguo', { idRepasse });
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Resolve the returned outcome.
      switch (outcome.outcome) {
        case 'pago': {
          await livroFinanceiroRepository.finalizarTentativaTransferencia({
            idRepasse,
            attemptId: iniciado.attemptId,
            resultado: { tipo: 'pago', codigoSolicitacao: outcome.codigoSolicitacao },
            agora,
          });
          logger.info('financeiro.repasse.executar.pago', { idRepasse });
          break;
        }
        case 'agendado_aprovacao': {
          // Inter-side approval workflow — NOT success. Reconcile.
          await livroFinanceiroRepository.finalizarTentativaTransferencia({
            idRepasse,
            attemptId: iniciado.attemptId,
            resultado: { tipo: 'verificando', codigoSolicitacao: outcome.codigoSolicitacao },
            agora,
          });
          await repasseJobEnqueuer.enqueueConfirmar(
            { idRepasse, tentativaConfirmacao: 1 },
            CONFIRMAR_DELAY_INICIAL_SEGUNDOS,
          );
          logger.info('financeiro.repasse.executar.agendado_aprovacao', { idRepasse });
          break;
        }
        case 'rejeitado': {
          // Clean rejection — payment definitely not created. Admin-actionable.
          await livroFinanceiroRepository.finalizarTentativaTransferencia({
            idRepasse,
            attemptId: iniciado.attemptId,
            resultado: { tipo: 'falhou', erro: outcome.erro },
            agora,
          });
          logger.warn('financeiro.repasse.executar.rejeitado', { idRepasse, erro: outcome.erro });
          break;
        }
        default: {
          const _exhaustive: never = outcome;
          throw new Error(`unhandled pagarPix outcome ${JSON.stringify(_exhaustive)}`);
        }
      }

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
