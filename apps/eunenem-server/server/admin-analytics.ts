import { sql } from 'kysely';
import type { Database } from '../../../src/adapters/database.js';
import { addDays, addMonthsToMonthStart, localDateInSaoPaulo, startOfIsoWeek, startOfMonth } from '../pages/lib/receitaPeriodo.js';

export type AnalyticsMonths = 3 | 6 | 12;
export interface AnalyticsBucket { de: string; ate: string; parcial: boolean }
export const FUNIL_ETAPAS = ['cadastro', 'onboarding', 'lista_criada', 'primeiro_presente'] as const;
export type FunilEtapa = typeof FUNIL_ETAPAS[number];
export type FunilContagens = Record<FunilEtapa, number>;
export const FUNIL_ORIGENS = ['google_ads', 'organico', 'direto', 'outros', 'desconhecida'] as const;
export type FunilOrigem = typeof FUNIL_ORIGENS[number];
export interface VendasMetricas {
  gmvCents: number; presentes: number; ticketMedioCents: number | null;
  pixCents: number; cartaoCents: number; pixQtd: number; cartaoQtd: number;
  pixGerados: number; pixPagos: number; pixExpirados: number;
}

export function analyticsPeriod(now: Date, months: AnalyticsMonths) {
  const hoje = localDateInSaoPaulo(now);
  const mes = startOfMonth(hoje);
  const de = addMonthsToMonthStart(mes, 1 - months);
  const ate = addDays(hoje, 1);
  const meses = Array.from({ length: months }, (_, i) => {
    const inicio = addMonthsToMonthStart(de, i);
    return { de: inicio, ate: addMonthsToMonthStart(inicio, 1), parcial: inicio === mes };
  });
  const semanas: AnalyticsBucket[] = [];
  for (let inicio = startOfIsoWeek(de); inicio < ate; inicio = addDays(inicio, 7)) {
    const fim = addDays(inicio, 7);
    semanas.push({ de: inicio, ate: fim, parcial: inicio < de || fim > hoje });
  }
  return { hoje, snapshotAt: now.toISOString(), periodo: { de, ate }, meses, semanas };
}

const zeroFunil = (): FunilContagens => ({ cadastro: 0, onboarding: 0, lista_criada: 0, primeiro_presente: 0 });
interface FunilDia extends FunilContagens { dia: string; origem: FunilOrigem }
/** Acquisition cohorts, milestone reached by snapshot, not event counts or a strict ordered funnel.
 * Lists are auto-created at signup; there is no separate publication state. Administrator
 * relationships are current (no ownership history). QA exclusion matches admin.estatisticas.
 */
export async function loadAnalyticsFunil(db: Database, platformId: string, now: Date, months: AnalyticsMonths) {
  const period = analyticsPeriod(now, months);
  const { rows } = await sql<FunilDia>`WITH cohort AS (
    SELECT u.* FROM usuarios u
    WHERE u.id_plataforma = ${platformId}::uuid AND u.desativado_em IS NULL
      AND u.criado_em >= (${period.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND u.criado_em < ${now}
      AND NOT (lower(trim(u.email)) = 'franciscomateusvg@gmail.com'
        OR lower(trim(u.email)) LIKE 'franciscomateusvg+%@%' OR lower(u.email) LIKE '%aperture%'
        OR lower(u.email) ~ ${'@(example\\.(com|org|net)|.*\\.test|.*\\.local)$'}
        OR lower(u.nome_exibicao) ~ '(aperture|fixture|sint.tic)')
  ), milestones AS (
    SELECT u.*, EXISTS (SELECT 1 FROM campanha_administradores a JOIN campanhas c ON c.id = a.campanha_id
      WHERE a.id_usuario = u.id_conta AND c.id_plataforma = ${platformId}::uuid AND c.criada_em < ${now}) AS lista,
      EXISTS (SELECT 1 FROM campanha_administradores a JOIN campanhas c ON c.id = a.campanha_id
        JOIN pagamentos p ON p.intencao_id_campanha = c.id
        JOIN lancamentos_financeiros l ON l.id_pagamento = p.id AND l.tipo = 'credito_receita_plataforma'
        WHERE a.id_usuario = u.id_conta AND c.id_plataforma = ${platformId}::uuid AND l.criado_em < ${now}) AS presente
    FROM cohort u
  ) SELECT to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
    CASE WHEN signup_gclid IS NOT NULL OR signup_gbraid IS NOT NULL OR signup_wbraid IS NOT NULL
          OR (lower(signup_utm_source) IN ('google', 'googleads', 'google_ads') AND lower(signup_utm_medium) IN ('cpc','ppc','paid','paid_search')) THEN 'google_ads'
      WHEN signup_captured_at IS NULL THEN 'desconhecida'
      WHEN lower(signup_utm_medium) IN ('organic','organico','organic_search')
        OR (signup_utm_source IS NULL AND signup_referrer ~* '^https?://([^/]+\\.)?(google\\.[^/]+|bing\\.com|search\\.yahoo\\.com|duckduckgo\\.com)(/|$)') THEN 'organico'
      WHEN signup_utm_source IS NULL AND signup_utm_medium IS NULL AND signup_referrer IS NULL THEN 'direto'
      ELSE 'outros' END AS origem,
    count(*)::int AS cadastro,
    (count(*) FILTER (WHERE onboarding_concluido_em < ${now}))::int AS onboarding,
    (count(*) FILTER (WHERE lista))::int AS lista_criada,
    (count(*) FILTER (WHERE presente))::int AS primeiro_presente
    FROM milestones GROUP BY 1, 2 ORDER BY 1, 2`.execute(db);
  const sum = (items: readonly FunilDia[]) => items.reduce((total, row) => {
    for (const etapa of FUNIL_ETAPAS) total[etapa] += row[etapa];
    return total;
  }, zeroFunil());
  const bucket = (b: AnalyticsBucket) => ({ ...b, contagens: sum(rows.filter(r => r.dia >= b.de && r.dia < b.ate)) });
  return { ...period, etapas: FUNIL_ETAPAS, totais: sum(rows), meses: period.meses.map(bucket), semanas: period.semanas.map(bucket),
    porOrigem: FUNIL_ORIGENS.map(origem => ({ origem, contagens: sum(rows.filter(r => r.origem === origem)) })) };
}

interface VendasDia extends Omit<VendasMetricas, 'ticketMedioCents'> { dia: string }
const zeroVendas = (): VendasMetricas => ({ gmvCents: 0, presentes: 0, ticketMedioCents: null, pixCents: 0, cartaoCents: 0, pixQtd: 0, cartaoQtd: 0, pixGerados: 0, pixPagos: 0, pixExpirados: 0 });
/** Gross contribution value (fees excluded), approval evidenced by ledger, including later refunds.
 * Gifts = item quantities, ticket = GMV / gift quantity. PIX generated/paid/expired are creation
 * cohorts as of snapshot; pending overdue charges are expired. Sales series use approval date.
 */
export async function loadAnalyticsVendas(db: Database, platformId: string, now: Date, months: AnalyticsMonths) {
  const period = analyticsPeriod(now, months);
  const { rows } = await sql<VendasDia>`WITH paid AS (
    SELECT p.id, p.intencao_metodo AS method, p.intencao_total_contribution_cents AS gmv,
      min(l.criado_em) AS approved_at
    FROM pagamentos p JOIN campanhas c ON c.id = p.intencao_id_campanha
      JOIN lancamentos_financeiros l ON l.id_pagamento = p.id AND l.tipo = 'credito_receita_plataforma'
    WHERE c.id_plataforma = ${platformId}::uuid AND l.criado_em < ${now}
    GROUP BY p.id
  ), sales AS (
    SELECT to_char(p.approved_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
      sum(p.gmv) AS gmv, sum(coalesce(i.quantity, 0)) AS gifts,
      coalesce(sum(p.gmv) FILTER (WHERE p.method = 'pix'),0) AS pix,
      coalesce(sum(p.gmv) FILTER (WHERE p.method = 'credit_card'),0) AS card,
      count(*) FILTER (WHERE p.method = 'pix') AS pix_count,
      count(*) FILTER (WHERE p.method = 'credit_card') AS card_count,
      0::bigint AS generated, 0::bigint AS paid, 0::bigint AS expired
    FROM paid p LEFT JOIN LATERAL (
      SELECT sum(quantidade) AS quantity FROM intencao_items WHERE id_pagamento = p.id AND tipo = 'contribuicao'
    ) i ON true
    WHERE p.approved_at >= (${period.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
    GROUP BY 1
  ), pix_cohorts AS (
    SELECT to_char(p.intencao_criada_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
      0::bigint AS gmv, 0::bigint AS gifts, 0::bigint AS pix, 0::bigint AS card,
      0::bigint AS pix_count, 0::bigint AS card_count, count(*) AS generated,
      count(*) FILTER (WHERE a.id IS NOT NULL) AS paid,
      count(*) FILTER (WHERE a.id IS NULL AND p.intencao_expira_em <= ${now}) AS expired
    FROM pagamentos p JOIN campanhas c ON c.id = p.intencao_id_campanha LEFT JOIN paid a ON a.id = p.id
    WHERE c.id_plataforma = ${platformId}::uuid AND p.intencao_metodo = 'pix' AND p.intencao_external_ref IS NOT NULL
      AND p.intencao_criada_em >= (${period.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND p.intencao_criada_em < ${now}
    GROUP BY 1
  ) SELECT dia, sum(gmv)::float8 AS "gmvCents", sum(gifts)::float8 AS presentes,
    sum(pix)::float8 AS "pixCents", sum(card)::float8 AS "cartaoCents", sum(pix_count)::int AS "pixQtd",
    sum(card_count)::int AS "cartaoQtd", sum(generated)::int AS "pixGerados", sum(paid)::int AS "pixPagos", sum(expired)::int AS "pixExpirados"
    FROM (SELECT * FROM sales UNION ALL SELECT * FROM pix_cohorts) d GROUP BY dia ORDER BY dia`.execute(db);
  const sum = (items: readonly VendasDia[]) => {
    const total = zeroVendas();
    for (const row of items) {
      for (const key of Object.keys(total) as (keyof VendasMetricas)[]) {
        if (key !== 'ticketMedioCents') total[key] += row[key];
      }
    }
    total.ticketMedioCents = total.presentes ? Math.round(total.gmvCents / total.presentes) : null;
    return total;
  };
  const bucket = (b: AnalyticsBucket) => ({ ...b, ...sum(rows.filter(r => r.dia >= b.de && r.dia < b.ate)) });
  return { ...period, totais: sum(rows), meses: period.meses.map(bucket), semanas: period.semanas.map(bucket) };
}
