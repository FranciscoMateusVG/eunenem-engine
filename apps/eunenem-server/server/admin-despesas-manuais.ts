import { sql } from "kysely";
import type { Database } from "../../../src/adapters/database.js";
import {
  type DespesaManual,
  type Recorrencia,
  type VigenciaValor,
  valorVigente,
} from "../pages/lib/despesasManuais.js";

/**
 * Admin — despesas recorrentes/manuais (aperture-0ngn4).
 *
 * Cadastro feito à mão no admin: servidores, ferramentas, assinaturas. Valor
 * conhecido, por isso sempre "confirmado" na aba Despesas. As ocorrências não
 * são gravadas: são derivadas por `diasManuais` (lib pura) a partir da
 * recorrência e das vigências de valor.
 *
 * Nada é reescrito: mudar o valor insere uma vigência nova, posterior à
 * última; encerrar grava `fim` uma vez. Não há exclusão.
 */


export class DespesaManualInvalida extends Error {}
export class DespesaManualNaoEncontrada extends Error {}
export class DespesaManualJaEncerrada extends Error {}

export interface DespesaManualListada extends DespesaManual {
  /** Valor vigente hoje (SP); antes do início, o primeiro valor. */
  readonly valorAtualCents: number;
  readonly criadoEm: Date;
}

interface DespesaRow {
  id: string;
  nome: string;
  categoria: string | null;
  recorrencia: string;
  dia_cobranca: number | null;
  inicio: string | null;
  fim: string | null;
  data: string | null;
  criado_em: Date;
}

interface ValorRow {
  despesa_id: string;
  vigente_desde: string;
  amount_cents: string | number;
}

function toRecorrencia(value: string): Recorrencia {
  if (value === "mensal" || value === "unica") return value;
  throw new Error("admin_despesas_manuais_recorrencia_invalida");
}

function toCents(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("admin_despesas_manuais_valor_invalido");
  return n;
}

/** Todas as despesas manuais da plataforma, com as vigências em ordem. */
export async function carregarDespesasManuais(
  db: Database,
  platformId: string,
): Promise<(DespesaManual & { readonly criadoEm: Date })[]> {
  const despesas = await sql<DespesaRow>`
    SELECT id, nome, categoria, recorrencia, dia_cobranca,
      to_char(inicio, 'YYYY-MM-DD') AS inicio,
      to_char(fim, 'YYYY-MM-DD') AS fim,
      to_char(data, 'YYYY-MM-DD') AS data,
      criado_em
    FROM despesas_manuais
    WHERE id_plataforma = ${platformId}::uuid AND excluida_em IS NULL
    ORDER BY criado_em, id
  `.execute(db);
  const valores = await sql<ValorRow>`
    SELECT v.despesa_id, to_char(v.vigente_desde, 'YYYY-MM-DD') AS vigente_desde, v.amount_cents
    FROM despesas_manuais_valores v
    JOIN despesas_manuais d ON d.id = v.despesa_id
    WHERE d.id_plataforma = ${platformId}::uuid AND d.excluida_em IS NULL
    ORDER BY v.despesa_id, v.vigente_desde
  `.execute(db);
  const porDespesa = new Map<string, VigenciaValor[]>();
  for (const v of valores.rows) {
    const lista = porDespesa.get(v.despesa_id) ?? [];
    lista.push({ vigenteDesde: v.vigente_desde, valorCents: toCents(v.amount_cents) });
    porDespesa.set(v.despesa_id, lista);
  }
  return despesas.rows.map((d) => ({
    id: d.id,
    nome: d.nome,
    categoria: d.categoria,
    recorrencia: toRecorrencia(d.recorrencia),
    diaCobranca: d.dia_cobranca,
    inicio: d.inicio,
    fim: d.fim,
    data: d.data,
    valores: porDespesa.get(d.id) ?? [],
    criadoEm: d.criado_em,
  }));
}

export async function listarDespesasManuais(
  db: Database,
  input: { readonly platformId: string; readonly hoje: string },
): Promise<DespesaManualListada[]> {
  const despesas = await carregarDespesasManuais(db, input.platformId);
  return despesas.map((d) => ({
    ...d,
    valorAtualCents: valorVigente(d.valores, input.hoje) ?? d.valores[0]?.valorCents ?? 0,
  }));
}

export type TipoDespesaManual =
  | {
      readonly recorrencia: "mensal";
      readonly diaCobranca: number;
      readonly inicio: string;
      readonly fim?: string | undefined;
    }
  | { readonly recorrencia: "unica"; readonly data: string };

export async function criarDespesaManual(
  db: Database,
  input: {
    readonly platformId: string;
    readonly nome: string;
    readonly categoria?: string | null | undefined;
    readonly valorCents: number;
    readonly tipo: TipoDespesaManual;
  },
): Promise<{ id: string }> {
  const nome = input.nome.trim();
  const categoria = input.categoria?.trim() || null;
  if (!nome) throw new DespesaManualInvalida("nome_obrigatorio");
  const t = input.tipo;
  if (t.recorrencia === "mensal") {
    if (t.diaCobranca < 1 || t.diaCobranca > 28) {
      throw new DespesaManualInvalida("dia_cobranca_invalido");
    }
    if (t.fim && t.fim < t.inicio) throw new DespesaManualInvalida("fim_antes_do_inicio");
  }
  const primeiraVigencia = t.recorrencia === "mensal" ? t.inicio : t.data;
  return db.transaction().execute(async (trx) => {
    const res = await sql<{ id: string }>`
      INSERT INTO despesas_manuais
        (id_plataforma, nome, categoria, recorrencia, dia_cobranca, inicio, fim, data)
      VALUES (
        ${input.platformId}::uuid, ${nome}, ${categoria}, ${t.recorrencia},
        ${t.recorrencia === "mensal" ? t.diaCobranca : null},
        ${t.recorrencia === "mensal" ? t.inicio : null}::date,
        ${t.recorrencia === "mensal" ? (t.fim ?? null) : null}::date,
        ${t.recorrencia === "unica" ? t.data : null}::date
      )
      RETURNING id
    `.execute(trx);
    const id = res.rows[0]?.id;
    if (!id) throw new Error("admin_despesas_manuais_insert_sem_id");
    await sql`
      INSERT INTO despesas_manuais_valores (despesa_id, vigente_desde, amount_cents)
      VALUES (${id}::uuid, ${primeiraVigencia}::date, ${input.valorCents})
    `.execute(trx);
    return { id };
  });
}

/** Bloqueia a linha da despesa (FOR UPDATE) e devolve a forma dela. */
async function travar(trx: Database, platformId: string, id: string) {
  const res = await sql<{
    recorrencia: string;
    inicio: string | null;
    fim: string | null;
    ultima_vigencia: string | null;
  }>`
    SELECT d.recorrencia,
      to_char(d.inicio, 'YYYY-MM-DD') AS inicio,
      to_char(d.fim, 'YYYY-MM-DD') AS fim,
      (SELECT to_char(MAX(v.vigente_desde), 'YYYY-MM-DD')
        FROM despesas_manuais_valores v WHERE v.despesa_id = d.id) AS ultima_vigencia
    FROM despesas_manuais d
    WHERE d.id = ${id}::uuid AND d.id_plataforma = ${platformId}::uuid AND d.excluida_em IS NULL
    FOR UPDATE OF d
  `.execute(trx);
  const row = res.rows[0];
  if (!row) throw new DespesaManualNaoEncontrada("despesa_nao_encontrada");
  return row;
}

export async function alterarValorDespesaManual(
  db: Database,
  input: {
    readonly platformId: string;
    readonly id: string;
    readonly valorCents: number;
    readonly vigenteDesde: string;
  },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const d = await travar(trx, input.platformId, input.id);
    if (d.recorrencia !== "mensal") {
      throw new DespesaManualInvalida("despesa_unica_nao_tem_vigencia");
    }
    if (d.ultima_vigencia && input.vigenteDesde <= d.ultima_vigencia) {
      throw new DespesaManualInvalida("vigencia_deve_ser_posterior_a_ultima");
    }
    if (d.fim && input.vigenteDesde > d.fim) {
      throw new DespesaManualInvalida("vigencia_depois_do_fim");
    }
    await sql`
      INSERT INTO despesas_manuais_valores (despesa_id, vigente_desde, amount_cents)
      VALUES (${input.id}::uuid, ${input.vigenteDesde}::date, ${input.valorCents})
    `.execute(trx);
  });
}

export async function encerrarDespesaManual(
  db: Database,
  input: { readonly platformId: string; readonly id: string; readonly fim: string },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const d = await travar(trx, input.platformId, input.id);
    if (d.recorrencia !== "mensal") throw new DespesaManualInvalida("despesa_unica_nao_encerra");
    if (d.fim) throw new DespesaManualJaEncerrada("despesa_ja_encerrada");
    if (d.inicio && input.fim < d.inicio) throw new DespesaManualInvalida("fim_antes_do_inicio");
    await sql`
      UPDATE despesas_manuais SET fim = ${input.fim}::date, encerrado_em = now()
      WHERE id = ${input.id}::uuid
    `.execute(trx);
  });
}


/** O ator vem exclusivamente da sessão admin. Sem FK: auditoria sobrevive à remoção do usuário. */
export async function excluirDespesaManual(db: Database, input: {platformId:string;id:string;actorId:string}):Promise<void> {
  await db.transaction().execute(async trx=>{
    await travar(trx,input.platformId,input.id);
    await sql`UPDATE despesas_manuais SET excluida_em=now(),excluida_por=${input.actorId}::uuid
      WHERE id=${input.id}::uuid AND id_plataforma=${input.platformId}::uuid`.execute(trx);
  });
}
