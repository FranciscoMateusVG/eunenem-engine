import { sql } from 'kysely';
import type { Database } from '../../../src/adapters/database.js';
import { analyticsPeriod, type AnalyticsMonths } from './admin-analytics.js';
import { analyticsCampaigns, analyticsPayments, coverage, percentage } from './admin-analytics-shared.js';

export async function loadAnalyticsCheckout(db: Database, platform: string, now: Date, months: AnalyticsMonths) {
  const period = analyticsPeriod(now, months);
  const { rows } = await sql<{ estado: string; quantidade: number; errors: number; recovered: number }>`WITH
    ${analyticsCampaigns(platform, now)}, operations AS (
      SELECT o.state AS estado, failure.at AS error_at,
        EXISTS(SELECT 1 FROM payment_provider_operation_attempt_facts success
          WHERE success.operation_id=o.operation_id AND success.fact_kind='result'
            AND success.outcome='provider_succeeded' AND success.recorded_at>failure.at AND success.recorded_at<${now})
        OR (o.provider_succeeded_at>failure.at AND o.provider_succeeded_at<${now})
        OR (o.local_committed_at>failure.at AND o.local_committed_at<${now}) AS recovered
      FROM payment_provider_operations o JOIN analytics_campaigns c ON c.id=o.campaign_id
      LEFT JOIN LATERAL (SELECT min(f.recorded_at) AS at FROM payment_provider_operation_attempt_facts f
        WHERE f.operation_id=o.operation_id AND f.fact_kind='result' AND f.outcome IN ('failed','outcome_unknown') AND f.recorded_at<${now}) failure ON true
      WHERE o.platform_id=${platform}::uuid AND o.created_at>=(${period.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND o.created_at<${now}
    ) SELECT estado,count(*)::int AS quantidade,(count(*) FILTER(WHERE error_at IS NOT NULL))::int AS errors,
      (count(*) FILTER(WHERE error_at IS NOT NULL AND recovered))::int AS recovered FROM operations GROUP BY estado ORDER BY estado`.execute(db);
  const operacoes=rows.reduce((sum,r)=>sum+r.quantidade,0);
  const comErro=rows.reduce((sum,r)=>sum+r.errors,0);
  const recuperadasAposErro=rows.reduce((sum,r)=>sum+r.recovered,0);
  return {operacoes,estados:rows.map(r=>({estado:r.estado,quantidade:r.quantidade})),comErro,recuperadasAposErro,
    percentualRecuperadas:percentage(recuperadasAposErro,comErro),comprasLogicas:null,trocasPixCartao:null,
    cobertura:coverage('Operações reservadas no período, estado atual. Recuperação = sucesso do provedor após falha/resultado desconhecido na mesma operação; não significa pagamento aprovado. Tentativas não são clientes; pré-reserva, compras entre IDs e troca PIX→cartão não são medidos.',operacoes,operacoes,true)};
}

export async function loadAnalyticsPriceBands(db: Database, platform: string, now: Date, months: AnalyticsMonths) {
  const period=analyticsPeriod(now,months);
  const {rows}=await sql<{band:number; available:number; bought:number; gmv:number}>`WITH
    ${analyticsCampaigns(platform,now)}, ${analyticsPayments(now)}, observations AS (
      SELECT g.valor AS price, greatest(g.quantidade-coalesce((SELECT sum(i.quantidade) FROM intencao_items i
        JOIN pagamentos p ON p.id=i.id_pagamento WHERE i.id_contribuicao=g.id AND i.tipo='contribuicao' AND p.status='aprovado'),0),0)::float8 AS available,
        0::float8 AS bought,0::float8 AS gmv
      FROM contribuicoes g JOIN analytics_campaigns c ON c.id=g.campanha_id WHERE g.arquivada_em IS NULL AND g.criada_em<${now}
      UNION ALL
      SELECT i.contribution_unit_amount_cents,0,i.quantidade,i.line_contribution_amount_cents
      FROM intencao_items i JOIN analytics_payments p ON p.id=i.id_pagamento
      WHERE i.tipo='contribuicao' AND p.approved_at>=(${period.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
    ) SELECT CASE WHEN price IS NULL THEN -1 WHEN price<5000 THEN 0 WHEN price<10000 THEN 1 WHEN price<20000 THEN 2 WHEN price<50000 THEN 3 ELSE 4 END AS band,
      sum(available)::float8 AS available,sum(bought)::float8 AS bought,coalesce(sum(gmv),0)::float8 AS gmv
      FROM observations GROUP BY 1`.execute(db);
  const bounds=[0,5000,10000,20000,50000];
  const faixas=bounds.map((deCents,index)=>{const r=rows.find(r=>r.band===index);return {deCents,ateCents:bounds[index+1]??null,disponiveis:r?.available??0,comprados:r?.bought??0,gmvCents:r?.gmv??0};});
  return {faixas,cobertura:coverage('Disponíveis = cotas restantes do catálogo atual não arquivado (todas as listas elegíveis); comprados = itens com primeira aprovação no período, inclusive estornos posteriores. Faixa comprada usa preço registrado, não catálogo editado. Itens sem preço registrado não entram nas faixas. Sem histórico de catálogo, exposição/cliques ou percentual de conclusão; cotas podem ser repostas.',rows.reduce((s,r)=>s+r.bought,0),faixas.reduce((s,r)=>s+r.comprados,0),true)};
}

export async function loadAnalyticsEmailCoverage(db: Database, platform: string, now: Date, months: AnalyticsMonths) {
  const period=analyticsPeriod(now,months);
  const {rows}=await sql<{tipo:string;eventosRegistrados:number;eventosComDestinatario:number;pendentes:number;enviando:number;enviados:number;falhos:number;desconhecidos:number;suprimidos:number}>`WITH
    ${analyticsCampaigns(platform,now)}, events AS (
      SELECT e.id,e.type FROM lifecycle_email_events e
      WHERE e.tenant_id=${platform}::uuid AND e.occurred_at>=(${period.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND e.occurred_at<${now} AND e.created_at<${now}
        AND (EXISTS(SELECT 1 FROM analytics_campaigns c WHERE c.id=e.campaign_id)
          OR (e.campaign_id IS NULL AND EXISTS(SELECT 1 FROM analytics_users u WHERE u.id=e.subject_id)))
    ), deliveries AS (
      SELECT d.* FROM lifecycle_email_deliveries d JOIN analytics_users u ON u.id=d.user_id WHERE d.tenant_id=${platform}::uuid
    ) SELECT e.type AS tipo,count(DISTINCT e.id)::int AS "eventosRegistrados",
      (count(DISTINCT e.id) FILTER(WHERE d.id IS NOT NULL))::int AS "eventosComDestinatario",
      (count(d.id) FILTER(WHERE d.state='pending'))::int AS pendentes,
      (count(d.id) FILTER(WHERE d.state='sending'))::int AS enviando,
      (count(d.id) FILTER(WHERE d.state='sent'))::int AS enviados,
      (count(d.id) FILTER(WHERE d.state='failed'))::int AS falhos,
      (count(d.id) FILTER(WHERE d.state='unknown'))::int AS desconhecidos,
      (count(d.id) FILTER(WHERE d.state='suppressed'))::int AS suprimidos
      FROM events e LEFT JOIN deliveries d ON d.event_id=e.id GROUP BY e.type ORDER BY e.type`.execute(db);
  const events=rows.reduce((s,r)=>s+r.eventosRegistrados,0), observed=rows.reduce((s,r)=>s+r.eventosComDestinatario,0);
  return {tipos:rows,cobertura:coverage('Coorte de eventos registrados no período; estados atuais dos destinatários elegíveis observados (um evento pode ter vários). Não mede toda a população elegível: eventos podem nem ser criados sem destinatário apto. Enviado não é entregue; entrega/clique e efeito causal não são medidos.',events,observed,true)};
}
