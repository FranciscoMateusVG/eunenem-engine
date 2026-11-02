import { sql } from 'kysely';
import type { Database } from '../../../src/adapters/database.js';
import { analyticsPeriod, type AnalyticsMonths, type FunilOrigem } from './admin-analytics.js';
import { analyticsCampaigns, analyticsPayments, coverage, defaultLegacyScope, type LegacyAnalyticsScope, percentage, percentile } from './admin-analytics-shared.js';

interface Horizon { dias: 7 | 30 | 60; elegivel: boolean; gmv: number; margin: number; payments: number; costPayments: number }
interface ListObservation {
  dia: string; origem: FunilOrigem; legado: 'sim' | 'nao' | 'desconhecido'; age: number;
  firstDays: number | null; lastDays: number | null; eventDays: number | null;
  gmv: number; fees: number; reversals: number; cost: number; payments: number; costPayments: number;
  payers: number; horizons: Horizon[];
}
interface Payers { payments: number; withEmail: number; unique: number; repeat: number }
interface CurveDay { diaRelativo: number; pagamentos: number; gmvCents: number }

export async function loadAnalyticsListas(db: Database, platformId: string, now: Date, months: AnalyticsMonths, legacy: LegacyAnalyticsScope = defaultLegacyScope()) {
  const period = analyticsPeriod(now, months);
  const { rows } = await sql<{ lists: ListObservation[]; payers: Payers; curve: CurveDay[] }>`WITH
    ${analyticsCampaigns(platformId, now, legacy)},
    selected AS (SELECT * FROM analytics_campaigns WHERE criada_em >= (${period.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')),
    ${analyticsPayments(now, 'selected')},
    observations AS (
      SELECT to_char(c.criada_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia, c.origem, c.legado,
        extract(epoch FROM (${now}::timestamptz-c.criada_em))/86400 AS age,
        extract(epoch FROM (p.first_at-c.criada_em))/86400 AS "firstDays",
        extract(epoch FROM (${now}::timestamptz-p.last_at))/86400 AS "lastDays",
        (c.data_evento AT TIME ZONE 'America/Sao_Paulo')::date-(${now}::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date AS "eventDays",
        coalesce(p.gmv,0) AS gmv, coalesce(p.fees,0) AS fees, coalesce(p.reversals,0) AS reversals, coalesce(p.cost,0) AS cost,
        p.payments, p.cost_payments AS "costPayments", p.payers, h.horizons
      FROM selected c
      CROSS JOIN LATERAL (
        SELECT min(approved_at) AS first_at, max(approved_at) AS last_at, sum(gmv) AS gmv, sum(fees) AS fees,
          sum(reversals) AS reversals, sum(cost) AS cost, count(*)::int AS payments,
          (count(*) FILTER(WHERE cost_observations>0))::int AS cost_payments, count(DISTINCT payer)::int AS payers
        FROM analytics_payments WHERE campaign_id=c.id AND approved_at>=c.criada_em
      ) p
      CROSS JOIN LATERAL (
        SELECT json_agg(json_build_object('dias',d.days,'elegivel',c.criada_em+interval '24 hours'*d.days<=${now},
          'gmv',coalesce(x.gmv,0),'margin',coalesce(x.margin,0),'payments',x.payments,'costPayments',x.cost_payments) ORDER BY d.days) AS horizons
        FROM (VALUES (7),(30),(60)) d(days)
        CROSS JOIN LATERAL (
          SELECT sum(a.gmv) AS gmv, sum(coalesce(r.fees,0)-coalesce(r.reversed,0)-coalesce(f.cost,0)) AS margin,
            count(*)::int AS payments, (count(*) FILTER(WHERE f.observations>0))::int AS cost_payments
          FROM analytics_payments a
          LEFT JOIN LATERAL (SELECT sum(amount_cents) AS fees, sum(amount_cents) FILTER(WHERE cancelado_em<c.criada_em+interval '24 hours'*d.days AND cancelado_em<${now}) AS reversed FROM lancamentos_financeiros
            WHERE id_pagamento=a.id AND tipo='credito_receita_plataforma' AND criado_em<c.criada_em+interval '24 hours'*d.days AND criado_em<${now}) r ON true
          LEFT JOIN LATERAL (SELECT sum(amount_cents) AS cost, count(*) AS observations FROM provider_fee_events
            WHERE payment_id=a.id AND currency='brl' AND occurred_at<c.criada_em+interval '24 hours'*d.days AND observed_at<${now}) f ON true
          WHERE a.campaign_id=c.id AND a.approved_at>=c.criada_em AND a.approved_at<c.criada_em+interval '24 hours'*d.days
        ) x
      ) h
    ), payer_counts AS (
      SELECT a.payer,count(*)::int AS n FROM analytics_payments a JOIN selected c ON c.id=a.campaign_id
      WHERE a.approved_at>=c.criada_em GROUP BY a.payer
    ), curve AS (
      SELECT (a.approved_at AT TIME ZONE 'America/Sao_Paulo')::date-(c.data_evento AT TIME ZONE 'America/Sao_Paulo')::date AS "diaRelativo",
        count(*)::int AS pagamentos, sum(a.gmv)::float8 AS "gmvCents"
      FROM analytics_payments a JOIN selected c ON c.id=a.campaign_id WHERE c.data_evento IS NOT NULL AND a.approved_at>=c.criada_em
      GROUP BY 1
    ) SELECT coalesce((SELECT json_agg(observations ORDER BY dia,origem,legado) FROM observations),'[]'::json) AS lists,
      (SELECT json_build_object('payments',coalesce(sum(n),0),'withEmail',coalesce(sum(n) FILTER(WHERE payer IS NOT NULL),0),
        'unique',count(*) FILTER(WHERE payer IS NOT NULL),'repeat',count(*) FILTER(WHERE payer IS NOT NULL AND n>1)) FROM payer_counts) AS payers,
      coalesce((SELECT json_agg(curve ORDER BY "diaRelativo") FROM curve WHERE "diaRelativo" BETWEEN -30 AND 7),'[]'::json) AS curve`.execute(db);
  const result = rows[0] ?? { lists: [], payers: { payments: 0, withEmail: 0, unique: 0, repeat: 0 }, curve: [] };
  const lists = result.lists;
  const first = lists.flatMap(l => l.firstDays !== null && l.firstDays >= 0 ? [l.firstDays] : []);
  const days = [7, 14, 30] as const;
  const cohorts = new Map<string, { de: string; ate: string; parcial: boolean; origem: FunilOrigem; legado: ListObservation['legado']; horizontes: { dias: 7 | 30 | 60; listasElegiveis: number; listasImaturas: number; gmvCents: number; margemCents: number; pagamentos: number; pagamentosComCusto: number }[] }>();
  for (const list of lists) {
    const bucket = period.meses.find(b => list.dia >= b.de && list.dia < b.ate);
    if (!bucket) continue;
    const key = `${bucket.de}:${list.origem}:${list.legado}`;
    const row = cohorts.get(key) ?? { ...bucket, origem: list.origem, legado: list.legado,
      horizontes: ([7, 30, 60] as const).map(dias => ({ dias, listasElegiveis: 0, listasImaturas: 0, gmvCents: 0, margemCents: 0, pagamentos: 0, pagamentosComCusto: 0 })) };
    for (const horizon of list.horizons) {
      const target = row.horizontes.find(h => h.dias === horizon.dias);
      if (!target) continue;
      if (!horizon.elegivel) { target.listasImaturas++; continue; }
      target.listasElegiveis++; target.gmvCents += horizon.gmv; target.margemCents += horizon.margin;
      target.pagamentos += horizon.payments; target.pagamentosComCusto += horizon.costPayments;
    }
    cohorts.set(key, row);
  }
  const withDate = lists.filter(l => l.eventDays !== null);
  const sum = (key: 'gmv' | 'fees' | 'reversals' | 'cost' | 'payments' | 'costPayments') => lists.reduce((n,l) => n+l[key],0);
  const margins = lists.map(l => l.fees-l.reversals-l.cost);
  const gmv = sum('gmv'); const margin = margins.reduce((n,v) => n+v,0);
  const top = (values: number[]) => [...values].sort((a,b) => b-a).slice(0,10).reduce((n,v) => n+v,0);
  const partialCosts = coverage('Margem observada, sem custos fixos. Custo ausente não significa custo zero; reversões e tarifas seguem suas datas. Legado conforme snapshot; origem pelo administrador elegível mais antigo.',sum('payments'),sum('costPayments'),!legacy.completo);
  return { ...period, listas: lists.length,
    primeiroPresente: { medianaDias: percentile(first,0.5), p90Dias: percentile(first,0.9), listasComPresente: first.length, listasSemPresente: lists.length-first.length,
      janelas: days.map(dias => { const eligible=lists.filter(l=>l.age>=dias); const absent=eligible.filter(l=>l.firstDays===null || l.firstDays>=dias).length;
        return { dias,elegiveis:eligible.length,semPresente:absent,percentualSemPresente:percentage(absent,eligible.length) }; }),
      cobertura:coverage('Coortes de listas criadas no período. Tempo usa aprovação no ledger; percentis só entre listas pagas. D7/14/30 incluem apenas listas maduras; demais continuam no total.',lists.length,first.length,true) },
    coortes:[...cohorts.values()], coberturaCoortes:partialCosts,
    pagadores: { pagamentosAprovados:result.payers.payments,pagamentosComEmail:result.payers.withEmail,pagadoresUnicos:result.payers.unique,
      pagadoresRecorrentes:result.payers.repeat,percentualRecorrentes:percentage(result.payers.repeat,result.payers.unique),
      medianaPorLista:percentile(lists.map(l=>l.payers),0.5),p90PorLista:percentile(lists.map(l=>l.payers),0.9),
      cobertura:coverage('Email normalizado não comprova pessoa. Recorrência: mais de um pagamento aprovado nas listas da coorte; percentis por lista incluem zeros.',result.payers.payments,result.payers.withEmail,true) },
    risco:{semData:lists.length-withDate.length,faixas:[[0,3],[4,7],[8,14]].map(([de=0,ate=0])=>{
      const group=withDate.filter(l=>l.eventDays!==null&&l.eventDays>=de&&l.eventDays<=ate);
      return {deDias:de,ateDias:ate,listas:group.length,semPrimeiroPresente:group.filter(l=>l.firstDays===null).length,semPagamento7Dias:group.filter(l=>l.lastDays===null||l.lastDays>=7).length};
    }),cobertura:coverage('Data atual do evento; faixas sem sobreposição. Sem pagamento não significa que a lista não foi compartilhada. Apenas listas da coorte selecionada.',lists.length,withDate.length,true)},
    curvaEvento:{dias:Array.from({length:38},(_,i)=>result.curve.find(d=>d.diaRelativo===i-30)??{diaRelativo:i-30,pagamentos:0,gmvCents:0}),
      cobertura:coverage('Dias de São Paulo relativos à data ATUAL do evento, que pode ter sido editada. Sem histórico de alterações; janelas futuras são incompletas.',lists.length,withDate.length,true)},
    concentracao:{listas:lists.length,listasSemReceita:lists.filter(l=>l.fees-l.reversals===0).length,gmvCents:gmv,margemCents:margin,
      top10GmvPct:percentage(top(lists.map(l=>l.gmv)),gmv),top10MargemPct:percentage(top(margins),margin),cobertura:partialCosts},
  };
}
