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
import {
  isLocalDate,
  localDateInSaoPaulo,
  RECEITA_TIMEZONE,
} from "../pages/lib/receitaPeriodo.js";
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
 * SAÍDAS (aperture-9nmdo): os RESGATES da tela /admin/repasses cuja
 * transferência o banco aceitou — não há confirmação de liquidação, então
 * aceito pelo banco = pago. Valor = `repasses_recebedor.amount_cents` (o mesmo
 * da tela de resgates). Mapeamento de status:
 *   enviado_ao_banco                 → saída (Inter aceito)
 *   pago                             → saída
 *   aprovado COM bank_transfer_ref   → saída (manual, TED/PIX feito à mão)
 *   aprovado sem ref / transferindo / falhou → pendente "aprovados não transferidos"
 *   verificando                      → pendente "em verificação"
 *   solicitado / cancelado           → nada
 * Data da saída = quando o banco aceitou: `enviado_ao_banco_em`; sem ela (pago
 * direto, manual), o primeiro `transferido_em` do livro; sem carimbo, `aprovado_em`.
 * Método: com `inter_codigo_solicitacao` = Inter; sem = manual.
 * A mesma consulta (`resgatesEfetuados`) alimenta o filtro de período da tela
 * de resgates, então os dois números são iguais por construção.
 *
 * PENDENTE (fotografia de agora, independe do período e NUNCA entra em
 * saída/saldo; aprovado carimbado sem referência/envio FICA pendente).
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

/** Um resgate aceito pelo banco no período: uma linha da tela de resgates. */
export interface ResgateEfetuado {
  readonly idRepasse: string;
  readonly idCampanha: string;
  readonly campanhaTitulo: string;
  readonly recebedorNome: string | null;
  readonly amountCents: number;
  readonly status: string;
  readonly metodo: MetodoSaida;
  readonly bankTransferRef: string | null;
  /** Quando o banco aceitou a transferência (ver cabeçalho). */
  readonly efetuadoEm: Date;
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
    /** Os resgates que compõem `totalCents`, ordenados pela data do aceite. */
    readonly resgates: readonly ResgateEfetuado[];
  };
  readonly pendentes: {
    readonly aprovadosNaoTransferidos: PendenteCaixa;
    readonly emVerificacao: PendenteCaixa;
    /** Aprovado e carimbado transferido SEM envio nem referência (#284): conferir. */
    readonly semComprovante: PendenteCaixa;
  };
  /** Entradas líquidas − saídas. Pendente não entra. */
  readonly saldoCents: number;
  readonly serie: readonly SerieBucketCaixa[];
  readonly conciliacao: {
    readonly totalIndependente: SomaCaixa;
    readonly somaSerie: SomaCaixa;
    /** SUM(pagamentos.intencao_total_paid_cents) dos pagamentos com entrada no período. */
    readonly totalPagoDosPagamentosCents: number;
    /** Lançamentos de presente do livro ligados aos resgates do período. */
    readonly totalNoLivroDosResgatesCents: number;
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

/**
 * Resgate cuja transferência o banco aceitou (ver mapeamento no cabeçalho).
 * `aprovado` SEM referência e SEM envio (inclusive o carimbado do #284) não é.
 */
const REPASSE_ACEITO = sql`(
  r.status IN ('enviado_ao_banco', 'pago')
  OR (r.status = 'aprovado' AND r.bank_transfer_ref IS NOT NULL)
)`;

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

/** Resgates aceitos pelo banco no período, um por linha, com a data do aceite. */
function resgatesEfetuados(platformId: string, de: string, ate: string) {
  return sql`(
    SELECT
      r.id AS id_repasse,
      r.id_campanha,
      c.titulo AS campanha_titulo,
      (SELECT rc.nome_titular FROM recebedores rc
        WHERE rc.campanha_id = r.id_campanha AND rc.is_active
        ORDER BY rc.id LIMIT 1) AS recebedor_nome,
      r.amount_cents,
      r.status,
      r.bank_transfer_ref,
      CASE WHEN r.inter_codigo_solicitacao IS NOT NULL THEN 'inter' ELSE 'manual' END AS metodo,
      a.efetuado_em,
      ${diaLocal("a.efetuado_em")} AS dia,
      (SELECT COALESCE(SUM(l.amount_cents), 0) FROM lancamentos_financeiros l
        WHERE l.id_repasse = r.id AND l.tipo = ${sql.lit(TIPO_PRESENTE)}
          AND (l.cancelado_em IS NULL OR l.transferido_em IS NOT NULL)) AS livro_cents
    FROM repasses_recebedor r
    INNER JOIN campanhas c ON c.id = r.id_campanha AND c.id_plataforma = ${platformId}
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        r.enviado_ao_banco_em,
        (SELECT MIN(l.transferido_em) FROM lancamentos_financeiros l WHERE l.id_repasse = r.id),
        r.aprovado_em
      ) AS efetuado_em
    ) a
    WHERE ${REPASSE_ACEITO}
      AND a.efetuado_em >= ${corte(de)} AND a.efetuado_em < ${corte(ate)}
  )`;
}

interface ResgateRow {
  id_repasse: string;
  id_campanha: string;
  campanha_titulo: string;
  recebedor_nome: string | null;
  amount_cents: string | number;
  status: string;
  bank_transfer_ref: string | null;
  metodo: string;
  efetuado_em: Date;
  dia: string;
  livro_cents: string | number;
}

/**
 * Resgates aceitos pelo banco em [de, ate) (datas locais de SP). Fonte única
 * das saídas do caixa e do filtro de período da tela de resgates.
 */
export async function listarResgatesEfetuados(
  db: Database,
  input: { readonly platformId: string; readonly de: string; readonly ate: string },
): Promise<(ResgateEfetuado & { readonly dia: string; readonly livroCents: number })[]> {
  if (!isLocalDate(input.de) || !isLocalDate(input.ate) || input.de >= input.ate) {
    throw new InvalidCaixaPeriodoError(input.de >= input.ate ? "intervalo_vazio" : "data_invalida");
  }
  const res = await sql<ResgateRow>`
    SELECT * FROM ${resgatesEfetuados(input.platformId, input.de, input.ate)} s
    ORDER BY s.efetuado_em, s.id_repasse
  `.execute(db);
  return res.rows.map((row) => ({
    idRepasse: row.id_repasse,
    idCampanha: row.id_campanha,
    campanhaTitulo: row.campanha_titulo,
    recebedorNome: row.recebedor_nome,
    amountCents: inteiro(row.amount_cents, `resgate.${row.id_repasse}`),
    status: row.status,
    metodo: row.metodo === "inter" ? "inter" : "manual",
    bankTransferRef: row.bank_transfer_ref,
    efetuadoEm: row.efetuado_em,
    dia: row.dia,
    livroCents: inteiro(row.livro_cents, `resgate.${row.id_repasse}.livro`),
  }));
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

    // ── Saídas: os resgates aceitos no período + total independente ────
    const resgates = await listarResgatesEfetuados(trx, { platformId, de, ate });
    const saidaTotalRes = await sql<{ cents: string | number }>`
      SELECT COALESCE(SUM(s.amount_cents), 0)::bigint AS cents
      FROM ${resgatesEfetuados(platformId, de, ate)} s
    `.execute(trx);
    const saidasCents = inteiro(saidaTotalRes.rows[0]?.cents, "saida.total");
    const saidaPorMetodo: Record<MetodoSaida, SaidaMetodo> = {
      inter: { cents: 0, repasses: 0 },
      manual: { cents: 0, repasses: 0 },
    };
    for (const r of resgates) {
      const m = saidaPorMetodo[r.metodo];
      saidaPorMetodo[r.metodo] = { cents: m.cents + r.amountCents, repasses: m.repasses + 1 };
    }
    const totalNoLivroDosResgatesCents = resgates.reduce((a, r) => a + r.livroCents, 0);

    // ── Pendentes: fotografia de agora, independe do período ──────────
    const pendRes = await sql<{ grupo: string; cents: string | number; repasses: string | number }>`
      SELECT
        CASE
          WHEN r.status = 'verificando' THEN 'verificacao'
          WHEN r.status = 'aprovado' AND r.bank_transfer_ref IS NULL
            AND r.inter_codigo_solicitacao IS NULL AND EXISTS (
              SELECT 1 FROM lancamentos_financeiros l
              WHERE l.id_repasse = r.id AND l.transferido_em IS NOT NULL
            ) THEN 'sem_comprovante'
          ELSE 'aprovado'
        END AS grupo,
        COALESCE(SUM(r.amount_cents), 0)::bigint AS cents,
        COUNT(*) AS repasses
      FROM repasses_recebedor r
      INNER JOIN campanhas c ON c.id = r.id_campanha AND c.id_plataforma = ${platformId}
      WHERE r.status IN ('aprovado', 'transferindo', 'falhou', 'verificando')
        -- Aceito pelo banco (manual com referência) é saída, não pendente.
        AND NOT ${REPASSE_ACEITO}
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
    for (const r of resgates) {
      acumula(r.dia).saidas += r.amountCents;
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
    const totalPagoDosPagamentosCents = inteiro(totalPagoRes.rows[0]?.total_pago, "total_pago");
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
        repasses: resgates.length,
        porMetodo: saidaPorMetodo,
        resgates: resgates.map(({ dia: _dia, livroCents: _livro, ...r }) => r),
      },
      pendentes: {
        aprovadosNaoTransferidos: pend("aprovado"),
        emVerificacao: pend("verificacao"),
        semComprovante: pend("sem_comprovante"),
      },
      saldoCents: entradasTotal.liquidoCents - saidasCents,
      serie,
      conciliacao: {
        totalIndependente,
        somaSerie,
        totalPagoDosPagamentosCents,
        totalNoLivroDosResgatesCents,
        diferencas: {
          entradasBrutasCents: totalIndependente.entradasBrutasCents - somaSerie.entradasBrutasCents,
          estornosCents: totalIndependente.estornosCents - somaSerie.estornosCents,
          saidasCents: totalIndependente.saidasCents - somaSerie.saidasCents,
          totalPagoCents: totalPagoDosPagamentosCents - entradasTotal.brutoCents,
          repassesCents: totalNoLivroDosResgatesCents - saidasCents,
        },
      },
    };
  });
}
