import { sql } from 'kysely';
import type { Database } from '../../../src/adapters/database.js';
import { analyticsPeriod, type AnalyticsMonths } from './admin-analytics.js';
import { analyticsCampaigns, analyticsPayments, coverage, percentile } from './admin-analytics-shared.js';

interface MarginRow { fees: number; reversals: number; cost: number; payments: number; costPayments: number }
interface PayoutRow { estado: string; valor: number; age: number; requestedHours: number | null; approvedHours: number | null; confirmed: boolean }
interface Exposure {
  medBloqueadoCents: number; medLiberadoCents: number; medDevolvidoCents: number;
  estornosStripeConfirmadosCents: number; devolucoesPixConfirmadasCents: number;
  jaRepassadoEmPagamentosContestadosCents: number; casos: number;
}
export async function loadAnalyticsFinanceiro(db: Database, platformId: string, now: Date, months: AnalyticsMonths) {
  const period=analyticsPeriod(now,months);
  const start=sql`(${period.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
  const {rows}=await sql<{margins:MarginRow[];payouts:PayoutRow[];exposure:Exposure}>`WITH
    ${analyticsCampaigns(platformId,now)}, ${analyticsPayments(now)},
    margins AS (
      SELECT campaign_id, sum(fees)::float8 AS fees, sum(reversals)::float8 AS reversals, sum(cost)::float8 AS cost,
        count(*)::int AS payments, (count(*) FILTER(WHERE cost_observations>0))::int AS "costPayments"
      FROM analytics_payments WHERE approved_at>=${start} GROUP BY campaign_id
    ), payouts AS (
      SELECT r.status AS estado, r.amount_cents::float8 AS valor,
        extract(epoch FROM (${now}::timestamptz-r.solicitado_em))/86400 AS age,
        CASE WHEN paid.at>=r.solicitado_em THEN extract(epoch FROM (paid.at-r.solicitado_em))/3600 END AS "requestedHours",
        CASE WHEN paid.at>=r.aprovado_em THEN extract(epoch FROM (paid.at-r.aprovado_em))/3600 END AS "approvedHours",
        r.status='pago' AS confirmed
      FROM repasses_recebedor r JOIN analytics_campaigns c ON c.id=r.id_campanha
      LEFT JOIN LATERAL (
        SELECT coalesce(
          (SELECT max(l.transferido_em) FROM lancamentos_financeiros l WHERE l.id_repasse=r.id AND l.transferido_em<${now}),
          (SELECT max(a.finished_at) FROM repasse_transfer_attempts a WHERE a.repasse_id=r.id AND a.outcome='pago' AND a.finished_at<${now})
        ) AS at
      ) paid ON true
      WHERE r.solicitado_em>=${start} AND r.solicitado_em<${now}
    ), contested AS (
      SELECT m.*, coalesce((SELECT sum(l.amount_cents) FROM lancamentos_financeiros l
        WHERE l.id_pagamento=m.id_pagamento AND l.tipo='credito_saldo_recebedor' AND l.transferido_em<${now}),0)::float8 AS transferred
      FROM pix_contestacoes m JOIN pagamentos p ON p.id=m.id_pagamento JOIN analytics_campaigns c ON c.id=p.intencao_id_campanha
      WHERE m.ocorrida_em>=${start} AND m.ocorrida_em<${now}
    ), stripe AS (
      SELECT coalesce(sum(r.amount_cents),0)::float8 AS refunded, count(*)::int AS cases
      FROM stripe_refund_operations r JOIN pagamentos p ON p.id=r.payment_id JOIN analytics_campaigns c ON c.id=p.intencao_id_campanha
      WHERE r.created_at>=${start} AND r.created_at<${now} AND r.state IN ('provider_succeeded','local_committed') AND r.provider_status='succeeded'
    ), pix AS (
      SELECT coalesce(sum(r.amount_cents),0)::float8 AS refunded,count(*)::int AS cases
      FROM pix_cobranca_devolucoes r JOIN pagamentos p ON p.id=r.id_pagamento JOIN analytics_campaigns c ON c.id=p.intencao_id_campanha
      WHERE r.criado_em>=${start} AND r.criado_em<${now} AND r.status='devolvida'
    ) SELECT coalesce((SELECT json_agg(margins) FROM margins),'[]'::json) AS margins,
      coalesce((SELECT json_agg(payouts) FROM payouts),'[]'::json) AS payouts,
      (SELECT json_build_object(
        'medBloqueadoCents',coalesce(sum(valor_cents) FILTER(WHERE estado='bloqueada'),0),
        'medLiberadoCents',coalesce(sum(valor_cents) FILTER(WHERE estado='liberada'),0),
        'medDevolvidoCents',coalesce(sum(valor_cents) FILTER(WHERE estado='devolvida'),0),
        'jaRepassadoEmPagamentosContestadosCents',coalesce(sum(transferred),0),
        'estornosStripeConfirmadosCents',(SELECT refunded FROM stripe),'devolucoesPixConfirmadasCents',(SELECT refunded FROM pix),
        'casos',count(*)+(SELECT cases FROM stripe)+(SELECT cases FROM pix)
      ) FROM contested) AS exposure`.execute(db);
  const result=rows[0];
  if(!result) throw new Error('analytics_finance_snapshot_missing');
  const sum=(key:keyof MarginRow)=>result.margins.reduce((n,r)=>n+r[key],0);
  const margins=result.margins.map(r=>r.fees-r.reversals-r.cost);
  const centsPercentile=(p:number)=>{const value=percentile(margins,p);return value===null?null:Math.round(value);};
  const requested=result.payouts.flatMap(r=>r.requestedHours===null?[]:[r.requestedHours]);
  const approved=result.payouts.flatMap(r=>r.approvedHours===null?[]:[r.approvedHours]);
  const aging=new Map<string,{estado:string;faixa:'0_2d'|'3_7d'|'8_30d'|'mais_30d';quantidade:number;valorCents:number}>();
  for(const payout of result.payouts){
    if(['pago','cancelado'].includes(payout.estado)) continue;
    const faixa=payout.age<3?'0_2d':payout.age<8?'3_7d':payout.age<31?'8_30d':'mais_30d';
    const key=`${payout.estado}:${faixa}`;const row=aging.get(key)??{estado:payout.estado,faixa,quantidade:0,valorCents:0};
    row.quantidade++;row.valorCents+=payout.valor;aging.set(key,row);
  }
  const {casos,...exposure}=result.exposure;
  return {...period,
    margem:{taxasCents:sum('fees'),reversoesCents:sum('reversals'),custosCents:sum('cost'),margemContribuicaoCents:margins.reduce((n,v)=>n+v,0),
      p25Cents:centsPercentile(0.25),p50Cents:centsPercentile(0.5),p90Cents:centsPercentile(0.9),listas:result.margins.length,
      pagamentos:sum('payments'),pagamentosComCusto:sum('costPayments'),
      cobertura:coverage('Coorte de pagamentos aprovados no período; margem atual por lista com venda, sem custos fixos. Reversões/custos conhecidos até agora; ausência de tarifa não é custo zero. Não é lucro líquido nem Receita por data de evento.',sum('payments'),sum('costPayments'),true)},
    repasses:{solicitadoAteTransferido:{p50Horas:percentile(requested,0.5),p95Horas:percentile(requested,0.95),observados:requested.length},
      aprovadoAteTransferido:{p50Horas:percentile(approved,0.5),p95Horas:percentile(approved,0.95),observados:approved.length},
      aging:[...aging.values()].sort((a,b)=>a.estado.localeCompare(b.estado)||a.faixa.localeCompare(b.faixa)),
      confirmadosSemMarco:result.payouts.filter(r=>r.confirmed&&r.requestedHours===null).length,
      cobertura:coverage('Coorte por solicitação. Transferência exige data no ledger ou tentativa confirmada paga; aprovação não é chegada ao banco. Aging só dos repasses não pagos/cancelados; registros manuais podem representar confirmação tardia.',result.payouts.length,requested.length,true)},
    exposicao:{...exposure,recuperadoPelaPlataformaCents:null,
      cobertura:coverage('Somente casos registrados: MED por ocorrência e devoluções por criação, estado atual. Valores podem se sobrepor; não somar. Repassado é o total transferido dos pagamentos contestados, não perda líquida. Devolvido ao pagador não é recuperado pela plataforma; chargebacks e eventos ausentes não são inferidos.',casos,casos,true)},
  };
}
