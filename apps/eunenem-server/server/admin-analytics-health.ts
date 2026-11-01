import { sql } from 'kysely';
import type { Database } from '../../../src/adapters/database.js';
import { analyticsPeriod, type AnalyticsBucket, type AnalyticsMonths } from './admin-analytics.js';

export const SAUDE_CATEGORIAS = ['provedor', 'webhook', 'checkout', 'email'] as const;
export type SaudeCategoria = typeof SAUDE_CATEGORIAS[number];
export type SaudeContagens = Record<SaudeCategoria, number>;
export interface SaudeRecente {
  id: string; em: string; categoria: SaudeCategoria; provedor: 'inter' | 'stripe' | null;
  operacao: string | null; mensagem: string;
  referencia: { tipo: 'pagamento' | 'webhook' | 'email' | 'repasse' | null; id: string | null };
}
interface HealthDay { dia: string; categoria: SaudeCategoria; quantidade: number }
/** Defense in depth for diagnostic text; raw provider bodies are redacted at persistence.
 * Never serialize request snapshots, webhook payloads, signature headers or environment values.
 */
export function safeAdminDiagnostic(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+\b/g, '[redacted]')
    .replace(/((?:authorization|client_secret|access_token|refresh_token|password)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .slice(0, 16_384);
}
/** Provider attempts are historical; the other categories are currently unresolved rows.
 * Webhook date = last processing start (fallback received); email date = last claim
 * (fallback event date), because these tables do not retain a failure timestamp/history.
 */
export async function loadAnalyticsSaude(db: Database, platformId: string, now: Date, months: AnalyticsMonths) {
  const period = analyticsPeriod(now, months);
  const { rows } = await sql<{ dias: HealthDay[]; recentes: SaudeRecente[] }>`WITH events AS (
    SELECT 'provider-checkout:' || f.id::text AS id, f.recorded_at AS em, 'provedor' AS categoria,
      o.provider AS provedor, 'checkout:' || o.method AS operacao,
      left(coalesce(f.diagnostic, f.outcome, 'Falha do provedor'), 16384) AS mensagem,
      'pagamento' AS ref_tipo, o.payment_id::text AS ref_id
    FROM payment_provider_operation_attempt_facts f JOIN payment_provider_operations o ON o.operation_id = f.operation_id
    WHERE o.platform_id = ${platformId}::uuid AND f.fact_kind = 'result' AND f.outcome IN ('failed', 'outcome_unknown')
    UNION ALL
    SELECT 'provider-payout:' || a.id::text, coalesce(a.finished_at, a.started_at), 'provedor', 'inter',
      a.operation, left(coalesce(a.provider_error_body_private, a.error, a.diagnostic_reason, a.outcome, 'Falha do repasse'), 16384),
      'repasse', a.repasse_id::text
    FROM repasse_transfer_attempts a JOIN repasses_recebedor r ON r.id = a.repasse_id JOIN campanhas c ON c.id = r.id_campanha
    WHERE c.id_plataforma = ${platformId}::uuid AND (a.error IS NOT NULL OR a.provider_error_body_private IS NOT NULL
      OR a.outcome IN ('falhou','transitorio','rejeitado'))
    UNION ALL
    SELECT 'webhook:' || w.id::text, coalesce(w.processing_started_at, w.received_at), 'webhook',
      w.provider, w.event_type, left(w.processing_error, 16384), 'webhook', w.id::text
    FROM payment_webhook_events w LEFT JOIN pagamentos p ON p.id = w.pagamento_id LEFT JOIN campanhas c ON c.id = p.intencao_id_campanha
    WHERE w.processing_error IS NOT NULL AND w.processed_at IS NULL
      AND (w.ingress_platform_id = ${platformId}::uuid OR (w.ingress_platform_id IS NULL AND c.id_plataforma = ${platformId}::uuid))
    UNION ALL
    SELECT 'checkout:' || o.operation_id::text, o.updated_at, 'checkout', o.provider, o.method,
      'Estado do checkout: ' || o.state, 'pagamento', o.payment_id::text
    FROM payment_provider_operations o WHERE o.platform_id = ${platformId}::uuid AND o.state IN ('failed','outcome_unknown')
    UNION ALL
    SELECT 'email:' || d.id, coalesce(d.claimed_at, e.occurred_at), 'email', NULL, d.type,
      d.state || ': ' || coalesce(d.reason, 'Falha sem diagnóstico'), 'email', d.id::text
    FROM lifecycle_email_deliveries d JOIN lifecycle_email_events e ON e.id = d.event_id
    WHERE d.tenant_id = ${platformId} AND e.tenant_id = ${platformId} AND d.state IN ('failed','unknown')
  ), scoped AS (
    SELECT * FROM events WHERE em >= (${period.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND em < ${now}
  ), daily AS (
    SELECT to_char(em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia, categoria, count(*)::int AS quantidade
    FROM scoped GROUP BY 1, 2
  ), recent AS (
    SELECT id, to_char(em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS em, categoria,
      CASE WHEN provedor IN ('inter','stripe') THEN provedor ELSE NULL END AS provedor,
      operacao, mensagem, json_build_object('tipo', ref_tipo, 'id', ref_id) AS referencia
    FROM scoped ORDER BY em DESC, id DESC LIMIT 50
  ) SELECT coalesce((SELECT json_agg(daily ORDER BY dia, categoria) FROM daily), '[]'::json) AS dias,
    coalesce((SELECT json_agg(recent ORDER BY em DESC, id DESC) FROM recent), '[]'::json) AS recentes`.execute(db);
  const data = rows[0] ?? { dias: [], recentes: [] };
  const sum = (days: HealthDay[]): SaudeContagens => days.reduce((total, row) => {
    total[row.categoria] += row.quantidade; return total;
  }, { provedor: 0, webhook: 0, checkout: 0, email: 0 });
  const bucket = (b: AnalyticsBucket) => ({ ...b, contagens: sum(data.dias.filter(d => d.dia >= b.de && d.dia < b.ate)) });
  return { ...period, categorias: SAUDE_CATEGORIAS, totais: sum(data.dias),
    meses: period.meses.map(bucket), semanas: period.semanas.map(bucket),
    recentes: data.recentes.map(row => ({ ...row, mensagem: safeAdminDiagnostic(row.mensagem) })) };
}
