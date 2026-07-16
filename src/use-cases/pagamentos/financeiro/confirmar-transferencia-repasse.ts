import { SpanStatusCode } from '@opentelemetry/api';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseJobEnqueuer } from '../../../adapters/pagamentos/transferencia-enqueuer.js';
import type { TransferenciaProvider } from '../../../adapters/pagamentos/transferencia-provider.js';
import type { IdRepasse } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import type { Observability } from '../../../observability/observability.js';

/**
 * aperture-vvh2j — `repasse.confirmar` job handler. Reconciles a repasse
 * stuck in `verificando` (an ambiguous executar outcome: timeout, crash,
 * or Inter-side APROVACAO) to a terminal state.
 *
 * INVARIANT: this handler NEVER calls pagarPix. It only observes Inter
 * (consultarPagamento / buscarPagamentos) and resolves the FSM. That is
 * what makes `verificando` the shut double-pay door.
 *
 *  - With a codigoSolicitacao → poll consultarPagamento.
 *  - Without one (we crashed before capturing it) → buscarPagamentos over
 *    the attempt window, match by valor + chave, adopt the codigo, then poll.
 *  - Non-terminal → reschedule on an escalating backoff (30s → 2m → 10m →
 *    1h → 6h…), up to ~48h; past that, stay `verificando` and alert the
 *    operator (should be ~never).
 */

const DELAYS_CURTOS_SEGUNDOS = [30, 120, 600, 3600]; // tentativas 1..4
const DELAY_LONGO_SEGUNDOS = 6 * 60 * 60; // 6h thereafter
export const MAX_TENTATIVAS_CONFIRMACAO = 12; // ~48h total window

/**
 * Delay before firing the given confirmar tentativa, or null when the
 * escalation window is exhausted (→ operator alert, repasse stays verificando).
 */
export function proximoDelayConfirmacao(tentativa: number): number | null {
  if (tentativa > MAX_TENTATIVAS_CONFIRMACAO) return null;
  return DELAYS_CURTOS_SEGUNDOS[tentativa - 1] ?? DELAY_LONGO_SEGUNDOS;
}

/** Inter consult statuses that mean the money definitively landed. */
const STATUS_PAGO = new Set(['pago']);
/** Inter consult statuses that mean the payment definitively did not/won't happen. */
const STATUS_FALHOU = new Set(['rejeitado', 'cancelado']);

export interface ConfirmarTransferenciaRepasseDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly transferenciaProvider: TransferenciaProvider;
  readonly repasseJobEnqueuer: RepasseJobEnqueuer;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface ConfirmarTransferenciaRepasseInput {
  readonly idRepasse: IdRepasse;
  readonly tentativaConfirmacao: number;
}

export async function confirmarTransferenciaRepasse(
  deps: ConfirmarTransferenciaRepasseDeps,
  input: ConfirmarTransferenciaRepasseInput,
): Promise<void> {
  const {
    livroFinanceiroRepository,
    transferenciaProvider,
    repasseJobEnqueuer,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;
  const { idRepasse, tentativaConfirmacao } = input;

  return tracer.startActiveSpan('confirmarTransferenciaRepasse', async (span) => {
    span.setAttribute('financeiro.repasse.id', idRepasse);
    span.setAttribute('financeiro.repasse.tentativa_confirmacao', tentativaConfirmacao);
    try {
      const repasse = await livroFinanceiroRepository.findRepasseById(idRepasse);
      if (!repasse) {
        logger.warn('financeiro.repasse.confirmar.nao_encontrado', { idRepasse });
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }
      // Only a verificando repasse is reconcilable — anything else already resolved.
      if (repasse.status !== 'verificando') {
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      const agora = clock();
      let codigo = repasse.interCodigoSolicitacao;

      // No codigo (crashed before response) → reconcile via search.
      if (codigo === null) {
        const recebedor = await livroFinanceiroRepository.findRecebedorAtivoPorIdCampanha(
          repasse.idCampanha,
        );
        const chave = recebedor?.metodo === 'pix' ? recebedor.chavePix : undefined;
        const janela = janelaBusca(repasse.aprovadoEm ?? repasse.solicitadoEm, agora);
        const encontrados = await transferenciaProvider.buscarPagamentos(janela);
        const match = encontrados.find(
          (p) =>
            p.valorCents === repasse.amountCents &&
            (p.chave === undefined || chave === undefined || p.chave === chave),
        );
        if (match) {
          codigo = match.codigoSolicitacao; // adopt, then poll precisely below
        } else {
          // Definitively absent after a couple of tries → safe to retry (falhou).
          if (tentativaConfirmacao >= 2) {
            await livroFinanceiroRepository.resolverVerificacaoTransferencia({
              idRepasse,
              resultado: { tipo: 'falhou', erro: 'NAO_ENCONTRADO_NA_BUSCA' },
              reconciliacaoResumo: `busca:sem_match;tentativa:${tentativaConfirmacao}`,
              agora,
            });
            logger.warn('financeiro.repasse.confirmar.sem_match', { idRepasse });
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }
          await reagendar(repasseJobEnqueuer, idRepasse, tentativaConfirmacao, logger, span);
          return;
        }
      }

      // Poll the (now-known) codigo for a precise status.
      const consulta = await transferenciaProvider.consultarPagamento(codigo);
      span.setAttribute('financeiro.repasse.consulta_status', consulta.status);

      if (STATUS_PAGO.has(consulta.status)) {
        await livroFinanceiroRepository.resolverVerificacaoTransferencia({
          idRepasse,
          resultado: { tipo: 'pago', codigoSolicitacao: codigo },
          reconciliacaoResumo: `consulta:${consulta.status}`,
          agora,
        });
        logger.info('financeiro.repasse.confirmar.pago', { idRepasse });
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      if (STATUS_FALHOU.has(consulta.status)) {
        await livroFinanceiroRepository.resolverVerificacaoTransferencia({
          idRepasse,
          resultado: { tipo: 'falhou', erro: `CONSULTA_${consulta.status.toUpperCase()}` },
          reconciliacaoResumo: `consulta:${consulta.status}`,
          agora,
        });
        logger.warn('financeiro.repasse.confirmar.falhou', { idRepasse, status: consulta.status });
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Still non-terminal (em_processamento / aguardando_aprovacao) → reschedule.
      await reagendar(repasseJobEnqueuer, idRepasse, tentativaConfirmacao, logger, span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

function janelaBusca(inicio: Date, fim: Date): { dataInicio: string; dataFim: string } {
  // ISO date (yyyy-mm-dd) window, padded a day back to absorb clock skew.
  const start = new Date(inicio.getTime() - 24 * 60 * 60 * 1000);
  return {
    dataInicio: start.toISOString().slice(0, 10),
    dataFim: fim.toISOString().slice(0, 10),
  };
}

async function reagendar(
  enqueuer: RepasseJobEnqueuer,
  idRepasse: IdRepasse,
  tentativaAtual: number,
  logger: Observability['logger'],
  span: { setStatus: (s: { code: SpanStatusCode; message?: string }) => void },
): Promise<void> {
  const proxima = tentativaAtual + 1;
  const delay = proximoDelayConfirmacao(proxima);
  if (delay === null) {
    // Exhausted the ~48h window without resolution — should be ~never.
    // Stay verificando (never guess) and raise it for the operator.
    logger.error('financeiro.repasse.confirmar.esgotado', { idRepasse, tentativa: tentativaAtual });
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }
  await enqueuer.enqueueConfirmar({ idRepasse, tentativaConfirmacao: proxima }, delay);
  logger.info('financeiro.repasse.confirmar.reagendado', { idRepasse, proxima, delay });
  span.setStatus({ code: SpanStatusCode.OK });
}
