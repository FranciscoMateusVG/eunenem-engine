import type { MetodoPagamento } from '../../pagamentos/value-objects/metodo-pagamento.js';

/**
 * Regra de maturação (aperture-led0r, plano 0006).
 *
 * Each `LancamentoFinanceiro` carries a persisted `maturaEm: Date` —
 * the moment at which the row may flip from `pendente` to `disponivel`.
 * This module owns the rule that computes `maturaEm` from the pagamento
 * `metodo` + `criadoEm`. Plano 0006 §1-2 codifies the discipline:
 * maturation rule is data on Lancamento (persisted), not derived on
 * read; the maturation job ("eager projection") is a separate use-case
 * that queries `WHERE status='pendente' AND matura_em <= now()` and
 * flips matched rows.
 *
 * Locked decisions (plano 0006):
 *   - Maturation lives in Financeiro BC (not Pagamentos / Checkout)
 *   - Default rules table is a domain constant (this file)
 *   - Calendar days (NOT business days) for v1
 *   - Eager projection (job writes), not lazy (computed on read)
 *   - Per-plataforma overrides deferred to plano 0009
 *
 * Locked decisions (aperture-9erfv epic, override plano 0006 question
 * #4): the SAME rule applies to ALL three lancamento tipos
 * (recebedor + receita_plataforma + passthrough_surcharge) for v1.
 * Plano 0006 had speculated receita_plataforma might be "immediate"; the
 * epic locks it to the same rule because all three flows are governed
 * by the same Stripe payout schedule. Refine via a follow-up bead if
 * real-world mechanics later prove tipos differ.
 */

export interface RegraMaturacao {
  /** Calendar days to add to `criadoEm`. */
  readonly days: number;
  /**
   * Hours to add on top of days. Used by PIX (T+0 in real terms; we
   * keep a 1-hour buffer to absorb provider-side latency between
   * webhook fire and actual Stripe payout availability).
   */
  readonly hours?: number;
}

/**
 * Default rule per `MetodoPagamento`. Values per plano 0006 §market-rules:
 *
 *   - `pix`: T+0 + 1h conservative buffer (real PIX is minutes; the
 *     1h headroom absorbs provider latency without making the receiver
 *     wait artificially long).
 *   - `credit_card`: D+30 standard market rule (Stripe's default cartao
 *     payout schedule in BRL). Some plataformas negotiate D+14 or D+2
 *     anticipation — out of scope for led0r (plano 0006 question #1).
 *
 * Boleto is not supported by `MetodoPagamento` today; if added, the
 * documented standard is ~D+2. Adding the entry here is a one-line
 * change at that time.
 */
export const REGRAS_MATURACAO_PADRAO: Readonly<Record<MetodoPagamento, RegraMaturacao>> = {
  pix: { days: 0, hours: 1 },
  credit_card: { days: 30 },
};

/**
 * Compute the `maturaEm` for a lancamento generated from a pagamento
 * with `metodo` aprovado at `criadoEm`. Pure function — same inputs
 * always produce the same Date.
 *
 * Throws `Error('Maturação não definida para método: <value>')` on
 * unknown metodo. The factory in `lancamento-financeiro.ts` calls this
 * once per pagamento and lets the throw bubble up — better to fail
 * loud at use-case time than silently misbook a lancamento with an
 * "always-matured" maturaEm = criadoEm. Boleto + future methods MUST
 * land an entry in `REGRAS_MATURACAO_PADRAO` before the metodo is
 * accepted into the system.
 */
export function calcularMaturaEm(metodo: MetodoPagamento, criadoEm: Date): Date {
  const regra = REGRAS_MATURACAO_PADRAO[metodo];
  if (!regra) {
    throw new Error(`Maturação não definida para método: ${metodo}`);
  }
  const out = new Date(criadoEm.getTime());
  // Calendar-days addition. setDate handles month/year wraparound +
  // DST (Postgres timestamptz is wall-clock-neutral; we store the
  // resulting Date as an instant). Hours added separately so the
  // PIX 1h buffer composes cleanly.
  out.setUTCDate(out.getUTCDate() + regra.days);
  if (regra.hours !== undefined) {
    out.setUTCHours(out.getUTCHours() + regra.hours);
  }
  return out;
}
