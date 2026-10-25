import { sql } from "kysely";
import type { Database } from "../../../src/adapters/database.js";
import { PROVIDER_FEES_SINCE } from "../../../src/use-cases/pagamentos/provider-fee-sync.js";
import {
  agregarDespesas,
  type ContagemCobertura,
  contarCobertura,
  type DespesasAgregado,
  type DiaCobertura,
  type DiaDespesas,
  type ProvedorDespesa,
  type StatusTarifa,
} from "../pages/lib/despesasPainel.js";
import { diasManuais, diasRecorrentesRateados } from "../pages/lib/despesasManuais.js";
import { gradePainel } from "../pages/lib/receitaPainel.js";
import { addDays, localDateInSaoPaulo, RECEITA_TIMEZONE } from "../pages/lib/receitaPeriodo.js";
import { carregarDespesasManuais } from "./admin-despesas-manuais.js";
import { emSnapshotDeLeitura } from "./admin-receita.js";

/**
 * Admin read model — Despesas (aperture-5qoz0 PR3).
 *
 * O QUE É: tarifas de processamento OBSERVADAS no provedor
 * (`provider_fee_events`, gravadas pelo sync do PR1/PR2), datadas pelo débito
 * (`occurred_at`), em dias locais de São Paulo e na mesma grade da Receita 1b.
 *
 * O QUE NÃO É: estimativa. Pagamento sem tarifa observada não vira R$ 0 —
 * aparece pendente/falho, exceto franquia Inter observada após scan OK e 72h.
 * Nenhuma chamada a provedor.
 *
 * ESCOPO: evento com `payment_id` só conta se o pagamento resolve para uma
 * campanha DESTA plataforma. Evento sem `payment_id` (ex.: tarifa Inter sem
 * endToEndId correspondente) fica FORA do total, mas é devolvido à parte
 * (`naoVinculadas`) para nada ficar invisível; a plataforma dele não é
 * provável.
 *
 * COBERTURA (por pagamento elegível, datado pelo dia do PAGAMENTO):
 *   Stripe — status do `provider_fee_sync`; sem linha de sync = pendente.
 *   Inter — tarifa vinculada tem precedência. Scan OK da conta + 72h desde
 *            pagamento + E2E válido sem tarifa: zero observado (franquia).
 *            É derivado, não grava evento fictício; tarifa posterior substitui.
 *            Scan esgotado com erro = falha; demais casos = pendente.
 * Cada bucket exibido (KPIs, meses, semanas) recebe a sua contagem.
 *
 * MANUAIS (aperture-0ngn4): despesas recorrentes/manuais cadastradas no
 * admin (`despesas_manuais`), série própria `manualCents`, sempre confirmada
 * e incluída em `totalCents`. Ocorrência só conta quando o dia de cobrança já
 * chegou (≤ hoje em SP). Ver `admin-despesas-manuais.ts`.
 *
 * SNAPSHOT ÚNICO: as consultas (dias, total independente, cobertura,
 * últimas leituras) rodam na mesma transação REPEATABLE READ + READ ONLY.
 */

/** Data local (SP) a partir da qual o sync coleta tarifas. */
export const DESPESAS_DESDE = localDateInSaoPaulo(PROVIDER_FEES_SINCE);

/**
 * Mesmo universo que `ProviderFeeSync` considera elegível (PR1). O teste de
 * integração compara as contagens com o dry-run do sync para travar isso.
 */
function stripeElegivel(platformId: string) {
  return sql`p.intencao_metodo = 'credit_card'
    AND p.status IN ('aprovado', 'estornado')
    AND p.criado_em >= ${PROVIDER_FEES_SINCE}
    AND p.transacao_externa ->> 'provedor' = 'stripe'
    AND EXISTS (
      SELECT 1 FROM campanhas c
      WHERE c.id = p.intencao_id_campanha AND c.id_plataforma = ${platformId}::uuid
    )`;
}

/** Pagamentos PIX recebidos pelo Inter, no universo do `InterFeeSync` (PR2). */
function interElegivel(platformId: string) {
  return sql`p.intencao_metodo = 'pix'
    AND p.status IN ('aprovado', 'estornado')
    AND p.criado_em >= ${PROVIDER_FEES_SINCE}
    AND p.transacao_externa ->> 'provedor' = 'inter'
    AND EXISTS (
      SELECT 1 FROM campanhas c
      WHERE c.id = p.intencao_id_campanha AND c.id_plataforma = ${platformId}::uuid
    )`;
}

function corte(data: string) {
  return sql`((${data}::date)::timestamp AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)})`;
}

/** Eventos da janela: vinculados à plataforma OU sem vínculo nenhum. */
function eventosDaJanela(platformId: string, de: string, ate: string) {
  return sql`(
    SELECT
      e.provider,
      e.amount_cents,
      e.occurred_at,
      (e.payment_id IS NOT NULL) AS vinculada
    FROM provider_fee_events e
    LEFT JOIN pagamentos p ON p.id = e.payment_id
    LEFT JOIN campanhas c
      ON c.id = p.intencao_id_campanha
     AND c.id_plataforma = ${platformId}
    WHERE e.occurred_at >= ${corte(de)}
      AND e.occurred_at < ${corte(ate)}
      AND (e.payment_id IS NULL OR c.id IS NOT NULL)
  )`;
}

const SOMAS = sql`
  COALESCE(SUM(e.amount_cents) FILTER (WHERE e.vinculada AND e.provider = 'stripe'), 0)::bigint
    AS stripe,
  COALESCE(SUM(e.amount_cents) FILTER (WHERE e.vinculada AND e.provider = 'inter'), 0)::bigint
    AS inter,
  COUNT(*) FILTER (WHERE NOT e.vinculada) AS nao_vinculadas_n,
  COALESCE(SUM(e.amount_cents) FILTER (WHERE NOT e.vinculada), 0)::bigint
    AS nao_vinculadas`;

interface SomasRow {
  stripe: string | number;
  inter: string | number;
  nao_vinculadas_n: string | number;
  nao_vinculadas: string | number;
}

function naoNegativo(value: string | number | null | undefined, campo: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`admin_despesas_valor_invalido:${campo}`);
  }
  return parsed;
}

function toDia(row: SomasRow & { dia: string }): DiaDespesas {
  return {
    dia: row.dia,
    stripeCents: naoNegativo(row.stripe, "dia.stripe"),
    interCents: naoNegativo(row.inter, "dia.inter"),
    naoVinculadas: naoNegativo(row.nao_vinculadas_n, "dia.nao_vinculadas_n"),
    naoVinculadasCents: naoNegativo(row.nao_vinculadas, "dia.nao_vinculadas"),
  };
}

function toProvedor(value: string): ProvedorDespesa {
  if (value === "stripe" || value === "inter") return value;
  throw new Error("admin_despesas_provedor_invalido");
}

function toStatus(value: string): StatusTarifa {
  if (value === "confirmed" || value === "failed" || value === "no_fee") return value;
  return "pending";
}

export interface CoberturaDespesas {
  /** Todos os elegíveis desde `desde` (a coleta começa aí). */
  readonly desdeInicio: ContagemCobertura;
  readonly desde: string;
  /** Última tentativa/scan bem-sucedido ou observação gravada. */
  readonly ultimaLeituraEm: Date | null;
}

export interface DespesasPainel extends DespesasAgregado {
  readonly snapshotAt: Date;
  readonly timezone: typeof RECEITA_TIMEZONE;
  readonly hoje: string;
  readonly janela: { readonly de: string; readonly ate: string };
  readonly cobertura: { readonly stripe: CoberturaDespesas; readonly inter: CoberturaDespesas };
  /** SUM independente da janela − soma dos dias. Exibir quando ≠ 0. */
  readonly diferencaConciliacao: {
    readonly stripeCents: number;
    readonly interCents: number;
    readonly naoVinculadasCents: number;
  };
}

function maisRecente(...datas: readonly (Date | string | null | undefined)[]): Date | null {
  let max: Date | null = null;
  for (const d of datas) {
    if (!d) continue;
    const data = new Date(d);
    if (!max || data > max) max = data;
  }
  return max;
}

export async function loadDespesasPainel(
  db: Database,
  input: {
    readonly platformId: string;
    readonly now: Date;
    /**
     * Conta Inter que o sync lê (`deps.interFeeAccountRef`). Scans e leituras
     * de outra conta não entram na cobertura; null (sem credenciais) ⇒ nenhum
     * scan conta: nada vira falha nem leitura, o não confirmado é pendente.
     */
    readonly interAccountRef: string | null;
  },
): Promise<DespesasPainel> {
  const { platformId } = input;
  // NULL nunca é igual a nada em SQL: sem conta, nenhum scan casa.
  const interConta = input.interAccountRef;
  const grade = gradePainel(localDateInSaoPaulo(input.now));
  const { janela } = grade;

  return emSnapshotDeLeitura(db, async (trx, snapshotAt) => {
    const diasRes = await sql<SomasRow & { dia: string }>`
      SELECT
        to_char(e.occurred_at AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)}, 'YYYY-MM-DD') AS dia,
        ${SOMAS}
      FROM ${eventosDaJanela(platformId, janela.de, janela.ate)} e
      GROUP BY 1
      ORDER BY 1
    `.execute(trx);
    const dias = diasRes.rows.map(toDia);

    const totalRes = await sql<SomasRow>`
      SELECT ${SOMAS} FROM ${eventosDaJanela(platformId, janela.de, janela.ate)} e
    `.execute(trx);
    const total = totalRes.rows[0];
    if (!total) throw new Error("admin_despesas_total_sem_linha");

    const coberturaRes = await sql<{
      provedor: string;
      dia: string;
      status: string;
      pagamentos: string | number;
    }>`
      WITH stripe AS (
        SELECT
          to_char(p.criado_em AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)}, 'YYYY-MM-DD') AS dia,
          COALESCE(s.status, 'pending') AS status
        FROM pagamentos p
        LEFT JOIN provider_fee_sync s ON s.payment_id = p.id
        WHERE ${stripeElegivel(platformId)}
      ),
      inter AS (
        SELECT
          to_char(p.criado_em AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)}, 'YYYY-MM-DD') AS dia,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM provider_fee_events e
              WHERE e.payment_id = p.id AND e.provider = 'inter'
            ) THEN 'confirmed'
            WHEN p.criado_em <= ${input.now}::timestamptz - interval '72 hours'
              AND p.intencao_e2e_external_ref ~ '^[A-Za-z0-9]{32}$'
              AND EXISTS (
                SELECT 1 FROM provider_fee_inter_scans x
                WHERE x.account_ref = ${interConta}
                  AND x.day = (p.criado_em AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)})::date
                  AND x.last_success_at IS NOT NULL AND x.last_reason IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM provider_fee_events e
                WHERE e.provider = 'inter' AND e.account_ref = ${interConta}
                  AND e.matching_ref = p.intencao_e2e_external_ref
              ) THEN 'no_fee'
            WHEN EXISTS (
              SELECT 1 FROM provider_fee_inter_scans x
              WHERE x.account_ref = ${interConta}
                AND x.day = (p.criado_em AT TIME ZONE ${sql.lit(RECEITA_TIMEZONE)})::date
                AND x.attempts >= 8 AND x.last_reason IS NOT NULL
            ) THEN 'failed'
            ELSE 'pending'
          END AS status
        FROM pagamentos p
        WHERE ${interElegivel(platformId)}
      )
      SELECT 'stripe' AS provedor, dia, status, COUNT(*) AS pagamentos
      FROM stripe GROUP BY dia, status
      UNION ALL
      SELECT 'inter' AS provedor, dia, status, COUNT(*) AS pagamentos
      FROM inter GROUP BY dia, status
    `.execute(trx);
    const diasCobertura: DiaCobertura[] = coberturaRes.rows.map((row) => ({
      dia: row.dia,
      provedor: toProvedor(row.provedor),
      status: toStatus(row.status),
      pagamentos: naoNegativo(row.pagamentos, "cobertura.pagamentos"),
    }));
    const cadastros = await carregarDespesasManuais(trx, platformId);
    const intervaloReal = {
      de: janela.de,
      // Cobrança futura ainda não é despesa.
      ate: addDays(grade.hoje, 1) < janela.ate ? addDays(grade.hoje, 1) : janela.ate,
    };
    const manuais = diasManuais(cadastros, intervaloReal);
    const semanaManuais = [
      ...diasManuais(cadastros.filter(d => d.recorrencia === "unica"), intervaloReal),
      ...diasRecorrentesRateados(cadastros, janela, grade.hoje),
    ];
    const metas = diasRecorrentesRateados(cadastros, janela);
    const agregado = agregarDespesas(grade, dias, diasCobertura, manuais, semanaManuais, metas);

    const leiturasRes = await sql<{
      stripe_sync_em: Date | null;
      stripe_observado_em: Date | null;
      inter_scan_em: Date | null;
      inter_observado_em: Date | null;
    }>`
      SELECT
        (SELECT MAX(s.updated_at) FROM provider_fee_sync s
          JOIN pagamentos p ON p.id = s.payment_id
          WHERE ${stripeElegivel(platformId)}) AS stripe_sync_em,
        (SELECT MAX(e.observed_at) FROM provider_fee_events e
          JOIN pagamentos p ON p.id = e.payment_id
          JOIN campanhas c ON c.id = p.intencao_id_campanha AND c.id_plataforma = ${platformId}
          WHERE e.provider = 'stripe') AS stripe_observado_em,
        (SELECT MAX(x.last_success_at) FROM provider_fee_inter_scans x
          WHERE x.account_ref = ${interConta}) AS inter_scan_em,
        (SELECT MAX(e.observed_at) FROM provider_fee_events e
          WHERE e.provider = 'inter' AND e.account_ref = ${interConta}) AS inter_observado_em
    `.execute(trx);
    const leituras = leiturasRes.rows[0];

    return {
      ...agregado,
      snapshotAt,
      timezone: RECEITA_TIMEZONE,
      hoje: grade.hoje,
      janela,
      cobertura: {
        stripe: {
          desdeInicio: contarCobertura(diasCobertura, "stripe"),
          desde: DESPESAS_DESDE,
          ultimaLeituraEm: maisRecente(leituras?.stripe_sync_em, leituras?.stripe_observado_em),
        },
        inter: {
          desdeInicio: contarCobertura(diasCobertura, "inter"),
          desde: DESPESAS_DESDE,
          ultimaLeituraEm: maisRecente(leituras?.inter_scan_em, leituras?.inter_observado_em),
        },
      },
      diferencaConciliacao: {
        stripeCents: naoNegativo(total.stripe, "total.stripe") - agregado.somaDosDias.stripeCents,
        interCents: naoNegativo(total.inter, "total.inter") - agregado.somaDosDias.interCents,
        naoVinculadasCents:
          naoNegativo(total.nao_vinculadas, "total.nao_vinculadas") -
          agregado.somaDosDias.naoVinculadasCents,
      },
    };
  });
}
