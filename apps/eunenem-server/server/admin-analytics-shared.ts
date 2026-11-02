import { sql } from 'kysely';
import { LEGACY_USERS_SEED } from '../lib/legacy-users.js';

export interface AnalyticsCoverage { nota: string; parcial: boolean; denominador: number; observados: number }
export function coverage(nota: string, denominador: number, observados: number, parcial = false): AnalyticsCoverage {
  return { nota, parcial: parcial || observados < denominador, denominador, observados };
}
export function percentage(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round(numerator / denominator * 10_000) / 100 : null;
}
export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * fraction;
  const lo = Math.floor(position); const hi = Math.ceil(position);
  return Math.round(((sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (position - lo)) * 100) / 100;
}
export interface LegacyAnalyticsScope { emails: readonly string[]; completo: boolean }
export function defaultLegacyScope(): LegacyAnalyticsScope {
  return { emails: [...new Set(LEGACY_USERS_SEED.map(e => e.email.trim().toLowerCase()))], completo: Boolean(process.env.LEGACY_USERS_PATH?.trim()) };
}
/** SQL CTE definition, reusable across analytics. Lists without a current eligible owner
 * are excluded rather than silently treating them as new/non-QA. Current ownership and
 * current event date are observations, not historical snapshots. No identity leaves SQL.
 */
export function analyticsCampaigns(platformId: string, now: Date, legacy = defaultLegacyScope()) {
  return sql`analytics_users AS (
    SELECT u.*, CASE
      WHEN signup_gclid IS NOT NULL OR signup_gbraid IS NOT NULL OR signup_wbraid IS NOT NULL
        OR (lower(signup_utm_source) IN ('google','googleads','google_ads') AND lower(signup_utm_medium) IN ('cpc','ppc','paid','paid_search')) THEN 'google_ads'
      WHEN signup_captured_at IS NULL THEN 'desconhecida'
      WHEN lower(signup_utm_medium) IN ('organic','organico','organic_search') OR (signup_utm_source IS NULL AND signup_referrer ~* '^https?://([^/]+\\.)?(google\\.[^/]+|bing\\.com|search\\.yahoo\\.com|duckduckgo\\.com)(/|$)') THEN 'organico'
      WHEN signup_utm_source IS NULL AND signup_utm_medium IS NULL AND signup_referrer IS NULL THEN 'direto'
      ELSE 'outros' END AS origem
    FROM usuarios u WHERE u.id_plataforma = ${platformId}::uuid AND u.desativado_em IS NULL AND u.criado_em < ${now}
      AND NOT (lower(trim(u.email))='franciscomateusvg@gmail.com' OR lower(trim(u.email)) LIKE 'franciscomateusvg+%@%'
        OR lower(u.email) LIKE '%aperture%' OR lower(u.email) ~ ${'@(example\\.(com|org|net)|.*\\.test|.*\\.local)$'}
        OR lower(u.nome_exibicao) ~ '(aperture|fixture|sint.tic)')
  ), analytics_campaigns AS (
    SELECT c.id, c.criada_em, owner.origem,
      CASE WHEN EXISTS (SELECT 1 FROM campanha_administradores a JOIN analytics_users u ON u.id_conta=a.id_usuario
        WHERE a.campanha_id=c.id AND lower(trim(u.email))=ANY(${legacy.emails}::text[])) THEN 'sim'
        WHEN ${legacy.completo} THEN 'nao' ELSE 'desconhecido' END AS legado,
      (SELECT min(e.data_hora) FROM eventos e WHERE e.id_campanha=c.id) AS data_evento
    FROM campanhas c JOIN LATERAL (
      SELECT u.origem FROM campanha_administradores a JOIN analytics_users u ON u.id_conta=a.id_usuario
      WHERE a.campanha_id=c.id ORDER BY u.criado_em, u.id LIMIT 1
    ) owner ON true
    WHERE c.id_plataforma=${platformId}::uuid AND c.criada_em < ${now}
  )`;
}
/** One row/payment. Gross sales and original approval survive refunds. Costs are only
 * matched BRL observations; absence is unknown, never zero-cost confirmation.
 */
export function analyticsPayments(now: Date, campaigns: 'analytics_campaigns' | 'selected' = 'analytics_campaigns') {
  return sql`analytics_payments AS (
    SELECT p.id, p.intencao_id_campanha AS campaign_id, p.intencao_metodo AS metodo,
      nullif(lower(trim(p.intencao_contribuinte_email)), '') AS payer,
      p.intencao_total_contribution_cents::float8 AS gmv,
      l.approved_at, l.fees, l.reversals,
      coalesce(f.cost,0)::float8 AS cost, coalesce(f.observations,0)::int AS cost_observations
    FROM pagamentos p JOIN ${sql.table(campaigns)} c ON c.id=p.intencao_id_campanha
    JOIN LATERAL (SELECT min(criado_em) AS approved_at, sum(amount_cents)::float8 AS fees,
      coalesce(sum(amount_cents) FILTER(WHERE cancelado_em < ${now}),0)::float8 AS reversals
      FROM lancamentos_financeiros WHERE id_pagamento=p.id AND tipo='credito_receita_plataforma' AND criado_em < ${now}
    ) l ON l.approved_at IS NOT NULL
    LEFT JOIN LATERAL (SELECT sum(amount_cents) AS cost, count(*) AS observations FROM provider_fee_events
      WHERE payment_id=p.id AND currency='brl' AND occurred_at < ${now} AND observed_at < ${now}) f ON true
  )`;
}
