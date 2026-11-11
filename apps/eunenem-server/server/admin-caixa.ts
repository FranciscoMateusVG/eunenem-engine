import { sql } from "kysely";
import type { Database } from "../../../src/adapters/database.js";
import {
  type BucketCaixa,
  bucketsDoPeriodoCaixa,
  type CaixaGranularidade,
  inicioDoBucket,
  type PeriodoCaixa,
  type PeriodoCaixaInvalido,
} from "../pages/lib/caixaPeriodo.js";
import { localDateInSaoPaulo, RECEITA_TIMEZONE } from "../pages/lib/receitaPeriodo.js";
import { emSnapshotDeLeitura } from "./admin-receita.js";

/**
 * Admin read model — Fluxo de caixa (aperture-zoxel).
 *
 * LEITURA PURA. Nada aqui move dinheiro nem altera pagamento/repasse/livro.
 *
 * ENTRADAS: lançamentos do livro de um pagamento aprovado
 * (`credito_saldo_recebedor` = presente, `credito_receita_plataforma` = taxa
 * EuNeném, `credito_passthrough_surcharge` = adicional do cartão). A soma dos
 * três por pagamento é `pagamentos.intencao_total_paid_cents` (invariante do
 * livro) e é conferida na conciliação. Entrada é datada por `criado_em`;
 * ESTORNO é o mesmo lançamento datado por `cancelado_em`. Líquido = bruto −
 * estornos (pode ser negativo). Nenhuma fórmula lê `pagamentos.status`.
 *
 * SAÍDAS: lançamento `credito_saldo_recebedor` ligado a repasse com
 * `transferido_em` preenchido — o mesmo predicado que o saldo do recebedor
 * usa (aprovado ≠ transferido). Datada por `transferido_em`. Método: repasse
 * com `inter_codigo_solicitacao` = Inter automático; sem ele = manual
 * (com referência bancária, quando houver).
 *
 * PENDENTE (fotografia de agora, independe do período e NUNCA entra em
 * saída/saldo; repasse já carimbado `transferido_em` não é pendente): repasses `aprovado`/`transferindo`/`enviado_ao_banco`/`falhou`
 * ("aprovados ainda não transferidos") e `verificando` ("em verificação").
 *
 * ESCOPO: a plataforma vem de pagamento→campanha (entradas) e
 * repasse→campanha (saídas/pendentes).
 *
 * FUSO: cortes em meia-noite de America/Sao_Paulo, intervalo [de, ate).
 * SNAPSHOT: todas as consultas na mesma transação REPEATABLE READ + READ ONLY.
 * CONCILIAÇÃO: o total é um SUM independente (sem GROUP BY); série e
 * decomposições são somadas à parte e a diferença é devolvida como está.
 */

export class InvalidCaixaPeriodoError extends Error {
  constructor(readonly motivo: PeriodoCaixaInvalido) {
    super(`invalid_caixa_periodo:${motivo}`);
    this.name = "InvalidCaixaPeriodoError";
  }
}

export type MetodoEntrada = "pix" | "credit_card" | "nao_registrado";
export type MetodoSaida = "inter" | "manual";

export interface EntradaValores {
  readonly presenteCents: number;
  readonly taxaCents: number;
  readonly adicionalCartaoCents: number;
  readonly brutoCents: number;
  readonly estornosCents: number;
  readonly liquidoCents: number;
}

export interface SaidaMetodo {
  readonly cents: number;
  readonly repasses: number;
}

export interface SerieBucketCaixa extends BucketCaixa {
  readonly entradasBrutasCents: number;
  readonly estornosCents: number;
  readonly entradasLiquidasCents: number;
  readonly saidasCents: number;
  readonly saldoCents: number;
}

export interface PendenteCaixa {
  readonly cents: number;
  readonly repasses: number;
}

export interface SomaCaixa {
  readonly entradasBrutasCents: number;
  readonly estornosCents: number;
  readonly saidasCents: number;
}

export interface CaixaPainel {
  readonly snapshotAt: Date;
  readonly timezone: typeof RECEITA_TIMEZONE;
  readonly hoje: string;
  readonly periodo: PeriodoCaixa;
  readonly entradas: EntradaValores & {
    readonly pagamentos: number;
    readonly porMetodo: Readonly<Record<MetodoEntrada, EntradaValores>>;
  };
  readonly saidas: {
    readonly totalCents: number;
    readonly repasses: number;
    readonly porMetodo: Readonly<Record<MetodoSaida, SaidaMetodo>>;
  };
  readonly pendentes: {
    readonly aprovadosNaoTransferidos: PendenteCaixa;
    readonly emVerificacao: PendenteCaixa;
  };
  /** Entradas líquidas − saídas. Pendente não entra. */
  readonly saldoCents: number;
  readonly serie: readonly SerieBucketCaixa[];
  readonly conciliacao: {
    readonly totalIndependente: SomaCaixa;
    readonly somaSerie: SomaCaixa;
    /** SUM(pagamentos.intencao_total_paid_cents) dos pagamentos com entrada no período. */
    readonly totalPagoDosPagamentosCents: number;
    /** SUM(repasses_recebedor.amount_cents) dos repasses com saída no período. */
    readonly totalDosRepassesCents: number;
    /** Tudo abaixo: referência − comparado. Exibir quando ≠ 0; nunca ajustar. */
    readonly diferencas: {
      readonly entradasBrutasCents: number;
      readonly estornosCents: number;
      readonly saidasCents: number;
      readonly totalPagoCents: number;
      readonly repassesCents: number;
    };
  };
}

// ────────────────────────────────────────────────────────────────────
//  SQL helpers
// ────────────────────────────────────────────────────────────────────

const TIPO_PRESENTE = "credito_saldo_recebedor";
const TIPO_TAXA = "credito_receita_plataforma";
const TIPO_ADICIONAL = "credito_passthrough_surcharge";
const TIPOS_ENTRADA = [TIPO_PRESENTE, TIPO_TAXA, TIPO_ADICIONAL] as const;

function corte(data: string) {
  return sql`((${data}::date)::timestamp AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)})`;
}

function diaLocal(coluna: string) {
  return sql`to_char(${sql.raw(coluna)} AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)}, 'YYYY-MM-DD')`;
}

/**
 * Cada lançamento de entrada gera um evento `registro` (por criado_em) e, se
 * cancelado, um `estorno` (por cancelado_em); cada ramo filtra pela sua data.
 */
function eventosEntrada(platformId: string, de: string, ate: string) {
  const colunas = sql`
      l.id,
      l.tipo,
      l.amount_cents,
      l.id_pagamento,
      CASE
        WHEN p.intencao_metodo IN ('pix', 'credit_card') THEN p.intencao_metodo
        ELSE 'nao_registrado'
      END AS metodo`;
  const origem = sql`
    FROM lancamentos_financeiros l
    INNER JOIN pagamentos p ON p.id = l.id_pagamento
    INNER JOIN campanhas c
      ON c.id = p.intencao_id_campanha
     AND c.id_plataforma = ${platformId}
    WHERE l.tipo IN (${sql.join(TIPOS_ENTRADA.map((t) => sql.lit(t)))})`;
  return sql`(
    SELECT ${colunas}, 'registro'::text AS evento, l.criado_em AS em,
           ${diaLocal("l.criado_em")} AS dia
    ${origem}
      AND l.criado_em >= ${corte(de)} AND l.criado_em < ${corte(ate)}
    UNION ALL
    SELECT ${colunas}, 'estorno'::text AS evento, l.cancelado_em AS em,
           ${diaLocal("l.cancelado_em")} AS dia
    ${origem}
      AND l.cancelado_em >= ${corte(de)} AND l.cancelado_em < ${corte(ate)}
  )`;
}

/** Lançamentos de presente efetivamente transferidos no período. */
function eventosSaida(platformId: string, de: string, ate: string) {
  return sql`(
    SELECT
      l.id,
      l.amount_cents,
      r.id AS id_repasse,
      r.amount_cents AS repasse_amount_cents,
      CASE WHEN r.inter_codigo_solicitacao IS NOT NULL THEN 'inter' ELSE 'manual' END AS metodo,
      ${diaLocal("l.transferido_em")} AS dia
    FROM lancamentos_financeiros l
    INNER JOIN repasses_recebedor r ON r.id = l.id_repasse
    INNER JOIN campanhas c ON c.id = r.id_campanha AND c.id_plataforma = ${platformId}
    WHERE l.tipo = ${sql.lit(TIPO_PRESENTE)}
      AND l.transferido_em >= ${corte(de)} AND l.transferido_em < ${corte(ate)}
  )`;
}

function inteiro(value: string | number | null | undefined, campo: string): number {
  if (value === null || value === undefined) throw new Error(`admin_caixa_valor_ausente:${campo}`);
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`admin_caixa_valor_invalido:${campo}`);
  return parsed;
}

const SUM = (condicao: ReturnType<typeof sql>) =>
  sql`COALESCE(SUM(e.amount_cents) FILTER (WHERE ${condicao}), 0)::bigint`;

const COLUNAS_ENTRADA = sql`
  ${SUM(sql`e.evento = 'registro' AND e.tipo = ${sql.lit(TIPO_PRESENTE)}`)} AS presente,
  ${SUM(sql`e.evento = 'registro' AND e.tipo = ${sql.lit(TIPO_TAXA)}`)} AS taxa,
  ${SUM(sql`e.evento = 'registro' AND e.tipo = ${sql.lit(TIPO_ADICIONAL)}`)} AS adicional,
  ${SUM(sql`e.evento = 'estorno'`)} AS estornos`;

interface EntradaRow {
  presente: string | number;
  taxa: string | number;
  adicional: string | number;
  estornos: string | number;
}

function entradaValores(row: EntradaRow, campo: string): EntradaValores {
  const presenteCents = inteiro(row.presente, `${campo}.presente`);
  const taxaCents = inteiro(row.taxa, `${campo}.taxa`);
  const adicionalCartaoCents = inteiro(row.adicional, `${campo}.adicional`);
  const estornosCents = inteiro(row.estornos, `${campo}.estornos`);
  const brutoCents = presenteCents + taxaCents + adicionalCartaoCents;
  return {
    presenteCents,
    taxaCents,
    adicionalCartaoCents,
    brutoCents,
    estornosCents,
    liquidoCents: brutoCents - estornosCents,
  };
}

const ZERO_ENTRADA: EntradaValores = {
  presenteCents: 0,
  taxaCents: 0,
  adicionalCartaoCents: 0,
  brutoCents: 0,
  estornosCents: 0,
  liquidoCents: 0,
};

function metodoEntrada(value: string): MetodoEntrada {
  return value === "pix" || value === "credit_card" ? value : "nao_registrado";
}

// ────────────────────────────────────────────────────────────────────
//  Painel
// ────────────────────────────────────────────────────────────────────

export async function loadCaixaPainel(
  db: Database,
  input: { readonly platformId: string; readonly periodo: PeriodoCaixa; readonly now: Date },
): Promise<CaixaPainel> {
  const { platformId, periodo } = input;
  const grade = bucketsDoPeriodoCaixa(periodo);
  if (!grade.ok) throw new InvalidCaixaPeriodoError(grade.erro);
  const { de, ate, granularidade } = periodo;

  return emSnapshotDeLeitura(db, async (trx, snapshotAt) => {
    // ── Entradas: total independente, por método e por dia ────────────
    const totalRes = await sql<EntradaRow & { pagamentos: string | number }>`
      SELECT ${COLUNAS_ENTRADA},
        COUNT(DISTINCT e.id_pagamento) FILTER (WHERE e.evento = 'registro') AS pagamentos
      FROM ${eventosEntrada(platformId, de, ate)} e
    `.execute(trx);
    const total = totalRes.rows[0];
    if (!total) throw new Error("admin_caixa_total_sem_linha");

    const metodoRes = await sql<EntradaRow & { metodo: string }>`
      SELECT e.metodo, ${COLUNAS_ENTRADA}
      FROM ${eventosEntrada(platformId, de, ate)} e
      GROUP BY e.metodo
    `.execute(trx);
    const porMetodo: Record<MetodoEntrada, EntradaValores> = {
      pix: ZERO_ENTRADA,
      credit_card: ZERO_ENTRADA,
      nao_registrado: ZERO_ENTRADA,
    };
    for (const row of metodoRes.rows) {
      porMetodo[metodoEntrada(row.metodo)] = entradaValores(row, `metodo.${row.metodo}`);
    }

    const diasEntradaRes = await sql<EntradaRow & { dia: string }>`
      SELECT e.dia, ${COLUNAS_ENTRADA}
      FROM ${eventosEntrada(platformId, de, ate)} e
      GROUP BY e.dia
    `.execute(trx);

    const totalPagoRes = await sql<{ total_pago: string | number }>`
      SELECT COALESCE(SUM(p.intencao_total_paid_cents), 0)::bigint AS total_pago
      FROM pagamentos p
      WHERE p.id IN (
        SELECT e.id_pagamento FROM ${eventosEntrada(platformId, de, ate)} e
        WHERE e.evento = 'registro'
      )
    `.execute(trx);

    // ── Saídas: total independente, por método e por dia ──────────────
    const saidaTotalRes = await sql<{
      cents: string | number;
      repasses: string | number;
      repasses_cents: string | number;
    }>`
      SELECT
        COALESCE(SUM(s.amount_cents), 0)::bigint AS cents,
        COUNT(DISTINCT s.id_repasse) AS repasses,
        COALESCE((
          SELECT SUM(x.repasse_amount_cents) FROM (
            SELECT DISTINCT s2.id_repasse, s2.repasse_amount_cents
            FROM ${eventosSaida(platformId, de, ate)} s2
          ) x
        ), 0)::bigint AS repasses_cents
      FROM ${eventosSaida(platformId, de, ate)} s
    `.execute(trx);
    const saidaTotal = saidaTotalRes.rows[0];
    if (!saidaTotal) throw new Error("admin_caixa_saida_sem_linha");

    const saidaMetodoRes = await sql<{
      metodo: string;
      cents: string | number;
      repasses: string | number;
    }>`
      SELECT s.metodo, COALESCE(SUM(s.amount_cents), 0)::bigint AS cents,
             COUNT(DISTINCT s.id_repasse) AS repasses
      FROM ${eventosSaida(platformId, de, ate)} s
      GROUP BY s.metodo
    `.execute(trx);
    const saidaPorMetodo: Record<MetodoSaida, SaidaMetodo> = {
      inter: { cents: 0, repasses: 0 },
      manual: { cents: 0, repasses: 0 },
    };
    for (const row of saidaMetodoRes.rows) {
      const chave: MetodoSaida = row.metodo === "inter" ? "inter" : "manual";
      saidaPorMetodo[chave] = {
        cents: inteiro(row.cents, `saida.${row.metodo}.cents`),
        repasses: inteiro(row.repasses, `saida.${row.metodo}.repasses`),
      };
    }

    const diasSaidaRes = await sql<{ dia: string; cents: string | number }>`
      SELECT s.dia, COALESCE(SUM(s.amount_cents), 0)::bigint AS cents
      FROM ${eventosSaida(platformId, de, ate)} s
      GROUP BY s.dia
    `.execute(trx);

    // ── Pendentes: fotografia de agora, independe do período ──────────
    const pendRes = await sql<{ grupo: string; cents: string | number; repasses: string | number }>`
      SELECT
        CASE WHEN r.status = 'verificando' THEN 'verificacao' ELSE 'aprovado' END AS grupo,
        COALESCE(SUM(r.amount_cents), 0)::bigint AS cents,
        COUNT(*) AS repasses
      FROM repasses_recebedor r
      INNER JOIN campanhas c ON c.id = r.id_campanha AND c.id_plataforma = ${platformId}
      WHERE r.status IN ('aprovado', 'transferindo', 'enviado_ao_banco', 'falhou', 'verificando')
        -- Repasse manual aprovado já carimbado no livro JÁ foi transferido (é saída).
        AND NOT EXISTS (
          SELECT 1 FROM lancamentos_financeiros l
          WHERE l.id_repasse = r.id AND l.transferido_em IS NOT NULL
        )
      GROUP BY 1
    `.execute(trx);
    const pend = (grupo: string): PendenteCaixa => {
      const row = pendRes.rows.find((r) => r.grupo === grupo);
      return row
        ? { cents: inteiro(row.cents, `pend.${grupo}`), repasses: inteiro(row.repasses, `pend.${grupo}.n`) }
        : { cents: 0, repasses: 0 };
    };

    // ── Série ─────────────────────────────────────────────────────────
    const porBucket = new Map<
      string,
      { bruto: number; estornos: number; saidas: number }
    >();
    const bucketDe = (dia: string) => inicioDoBucket(dia, granularidade as CaixaGranularidade);
    const acumula = (dia: string) => {
      const chave = bucketDe(dia);
      let acc = porBucket.get(chave);
      if (!acc) {
        acc = { bruto: 0, estornos: 0, saidas: 0 };
        porBucket.set(chave, acc);
      }
      return acc;
    };
    for (const row of diasEntradaRes.rows) {
      const v = entradaValores(row, `dia.${row.dia}`);
      const acc = acumula(row.dia);
      acc.bruto += v.brutoCents;
      acc.estornos += v.estornosCents;
    }
    for (const row of diasSaidaRes.rows) {
      acumula(row.dia).saidas += inteiro(row.cents, `dia.saida.${row.dia}`);
    }
    const serie: SerieBucketCaixa[] = grade.buckets.map((bucket) => {
      const acc = porBucket.get(bucket.inicio) ?? { bruto: 0, estornos: 0, saidas: 0 };
      return {
        ...bucket,
        entradasBrutasCents: acc.bruto,
        estornosCents: acc.estornos,
        entradasLiquidasCents: acc.bruto - acc.estornos,
        saidasCents: acc.saidas,
        saldoCents: acc.bruto - acc.estornos - acc.saidas,
      };
    });

    const entradasTotal = entradaValores(total, "total");
    const saidasCents = inteiro(saidaTotal.cents, "saida.total");
    const totalPagoDosPagamentosCents = inteiro(totalPagoRes.rows[0]?.total_pago, "total_pago");
    const totalDosRepassesCents = inteiro(saidaTotal.repasses_cents, "repasses_cents");
    const somaSerie: SomaCaixa = {
      entradasBrutasCents: serie.reduce((a, b) => a + b.entradasBrutasCents, 0),
      estornosCents: serie.reduce((a, b) => a + b.estornosCents, 0),
      saidasCents: serie.reduce((a, b) => a + b.saidasCents, 0),
    };
    const totalIndependente: SomaCaixa = {
      entradasBrutasCents: entradasTotal.brutoCents,
      estornosCents: entradasTotal.estornosCents,
      saidasCents,
    };

    return {
      snapshotAt,
      timezone: RECEITA_TIMEZONE,
      hoje: localDateInSaoPaulo(input.now),
      periodo,
      entradas: {
        ...entradasTotal,
        pagamentos: inteiro(total.pagamentos, "total.pagamentos"),
        porMetodo,
      },
      saidas: {
        totalCents: saidasCents,
        repasses: inteiro(saidaTotal.repasses, "saida.repasses"),
        porMetodo: saidaPorMetodo,
      },
      pendentes: {
        aprovadosNaoTransferidos: pend("aprovado"),
        emVerificacao: pend("verificacao"),
      },
      saldoCents: entradasTotal.liquidoCents - saidasCents,
      serie,
      conciliacao: {
        totalIndependente,
        somaSerie,
        totalPagoDosPagamentosCents,
        totalDosRepassesCents,
        diferencas: {
          entradasBrutasCents: totalIndependente.entradasBrutasCents - somaSerie.entradasBrutasCents,
          estornosCents: totalIndependente.estornosCents - somaSerie.estornosCents,
          saidasCents: totalIndependente.saidasCents - somaSerie.saidasCents,
          totalPagoCents: totalPagoDosPagamentosCents - entradasTotal.brutoCents,
          repassesCents: totalDosRepassesCents - saidasCents,
        },
      },
    };
  });
}
