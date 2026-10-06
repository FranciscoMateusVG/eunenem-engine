import { sql } from "kysely";
import type { Database } from "../../../src/adapters/database.js";
import {
  agregarDias,
  type DiaPainel,
  gradePainel,
  type PainelAgregado,
  type Soma as SomaPainel,
} from "../pages/lib/receitaPainel.js";
import {
  type BucketReceita,
  bucketsDoPeriodo,
  type Granularidade,
  localDateInSaoPaulo,
  mesAtual,
  type PeriodoInvalido,
  type PeriodoReceita,
  RECEITA_TIMEZONE,
  semanaAtual,
} from "../pages/lib/receitaPeriodo.js";
import {
  ADMINISTRADORES_EXIBIDOS,
  type CampaignAdministrators,
  loadCampaignAdministrators,
  NO_CAMPAIGN_ADMINISTRATORS,
} from "./admin-campaign-administrators.js";

/**
 * Admin read model — Receita EuNeném (aperture-9bpre; plano aperture-owmqs
 * A2.1, contrato ROOT no epic aperture-qda35).
 *
 * O QUE É: taxas da plataforma registradas no ledger
 * (`lancamentos_financeiros.tipo = 'credito_receita_plataforma'`). A
 * existência da linha JÁ é o fato da aprovação.
 *
 * O QUE NÃO É: saldo de campanhas, total pago, lucro ou valor líquido. Custo
 * real do provedor, estorno parcial e disputa não estão no ledger.
 *
 * EVENTOS (opção E):
 *   taxasRegistradas(P) = SUM(amount_cents) com criado_em em P
 *   cancelamentos(P)    = SUM(amount_cents) com cancelado_em em P
 *   resultadoDeTaxas(P) = taxasRegistradas(P) − cancelamentos(P)  (pode ser < 0)
 * NENHUMA fórmula lê `pagamentos.status`. O status só aparece no bloco de
 * inconsistências, que fica fora de qualquer total.
 *
 * ESCOPO: a linha de receita tem `id_campanha` nulo por convenção; a campanha
 * (e portanto a plataforma) vem de `id_pagamento → pagamentos.
 * intencao_id_campanha → campanhas`. Linha cujo pagamento não resolve para
 * uma campanha DESTA plataforma não é lida, contada nem somada — a plataforma
 * dela não é provável. Isso é um limite declarado, não um zero.
 *
 * SNAPSHOT ÚNICO: todas as consultas do dashboard rodam na MESMA transação
 * `REPEATABLE READ` + `READ ONLY`, no mesmo handle. O total é um SUM
 * independente (sem GROUP BY, sem LIMIT); série e decomposições são somadas à
 * parte e a diferença é devolvida como está — nunca ajustada.
 */

export const RECEITA_CAMPANHAS_LIMIT = 100;

export class InvalidReceitaPeriodoError extends Error {
  constructor(readonly motivo: PeriodoInvalido) {
    super(`invalid_receita_periodo:${motivo}`);
    this.name = "InvalidReceitaPeriodoError";
  }
}

// ────────────────────────────────────────────────────────────────────
//  Shapes
// ────────────────────────────────────────────────────────────────────

export interface MetricasReceita {
  readonly taxasRegistradasCents: number;
  readonly cancelamentosCents: number;
  /** registradas − cancelamentos. Pode ser negativo. */
  readonly resultadoDeTaxasCents: number;
}

export interface AdicionalCartao {
  readonly registradoCents: number;
  readonly canceladoCents: number;
}

export interface CardReceita extends MetricasReceita {
  readonly de: string;
  readonly ate: string;
  readonly lancamentosRegistrados: number;
  readonly lancamentosCancelados: number;
  readonly pagamentosComTaxa: number;
  /** Informativo: repasse do custo de cartão. NUNCA entra em receita. */
  readonly adicionalCartao: AdicionalCartao;
}

export interface SerieBucketReceita extends BucketReceita, MetricasReceita {}

export interface CampanhaReceita extends MetricasReceita {
  readonly idCampanha: string;
  readonly titulo: string;
  readonly campaignSlug: string | null;
  readonly administrators: CampaignAdministrators;
}

export type MetodoReceita = "pix" | "credit_card" | "nao_registrado";
export type ProvedorReceita = "stripe" | "inter" | "nao_registrado";

export interface MeioProvedorReceita extends MetricasReceita {
  readonly metodo: MetodoReceita;
  readonly provedor: ProvedorReceita;
}

export interface SomaReceita {
  readonly taxasRegistradasCents: number;
  readonly cancelamentosCents: number;
}

export interface InconsistenciaReceita {
  readonly count: number;
  readonly cents: number;
}

export interface ReceitaDashboard {
  readonly snapshotAt: Date;
  readonly timezone: typeof RECEITA_TIMEZONE;
  readonly periodo: PeriodoReceita;
  readonly cards: {
    readonly semanaAtual: CardReceita;
    readonly mesAtual: CardReceita;
    readonly periodo: CardReceita;
  };
  readonly serie: readonly SerieBucketReceita[];
  readonly porCampanha: {
    readonly rows: readonly CampanhaReceita[];
    readonly campanhasTotal: number;
    readonly truncated: boolean;
    /** Soma das campanhas que ficaram fora de `rows`, no mesmo snapshot. */
    readonly foraDaLista: SomaReceita;
  };
  readonly porMeioProvedor: readonly MeioProvedorReceita[];
  readonly conciliacao: {
    readonly totalIndependente: SomaReceita;
    readonly somaSerie: SomaReceita;
    readonly somaPorCampanha: SomaReceita;
    readonly somaPorMeioProvedor: SomaReceita;
    /** totalIndependente − soma. Exibir quando ≠ 0; nunca ajustar. */
    readonly diferencas: {
      readonly serie: SomaReceita;
      readonly porCampanha: SomaReceita;
      readonly porMeioProvedor: SomaReceita;
    };
  };
  readonly inconsistencias: InconsistenciasReceita;
  /** MIN(criado_em) das taxas no escopo. Primeiro registro, NÃO cobertura. */
  readonly primeiroRegistroTaxaEm: Date | null;
}

// ────────────────────────────────────────────────────────────────────
//  SQL helpers
// ────────────────────────────────────────────────────────────────────

const TIPO_RECEITA = "credito_receita_plataforma";
const TIPO_ADICIONAL = "credito_passthrough_surcharge";
const TIPO_SALDO_RECEBEDOR = "credito_saldo_recebedor";

/** Tipos lidos pelo dashboard: taxa e adicional de cartão. */
const TIPOS_DASHBOARD = [TIPO_RECEITA, TIPO_ADICIONAL] as const;
/**
 * Os três tipos que um pagamento aprovado gera. Por invariante do livro, a
 * soma deles por pagamento é `pagamentos.intencao_total_paid_cents`.
 */
const TIPOS_PAGAMENTO = [TIPO_RECEITA, TIPO_ADICIONAL, TIPO_SALDO_RECEBEDOR] as const;

function inteiro(value: string | number | null | undefined, campo: string): number {
  if (value === null || value === undefined) {
    throw new Error(`admin_receita_valor_ausente:${campo}`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`admin_receita_valor_invalido:${campo}`);
  }
  return parsed;
}

function naoNegativo(value: string | number | null | undefined, campo: string): number {
  const parsed = inteiro(value, campo);
  if (parsed < 0) throw new Error(`admin_receita_valor_negativo:${campo}`);
  return parsed;
}

/** Meia-noite local de São Paulo da data `YYYY-MM-DD`, como timestamptz. */
function corte(data: string) {
  return sql`((${data}::date)::timestamp AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)})`;
}

/**
 * Eventos do período, já no escopo da plataforma. Uma linha do ledger produz
 * um evento `registro` (datado por criado_em) e, se cancelada, um evento
 * `cancelamento` (datado por cancelado_em). Os dois ramos filtram pela
 * PRÓPRIA data — registrar não olha cancelado_em e cancelar não olha
 * criado_em.
 */
function eventosDoPeriodo(
  platformId: string,
  de: string,
  ate: string,
  tipos: readonly string[] = TIPOS_DASHBOARD,
) {
  const colunas = sql`
      l.id,
      l.tipo,
      l.amount_cents,
      l.id_pagamento,
      c.id AS id_campanha,
      CASE
        WHEN p.intencao_metodo IN ('pix', 'credit_card') THEN p.intencao_metodo
        ELSE 'nao_registrado'
      END AS metodo,
      CASE
        WHEN p.transacao_externa ->> 'provedor' IN ('stripe', 'inter')
          THEN p.transacao_externa ->> 'provedor'
        ELSE 'nao_registrado'
      END AS provedor`;
  const origem = sql`
    FROM lancamentos_financeiros l
    INNER JOIN pagamentos p ON p.id = l.id_pagamento
    INNER JOIN campanhas c
      ON c.id = p.intencao_id_campanha
     AND c.id_plataforma = ${platformId}
    WHERE l.tipo IN (${sql.join(tipos.map((tipo) => sql.lit(tipo)))})`;
  return sql`(
    SELECT ${colunas}, 'registro'::text AS evento, l.criado_em AS em
    ${origem}
      AND l.criado_em >= ${corte(de)}
      AND l.criado_em < ${corte(ate)}
    UNION ALL
    SELECT ${colunas}, 'cancelamento'::text AS evento, l.cancelado_em AS em
    ${origem}
      AND l.cancelado_em >= ${corte(de)}
      AND l.cancelado_em < ${corte(ate)}
  )`;
}

const SOMA_REGISTRADAS = sql`COALESCE(SUM(e.amount_cents) FILTER (
  WHERE e.tipo = ${sql.lit(TIPO_RECEITA)} AND e.evento = 'registro'
), 0)::bigint`;
const SOMA_CANCELAMENTOS = sql`COALESCE(SUM(e.amount_cents) FILTER (
  WHERE e.tipo = ${sql.lit(TIPO_RECEITA)} AND e.evento = 'cancelamento'
), 0)::bigint`;

function metricas(registradas: number, cancelamentos: number): MetricasReceita {
  return {
    taxasRegistradasCents: registradas,
    cancelamentosCents: cancelamentos,
    resultadoDeTaxasCents: registradas - cancelamentos,
  };
}

function somar(rows: readonly SomaReceita[]): SomaReceita {
  let taxasRegistradasCents = 0;
  let cancelamentosCents = 0;
  for (const row of rows) {
    taxasRegistradasCents += row.taxasRegistradasCents;
    cancelamentosCents += row.cancelamentosCents;
  }
  return { taxasRegistradasCents, cancelamentosCents };
}

function diferenca(total: SomaReceita, soma: SomaReceita): SomaReceita {
  return {
    taxasRegistradasCents: total.taxasRegistradasCents - soma.taxasRegistradasCents,
    cancelamentosCents: total.cancelamentosCents - soma.cancelamentosCents,
  };
}

// ────────────────────────────────────────────────────────────────────
//  Consultas internas (todas recebem o handle da transação)
// ────────────────────────────────────────────────────────────────────

interface TotalRow {
  registradas: string | number;
  cancelamentos: string | number;
  registrados_n: string | number;
  cancelados_n: string | number;
  pagamentos_com_taxa: string | number;
  adicional_registrado: string | number;
  adicional_cancelado: string | number;
}

/** SUM independente do intervalo: sem GROUP BY, sem LIMIT. */
async function totalDoIntervalo(
  trx: Database,
  platformId: string,
  intervalo: { readonly de: string; readonly ate: string },
): Promise<CardReceita> {
  const result = await sql<TotalRow>`
    SELECT
      ${SOMA_REGISTRADAS} AS registradas,
      ${SOMA_CANCELAMENTOS} AS cancelamentos,
      COUNT(*) FILTER (
        WHERE e.tipo = ${sql.lit(TIPO_RECEITA)} AND e.evento = 'registro'
      ) AS registrados_n,
      COUNT(*) FILTER (
        WHERE e.tipo = ${sql.lit(TIPO_RECEITA)} AND e.evento = 'cancelamento'
      ) AS cancelados_n,
      COUNT(DISTINCT e.id_pagamento) FILTER (
        WHERE e.tipo = ${sql.lit(TIPO_RECEITA)} AND e.evento = 'registro'
      ) AS pagamentos_com_taxa,
      COALESCE(SUM(e.amount_cents) FILTER (
        WHERE e.tipo = ${sql.lit(TIPO_ADICIONAL)} AND e.evento = 'registro'
      ), 0)::bigint AS adicional_registrado,
      COALESCE(SUM(e.amount_cents) FILTER (
        WHERE e.tipo = ${sql.lit(TIPO_ADICIONAL)} AND e.evento = 'cancelamento'
      ), 0)::bigint AS adicional_cancelado
    FROM ${eventosDoPeriodo(platformId, intervalo.de, intervalo.ate)} e
  `.execute(trx);
  const row = result.rows[0];
  if (!row) throw new Error("admin_receita_total_sem_linha");
  return {
    de: intervalo.de,
    ate: intervalo.ate,
    ...metricas(
      naoNegativo(row.registradas, "registradas"),
      naoNegativo(row.cancelamentos, "cancelamentos"),
    ),
    lancamentosRegistrados: naoNegativo(row.registrados_n, "registrados_n"),
    lancamentosCancelados: naoNegativo(row.cancelados_n, "cancelados_n"),
    pagamentosComTaxa: naoNegativo(row.pagamentos_com_taxa, "pagamentos_com_taxa"),
    adicionalCartao: {
      registradoCents: naoNegativo(row.adicional_registrado, "adicional_registrado"),
      canceladoCents: naoNegativo(row.adicional_cancelado, "adicional_cancelado"),
    },
  };
}

interface SerieRow {
  bucket: string;
  registradas: string | number;
  cancelamentos: string | number;
}

async function serieDoPeriodo(
  trx: Database,
  platformId: string,
  periodo: PeriodoReceita,
  buckets: readonly BucketReceita[],
): Promise<SerieBucketReceita[]> {
  const unidade = periodo.granularidade === "semana" ? "week" : "month";
  const result = await sql<SerieRow>`
    SELECT
      to_char(
        date_trunc(
          ${sql.lit(unidade)},
          e.em AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)}
        ),
        'YYYY-MM-DD'
      ) AS bucket,
      ${SOMA_REGISTRADAS} AS registradas,
      ${SOMA_CANCELAMENTOS} AS cancelamentos
    FROM ${eventosDoPeriodo(platformId, periodo.de, periodo.ate)} e
    WHERE e.tipo = ${sql.lit(TIPO_RECEITA)}
    GROUP BY 1
  `.execute(trx);

  const porInicio = new Map<string, SerieRow>();
  for (const row of result.rows) porInicio.set(row.bucket, row);

  const serie = buckets.map((bucket): SerieBucketReceita => {
    const row = porInicio.get(bucket.inicio);
    porInicio.delete(bucket.inicio);
    return {
      ...bucket,
      ...metricas(
        row ? naoNegativo(row.registradas, "serie.registradas") : 0,
        row ? naoNegativo(row.cancelamentos, "serie.cancelamentos") : 0,
      ),
    };
  });
  // Um bucket vindo do banco que não existe na grade do período seria valor
  // descartado em silêncio. Falhar alto é o comportamento correto.
  if (porInicio.size > 0) throw new Error("admin_receita_bucket_fora_do_periodo");
  return serie;
}

interface CampanhaPageRow {
  id_campanha: string;
  titulo: string;
  slug: string | null;
  registradas: string | number;
  cancelamentos: string | number;
}

interface CampanhaRow extends CampanhaPageRow {
  campanhas_total: string | number;
  soma_registradas: string | number;
  soma_cancelamentos: string | number;
}

/** Agregado por campanha do período, ordenado por registradas DESC, id ASC. */
function porCampanhaCte(platformId: string, de: string, ate: string) {
  return sql`
    por AS (
      SELECT
        e.id_campanha,
        ${SOMA_REGISTRADAS} AS registradas,
        ${SOMA_CANCELAMENTOS} AS cancelamentos
      FROM ${eventosDoPeriodo(platformId, de, ate)} e
      WHERE e.tipo = ${sql.lit(TIPO_RECEITA)}
      GROUP BY e.id_campanha
    )`;
}

function safeTitulo(value: string): string {
  return value.length === 0 ? "Título indisponível" : value;
}

function toCampanhaReceita(
  row: CampanhaPageRow,
  administrators: Map<string, CampaignAdministrators>,
): CampanhaReceita {
  return {
    idCampanha: row.id_campanha,
    titulo: safeTitulo(row.titulo),
    campaignSlug: row.slug,
    administrators: administrators.get(row.id_campanha) ?? NO_CAMPAIGN_ADMINISTRATORS,
    ...metricas(
      naoNegativo(row.registradas, "campanha.registradas"),
      naoNegativo(row.cancelamentos, "campanha.cancelamentos"),
    ),
  };
}

interface MeioRow {
  metodo: string;
  provedor: string;
  registradas: string | number;
  cancelamentos: string | number;
}

function toMetodo(value: string): MetodoReceita {
  return value === "pix" || value === "credit_card" ? value : "nao_registrado";
}

function toProvedor(value: string): ProvedorReceita {
  return value === "stripe" || value === "inter" ? value : "nao_registrado";
}

interface InconsistenciaRow {
  estornado_sem_cancelamento_n: string | number;
  estornado_sem_cancelamento_cents: string | number;
  cancelado_sem_estorno_n: string | number;
  cancelado_sem_estorno_cents: string | number;
}

export interface InconsistenciasReceita {
  /** Pagamento estornado cuja linha de taxa não tem cancelado_em. */
  readonly estornadoSemCancelamento: InconsistenciaReceita;
  /** Linha de taxa cancelada cujo pagamento não está estornado. */
  readonly canceladoSemEstorno: InconsistenciaReceita;
}

/**
 * Único ponto que lê pagamentos.status — e fica fora de todo total. Linhas de
 * taxa registradas OU canceladas no intervalo.
 */
async function inconsistenciasDoIntervalo(
  trx: Database,
  platformId: string,
  intervalo: { readonly de: string; readonly ate: string },
): Promise<InconsistenciasReceita> {
  const incRes = await sql<InconsistenciaRow>`
    SELECT
      COUNT(*) FILTER (
        WHERE p.status = 'estornado' AND l.cancelado_em IS NULL
      ) AS estornado_sem_cancelamento_n,
      COALESCE(SUM(l.amount_cents) FILTER (
        WHERE p.status = 'estornado' AND l.cancelado_em IS NULL
      ), 0)::bigint AS estornado_sem_cancelamento_cents,
      COUNT(*) FILTER (
        WHERE p.status <> 'estornado' AND l.cancelado_em IS NOT NULL
      ) AS cancelado_sem_estorno_n,
      COALESCE(SUM(l.amount_cents) FILTER (
        WHERE p.status <> 'estornado' AND l.cancelado_em IS NOT NULL
      ), 0)::bigint AS cancelado_sem_estorno_cents
    FROM lancamentos_financeiros l
    INNER JOIN pagamentos p ON p.id = l.id_pagamento
    INNER JOIN campanhas c
      ON c.id = p.intencao_id_campanha
     AND c.id_plataforma = ${platformId}
    WHERE l.tipo = ${sql.lit(TIPO_RECEITA)}
      AND (
        (l.criado_em >= ${corte(intervalo.de)} AND l.criado_em < ${corte(intervalo.ate)})
        OR (
          l.cancelado_em >= ${corte(intervalo.de)}
          AND l.cancelado_em < ${corte(intervalo.ate)}
        )
      )
  `.execute(trx);
  const inc = incRes.rows[0];
  if (!inc) throw new Error("admin_receita_inconsistencias_sem_linha");
  return {
    estornadoSemCancelamento: {
      count: naoNegativo(inc.estornado_sem_cancelamento_n, "inc.estornado_n"),
      cents: naoNegativo(inc.estornado_sem_cancelamento_cents, "inc.estornado_cents"),
    },
    canceladoSemEstorno: {
      count: naoNegativo(inc.cancelado_sem_estorno_n, "inc.cancelado_n"),
      cents: naoNegativo(inc.cancelado_sem_estorno_cents, "inc.cancelado_cents"),
    },
  };
}

/**
 * Uma transação `REPEATABLE READ` + `READ ONLY`: toda leitura de `fn` vê o
 * mesmo snapshot. A primeira consulta fixa o snapshot e registra o instante.
 */
async function emSnapshotDeLeitura<T>(
  db: Database,
  fn: (trx: Database, snapshotAt: Date) => Promise<T>,
): Promise<T> {
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const snapshot = await sql<{ snapshot_at: Date }>`
        SELECT now() AS snapshot_at
      `.execute(trx);
      const snapshotAt = snapshot.rows[0]?.snapshot_at;
      if (!snapshotAt) throw new Error("admin_receita_snapshot_sem_instante");
      return fn(trx, new Date(snapshotAt));
    });
}

// ────────────────────────────────────────────────────────────────────
//  Dashboard
// ────────────────────────────────────────────────────────────────────

export async function loadReceitaDashboard(
  db: Database,
  input: {
    readonly platformId: string;
    readonly periodo: PeriodoReceita;
    readonly now: Date;
  },
): Promise<ReceitaDashboard> {
  const { platformId, periodo, now } = input;
  const grade = bucketsDoPeriodo(periodo);
  if (!grade.ok) throw new InvalidReceitaPeriodoError(grade.erro);

  return emSnapshotDeLeitura(db, async (trx, snapshotAt) => {
      const cardPeriodo = await totalDoIntervalo(trx, platformId, periodo);
      const cardSemana = await totalDoIntervalo(trx, platformId, semanaAtual(now));
      const cardMes = await totalDoIntervalo(trx, platformId, mesAtual(now));

      const serie = await serieDoPeriodo(trx, platformId, periodo, grade.buckets);

      const campanhasRes = await sql<CampanhaRow>`
        WITH ${porCampanhaCte(platformId, periodo.de, periodo.ate)}
        SELECT
          por.id_campanha,
          c.titulo,
          c.slug,
          por.registradas,
          por.cancelamentos,
          COUNT(*) OVER () AS campanhas_total,
          COALESCE(SUM(por.registradas) OVER (), 0)::bigint AS soma_registradas,
          COALESCE(SUM(por.cancelamentos) OVER (), 0)::bigint AS soma_cancelamentos
        FROM por
        INNER JOIN campanhas c ON c.id = por.id_campanha
        ORDER BY por.registradas DESC, por.id_campanha ASC
        LIMIT ${RECEITA_CAMPANHAS_LIMIT}
      `.execute(trx);

      const administrators = await loadCampaignAdministrators(trx, {
        platformId,
        campaignIds: campanhasRes.rows.map((row) => row.id_campanha),
        perCampaignLimit: ADMINISTRADORES_EXIBIDOS,
      });
      const campanhas = campanhasRes.rows.map((row) =>
        toCampanhaReceita(row, administrators),
      );
      const primeira = campanhasRes.rows[0];
      const campanhasTotal = primeira
        ? naoNegativo(primeira.campanhas_total, "campanhas_total")
        : 0;
      const somaPorCampanha: SomaReceita = primeira
        ? {
            taxasRegistradasCents: naoNegativo(primeira.soma_registradas, "soma_registradas"),
            cancelamentosCents: naoNegativo(primeira.soma_cancelamentos, "soma_cancelamentos"),
          }
        : { taxasRegistradasCents: 0, cancelamentosCents: 0 };

      const meioRes = await sql<MeioRow>`
        SELECT
          e.metodo,
          e.provedor,
          ${SOMA_REGISTRADAS} AS registradas,
          ${SOMA_CANCELAMENTOS} AS cancelamentos
        FROM ${eventosDoPeriodo(platformId, periodo.de, periodo.ate)} e
        WHERE e.tipo = ${sql.lit(TIPO_RECEITA)}
        GROUP BY e.metodo, e.provedor
        ORDER BY e.metodo ASC, e.provedor ASC
      `.execute(trx);
      const porMeioProvedor = meioRes.rows.map(
        (row): MeioProvedorReceita => ({
          metodo: toMetodo(row.metodo),
          provedor: toProvedor(row.provedor),
          ...metricas(
            naoNegativo(row.registradas, "meio.registradas"),
            naoNegativo(row.cancelamentos, "meio.cancelamentos"),
          ),
        }),
      );

      const inconsistencias = await inconsistenciasDoIntervalo(trx, platformId, periodo);

      const primeiroRes = await sql<{ primeiro: Date | null }>`
        SELECT MIN(l.criado_em) AS primeiro
        FROM lancamentos_financeiros l
        INNER JOIN pagamentos p ON p.id = l.id_pagamento
        INNER JOIN campanhas c
          ON c.id = p.intencao_id_campanha
         AND c.id_plataforma = ${platformId}
        WHERE l.tipo = ${sql.lit(TIPO_RECEITA)}
      `.execute(trx);

      const totalIndependente: SomaReceita = {
        taxasRegistradasCents: cardPeriodo.taxasRegistradasCents,
        cancelamentosCents: cardPeriodo.cancelamentosCents,
      };
      const somaSerie = somar(serie);
      const somaPorMeioProvedor = somar(porMeioProvedor);
      const listadas = somar(campanhas);

      return {
        snapshotAt: new Date(snapshotAt),
        timezone: RECEITA_TIMEZONE,
        periodo,
        cards: { semanaAtual: cardSemana, mesAtual: cardMes, periodo: cardPeriodo },
        serie,
        porCampanha: {
          rows: campanhas,
          campanhasTotal,
          truncated: campanhasTotal > campanhas.length,
          foraDaLista: diferenca(somaPorCampanha, listadas),
        },
        porMeioProvedor,
        conciliacao: {
          totalIndependente,
          somaSerie,
          somaPorCampanha,
          somaPorMeioProvedor,
          diferencas: {
            serie: diferenca(totalIndependente, somaSerie),
            porCampanha: diferenca(totalIndependente, somaPorCampanha),
            porMeioProvedor: diferenca(totalIndependente, somaPorMeioProvedor),
          },
        },
        inconsistencias,
        primeiroRegistroTaxaEm: primeiroRes.rows[0]?.primeiro
          ? new Date(primeiroRes.rows[0].primeiro)
          : null,
      };
    });
}

// ────────────────────────────────────────────────────────────────────
//  Painel 1b (aperture-zn5cm): Tarifas EuNeném e Recebido no banco
//
//  Tarifas  = o mesmo resultado de taxas do dashboard (`credito_receita_
//             plataforma`, registro por criado_em − cancelamento por
//             cancelado_em).
//  Recebido = os TRÊS tipos que um pagamento aprovado gera, no mesmo modelo de
//             eventos. Por invariante do livro, a soma deles por pagamento é
//             `intencao_total_paid_cents` (o bruto pago pelo contribuinte), e
//             o estorno total cancela todas as linhas do pagamento. É uma
//             estimativa: custo do provedor, estorno parcial, disputa e
//             chargeback não estão no ledger.
//
//  Uma consulta agrupada por dia local de SP alimenta todos os buckets (a
//  soma em meses e semanas é pura, em `receitaPainel.ts`). Um SUM
//  independente da janela, no MESMO snapshot, concilia a soma dos dias; a
//  diferença é devolvida como está.
// ────────────────────────────────────────────────────────────────────

export interface ReceitaPainel extends PainelAgregado {
  readonly snapshotAt: Date;
  readonly timezone: typeof RECEITA_TIMEZONE;
  readonly hoje: string;
  readonly janela: { readonly de: string; readonly ate: string };
  /** SUM independente da janela − soma dos dias. Exibir quando ≠ 0. */
  readonly diferencaConciliacao: {
    readonly tarifas: SomaPainel;
    readonly recebido: SomaPainel;
  };
  readonly inconsistencias: InconsistenciasReceita;
}

const SOMAS_PAINEL = sql`
  ${SOMA_REGISTRADAS} AS tarifas_registradas,
  ${SOMA_CANCELAMENTOS} AS tarifas_canceladas,
  COALESCE(SUM(e.amount_cents) FILTER (WHERE e.evento = 'registro'), 0)::bigint
    AS recebido_registrado,
  COALESCE(SUM(e.amount_cents) FILTER (WHERE e.evento = 'cancelamento'), 0)::bigint
    AS recebido_cancelado`;

interface SomasPainelRow {
  tarifas_registradas: string | number;
  tarifas_canceladas: string | number;
  recebido_registrado: string | number;
  recebido_cancelado: string | number;
}

function toSomasPainel(row: SomasPainelRow, campo: string): Omit<DiaPainel, "dia"> {
  return {
    tarifas: {
      registradoCents: naoNegativo(row.tarifas_registradas, `${campo}.tarifas_registradas`),
      canceladoCents: naoNegativo(row.tarifas_canceladas, `${campo}.tarifas_canceladas`),
    },
    recebido: {
      registradoCents: naoNegativo(row.recebido_registrado, `${campo}.recebido_registrado`),
      canceladoCents: naoNegativo(row.recebido_cancelado, `${campo}.recebido_cancelado`),
    },
  };
}

function diferencaSoma(total: SomaPainel, soma: SomaPainel): SomaPainel {
  return {
    registradoCents: total.registradoCents - soma.registradoCents,
    canceladoCents: total.canceladoCents - soma.canceladoCents,
  };
}

export async function loadReceitaPainel(
  db: Database,
  input: { readonly platformId: string; readonly now: Date },
): Promise<ReceitaPainel> {
  const { platformId } = input;
  const grade = gradePainel(localDateInSaoPaulo(input.now));
  const { janela } = grade;

  return emSnapshotDeLeitura(db, async (trx, snapshotAt) => {
    const total = await sql<SomasPainelRow>`
      SELECT ${SOMAS_PAINEL}
      FROM ${eventosDoPeriodo(platformId, janela.de, janela.ate, TIPOS_PAGAMENTO)} e
    `.execute(trx);
    const totalRow = total.rows[0];
    if (!totalRow) throw new Error("admin_receita_painel_total_sem_linha");
    const independente = toSomasPainel(totalRow, "total");

    const diasRes = await sql<SomasPainelRow & { dia: string }>`
      SELECT
        to_char(e.em AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)}, 'YYYY-MM-DD') AS dia,
        ${SOMAS_PAINEL}
      FROM ${eventosDoPeriodo(platformId, janela.de, janela.ate, TIPOS_PAGAMENTO)} e
      GROUP BY 1
      ORDER BY 1
    `.execute(trx);
    const dias = diasRes.rows.map(
      (row): DiaPainel => ({ dia: row.dia, ...toSomasPainel(row, "dia") }),
    );
    const agregado = agregarDias(grade, dias);

    return {
      ...agregado,
      snapshotAt,
      timezone: RECEITA_TIMEZONE,
      hoje: grade.hoje,
      janela,
      diferencaConciliacao: {
        tarifas: diferencaSoma(independente.tarifas, agregado.somaDosDias.tarifas),
        recebido: diferencaSoma(independente.recebido, agregado.somaDosDias.recebido),
      },
      inconsistencias: await inconsistenciasDoIntervalo(trx, platformId, janela),
    };
  });
}

export type { Granularidade };
