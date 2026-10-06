import type { CampanhaRepository } from '../../../../src/adapters/arrecadacao/campanha-repository.js';
import type { Pagamento } from '../../../../src/domain/pagamentos/entities/pagamento.js';
import type { ServerAnalytics } from './server-analytics.js';

/**
 * aperture-4yse9 — THE `pagamento_aprovado` emitter. One helper, three call
 * paths (Stripe webhook, Inter PIX webhook, Inter PIX reconciliation poll), so
 * the props are one schema regardless of provider and the reporting funnel
 * can filter on `metodo` / `provedor` / `caminho` with single keys.
 *
 * Semantics: this is the SERVER APPROVAL event — the pagamento moved to
 * `aprovado` in the database on this call path. It is not settlement or
 * payout evidence. Delivery is best-effort (see server-analytics.ts).
 *
 * Call it ONLY after the caller verified, from its own pre-finalize read,
 * that the pagamento was still pendente|processing (`aprovacaoEhNova`). That
 * guard stops SEQUENTIAL replays (a retry after the transition is committed).
 * It does NOT stop CONCURRENT deliveries: two Stripe events for one payment
 * (checkout.session.completed(paid) and charge.succeeded) can both pre-read
 * pendente, both call finalize (one wins the CAS, the other gets the canonical
 * approved record back as a no-op) and BOTH track — with different
 * `event.created`, so Mixpanel's exact-tuple dedup does not collapse them.
 * This is a known, documented residual of the root-approved best-effort model
 * (no outbox / no transition-winner signal in this round); see the regression
 * in tests/unit/server/phase3-dispatcher.test.ts.
 */
export type CaminhoAprovacao = 'webhook' | 'reconciliacao';

export interface TrackPagamentoAprovadoDeps {
  readonly serverAnalytics?: ServerAnalytics;
  readonly campanhaRepository: CampanhaRepository;
}

export interface TrackPagamentoAprovadoInput {
  readonly pagamento: Pagamento;
  readonly provedor: 'stripe' | 'inter';
  readonly caminho: CaminhoAprovacao;
  /**
   * Business timestamp of the approval fact — Stripe `event.created` or the
   * Inter `horario` (the SAME value the webhook and the reconciliation poll
   * both read from Inter, which is what makes Mixpanel's exact-time dedup key
   * match across the two paths).
   */
  readonly occurredAt: Date;
}

/** Pre-transition states from which an approval on THIS call is a new fact. */
export function aprovacaoEhNova(statusAntes: Pagamento['status'] | undefined): boolean {
  return statusAntes === 'pendente' || statusAntes === 'processing';
}

export function pagamentoAprovadoProps(
  pagamento: Pagamento,
  provedor: 'stripe' | 'inter',
  caminho: CaminhoAprovacao,
  idContaDono: string,
): Record<string, unknown> {
  const agg = pagamento.intencao.composicaoValoresAggregate;
  return {
    id_pagamento: pagamento.id,
    id_campanha: pagamento.intencao.idCampanha,
    id_conta_dono: idContaDono,
    metodo: pagamento.intencao.metodo,
    provedor,
    caminho,
    valor_centavos: agg.totalPaidCents,
    valor_recebedor_centavos: agg.totalReceiverCents,
    // Units, not lines: a contribuição line carries `quantidade` (may be > 1),
    // matching the client contract's totalUnits (Vance #108).
    quantidade_itens: pagamento.intencao.items.reduce(
      (total, it) => (it.tipo === 'contribuicao' ? total + it.quantidade : total),
      0,
    ),
  };
}

export async function trackPagamentoAprovado(
  deps: TrackPagamentoAprovadoDeps,
  input: TrackPagamentoAprovadoInput,
): Promise<void> {
  if (!deps.serverAnalytics) return;
  try {
    // distinct_id = the campaign owner's conta (the payer has no account; the
    // client-side compra_concluida lands on the payer's anonymous device id).
    // idsAdministradores[0] is the primary admin — positional, documented.
    // No owner resolved → the sink drops the event explicitly (never a
    // campaign-as-person substitute).
    const campanha = await deps.campanhaRepository.findById(input.pagamento.intencao.idCampanha);
    const idContaDono = campanha?.idsAdministradores[0] ?? null;
    deps.serverAnalytics.track(
      'pagamento_aprovado',
      idContaDono,
      pagamentoAprovadoProps(input.pagamento, input.provedor, input.caminho, idContaDono ?? ''),
      { insertKey: input.pagamento.id, occurredAt: input.occurredAt },
    );
  } catch {
    // analytics must never throw into a webhook / job path.
  }
}
