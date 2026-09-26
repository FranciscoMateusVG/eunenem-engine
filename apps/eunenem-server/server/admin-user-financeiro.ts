import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../../../src/adapters/database.js";
import {
  predicadoEstornoAtivoLancamento,
  predicadoLancamentoDisponivel,
} from "../../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js";
import {
  type BucketAdmin,
  BUCKETS_ADMIN,
  type ClassificacaoAdmin,
  classificarBucketAdmin,
  type FatosLancamentoAdmin,
} from "./extrato/classificador-admin.js";

/**
 * Admin read model — detalhe financeiro de um usuário (aperture-5jk8y).
 *
 * Leitura pura sobre `deps.db`, no padrão de `admin-payment-evidence.ts`.
 * Nenhuma mutação, nenhum provider, nenhum botão.
 *
 * SNAPSHOT ÚNICO (decisão root y6lmbv): as consultas A (fatos), B (metadados
 * por campanha) e C (SUM independente para cross-check) rodam na MESMA
 * transação `REPEATABLE READ` + `READ ONLY`, sobre o mesmo handle. Nada é
 * lido pelo client global fora do snapshot. Totais e cross-check cobrem o
 * conjunto COMPLETO (sem LIMIT); LIMIT só existe na listagem, com truncamento
 * declarado.
 *
 * GUARDA CANÔNICA (A1.6): `estorno_ativo` e `disponivel_canonico` são
 * computados pelos fragmentos SQL exportados do adapter Postgres desta
 * branch — a MESMA regra que alimenta SOLICITAR. Nenhuma cópia local.
 * Ao promover para main, reextrair do predicado real de main (refund-ops).
 *
 * ESCOPO: campanhas administradas pela conta (`campanha_administradores.
 * id_usuario` armazena `usuarios.id_conta`), DISTINCT, restritas à
 * plataforma. A autorização admin + `findUsuarioByConta` acontecem ANTES
 * no router; este módulo assume um `idConta` já validado.
 */

// ────────────────────────────────────────────────────────────────────
//  Row shapes (SQL → TS)
// ────────────────────────────────────────────────────────────────────

interface FatoRow {
  id_lancamento: string;
  amount_cents: number | string;
  criado_em: Date;
  transferido_em: Date | null;
  cancelado_em: Date | null;
  id_repasse: string | null;
  id_campanha: string;
  id_contribuicao: string;
  id_pagamento: string;
  repasse_status: string | null;
  pagamento_status: string | null;
  available_on: Date | null;
  metodo: string | null;
  pagamento_criado_em: Date | null;
  campanha_titulo: string;
  contribuicao_nome: string | null;
  estorno_ativo: boolean | null;
  disponivel_canonico: boolean | null;
}

interface CampanhaMetaRow {
  id: string;
  titulo: string;
  criada_em: Date;
  administradores:
    | Array<{ idConta: string; nomeExibicao: string | null; email: string | null }>
    | string
    | null;
  celular_titular: string | null;
}

interface SumRow {
  total: number | string | null;
}

// ────────────────────────────────────────────────────────────────────
//  Domain-ish shapes returned to the router
// ────────────────────────────────────────────────────────────────────

export type MetodoPagamentoAdmin = "pix" | "credit_card";

/** Uma linha do ledger com os fatos do classificador + contexto de exibição. */
export interface FatoLancamentoAdmin extends FatosLancamentoAdmin {
  readonly criadoEm: Date;
  readonly pagamentoCriadoEm: Date | null;
  readonly idCampanha: string;
  readonly campanhaTitulo: string;
  readonly idContribuicao: string;
  readonly contribuicaoNome: string | null;
  readonly idPagamento: string;
  readonly metodo: MetodoPagamentoAdmin | null;
}

export interface CoadminAdmin {
  readonly idConta: string;
  readonly nomeExibicao: string | null;
  readonly email: string | null;
}

export interface CampanhaAdministradaMeta {
  readonly idCampanha: string;
  readonly titulo: string;
  readonly criadaEm: Date;
  readonly administradores: readonly CoadminAdmin[];
  /** Celular do titular do recebedor ATIVO, EM CLARO — o router mascara antes do wire. Nunca logar. */
  readonly celularTitularRaw: string | null;
}

export interface AdminUserFinanceiroSnapshot {
  readonly fatos: readonly FatoLancamentoAdmin[];
  readonly campanhas: readonly CampanhaAdministradaMeta[];
  /** SUM SQL independente: p.status='aprovado' ∧ l.cancelado_em IS NULL, mesmo escopo, mesmo snapshot. */
  readonly ledgerAprovadoSemCancelCents: number;
}

function toInt(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toMetodo(v: string | null): MetodoPagamentoAdmin | null {
  return v === "pix" || v === "credit_card" ? v : null;
}

function campanhasAdministradasSubquery(idConta: string) {
  return sql`(
    SELECT DISTINCT ca.campanha_id
      FROM campanha_administradores ca
      WHERE ca.id_usuario = ${idConta}
  )`;
}

// ────────────────────────────────────────────────────────────────────
//  Snapshot loader — one READ ONLY REPEATABLE READ transaction, 3 statements
// ────────────────────────────────────────────────────────────────────

export async function loadAdminUserFinanceiroSnapshot(
  db: Database,
  input: {
    readonly idConta: string;
    readonly platformId: string;
    readonly now: Date;
    /** Quando presente, A é restrita a esta campanha (listagem); B e C continuam sobre a conta inteira. */
    readonly idCampanha?: string | null;
    /** Pular B e C (listagem de lançamentos só precisa de A). */
    readonly somenteFatos?: boolean;
  },
): Promise<AdminUserFinanceiroSnapshot> {
  const { idConta, platformId, now } = input;
  const idCampanha = input.idCampanha ?? null;

  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);

      // A — fatos, sem LIMIT, um fato por linha do ledger.
      const fatosRes = (await sql<FatoRow>`
        SELECT
          l.id AS id_lancamento,
          l.amount_cents,
          l.criado_em,
          l.transferido_em,
          l.cancelado_em,
          l.id_repasse,
          l.id_campanha,
          l.id_contribuicao,
          l.id_pagamento,
          r.status AS repasse_status,
          p.status AS pagamento_status,
          p.intencao_balance_transaction_available_on AS available_on,
          p.intencao_metodo AS metodo,
          p.criado_em AS pagamento_criado_em,
          c.titulo AS campanha_titulo,
          ct.nome AS contribuicao_nome,
          COALESCE(${predicadoEstornoAtivoLancamento()}, FALSE) AS estorno_ativo,
          COALESCE(${predicadoLancamentoDisponivel(now)}, FALSE) AS disponivel_canonico
        FROM lancamentos_financeiros l
        INNER JOIN campanhas c
          ON c.id = l.id_campanha
         AND c.id_plataforma = ${platformId}
        LEFT JOIN pagamentos p ON p.id = l.id_pagamento
        LEFT JOIN repasses_recebedor r ON r.id = l.id_repasse
        LEFT JOIN contribuicoes ct ON ct.id = l.id_contribuicao
        WHERE l.tipo = 'credito_saldo_recebedor'
          AND l.id_campanha IN ${campanhasAdministradasSubquery(idConta)}
          AND (${idCampanha}::uuid IS NULL OR l.id_campanha = ${idCampanha}::uuid)
        ORDER BY l.criado_em DESC, l.id ASC
      `.execute(trx)) as unknown as { rows: FatoRow[] };

      const fatos: FatoLancamentoAdmin[] = fatosRes.rows.map((row) => ({
        idLancamento: row.id_lancamento,
        amountCents: toInt(row.amount_cents),
        criadoEm: new Date(row.criado_em),
        transferidoEm: row.transferido_em ? new Date(row.transferido_em) : null,
        canceladoEm: row.cancelado_em ? new Date(row.cancelado_em) : null,
        idRepasse: row.id_repasse,
        repasseStatus: row.repasse_status,
        pagamentoStatus: row.pagamento_status,
        availableOn: row.available_on ? new Date(row.available_on) : null,
        estornoAtivo: row.estorno_ativo === true,
        disponivelCanonico: row.disponivel_canonico === true,
        pagamentoCriadoEm: row.pagamento_criado_em ? new Date(row.pagamento_criado_em) : null,
        idCampanha: row.id_campanha,
        campanhaTitulo: row.campanha_titulo,
        idContribuicao: row.id_contribuicao,
        contribuicaoNome: row.contribuicao_nome,
        idPagamento: row.id_pagamento,
        metodo: toMetodo(row.metodo),
      }));

      if (input.somenteFatos) {
        return { fatos, campanhas: [], ledgerAprovadoSemCancelCents: 0 };
      }

      // B — metadados por campanha administrada (DISTINCT), coadmins e celular do recebedor ativo.
      const metaRes = (await sql<CampanhaMetaRow>`
        SELECT
          c.id,
          c.titulo,
          c.criada_em,
          (
            SELECT json_agg(
              json_build_object(
                'idConta', ca.id_usuario,
                'nomeExibicao', u.nome_exibicao,
                'email', u.email
              )
              ORDER BY ca.id_usuario
            )
            FROM campanha_administradores ca
            LEFT JOIN usuarios u
              ON u.id_conta = ca.id_usuario
             AND u.id_plataforma = ${platformId}
            WHERE ca.campanha_id = c.id
          ) AS administradores,
          (
            SELECT rc.celular_titular
              FROM recebedores rc
              WHERE rc.campanha_id = c.id
                AND rc.is_active = TRUE
              ORDER BY rc.criada_em DESC, rc.id ASC
              LIMIT 1
          ) AS celular_titular
        FROM campanhas c
        WHERE c.id_plataforma = ${platformId}
          AND c.id IN ${campanhasAdministradasSubquery(idConta)}
        ORDER BY c.criada_em ASC, c.id ASC
      `.execute(trx)) as unknown as { rows: CampanhaMetaRow[] };

      const campanhas: CampanhaAdministradaMeta[] = metaRes.rows.map((row) => {
        const raw =
          typeof row.administradores === "string"
            ? (JSON.parse(row.administradores) as CampanhaMetaRow["administradores"])
            : row.administradores;
        const administradores: CoadminAdmin[] = Array.isArray(raw)
          ? raw.map((a) => ({
              idConta: a.idConta,
              nomeExibicao: a.nomeExibicao ?? null,
              email: a.email ?? null,
            }))
          : [];
        return {
          idCampanha: row.id,
          titulo: row.titulo,
          criadaEm: new Date(row.criada_em),
          administradores,
          celularTitularRaw: row.celular_titular,
        };
      });

      // C — cross-check independente (SUM em SQL; não passa pelo classificador).
      const sumRes = (await sql<SumRow>`
        SELECT COALESCE(SUM(l.amount_cents), 0)::bigint AS total
          FROM lancamentos_financeiros l
          INNER JOIN pagamentos p ON p.id = l.id_pagamento
          INNER JOIN campanhas c
            ON c.id = l.id_campanha
           AND c.id_plataforma = ${platformId}
          WHERE l.tipo = 'credito_saldo_recebedor'
            AND p.status = 'aprovado'
            AND l.cancelado_em IS NULL
            AND l.id_campanha IN ${campanhasAdministradasSubquery(idConta)}
      `.execute(trx)) as unknown as { rows: SumRow[] };

      return {
        fatos,
        campanhas,
        ledgerAprovadoSemCancelCents: toInt(sumRes.rows[0]?.total),
      };
    });
}

// ────────────────────────────────────────────────────────────────────
//  Lançamentos — classificação + keyset determinístico em TS
//
//  Custo honesto: O(M) por página, M = lançamentos da conta (ou da
//  campanha filtrada). A classificação vive em TS (único classificador);
//  totais nunca vêm da página. Ordem: criado_em DESC, id ASC.
// ────────────────────────────────────────────────────────────────────

export const BucketAdminSchema = z.enum(
  BUCKETS_ADMIN as unknown as [BucketAdmin, ...BucketAdmin[]],
);

const LancamentosCursorSchema = z
  .object({
    version: z.literal(1),
    criadoEm: z.string().datetime(),
    idLancamento: z.string().uuid(),
    filtersDigest: z.string().length(43),
  })
  .strict();
type LancamentosCursor = z.infer<typeof LancamentosCursorSchema>;

export class InvalidAdminUserLancamentosCursorError extends Error {
  constructor() {
    super("invalid_admin_user_lancamentos_cursor");
    this.name = "InvalidAdminUserLancamentosCursorError";
  }
}

function lancamentosFiltersDigest(secret: string, value: object): string {
  return createHmac("sha256", secret)
    .update("admin-user-financeiro-lancamentos-cursor:v1\0")
    .update(JSON.stringify(value))
    .digest("base64url");
}

function encodeLancamentosCursor(cursor: LancamentosCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeLancamentosCursor(encoded: string, expectedDigest: string): LancamentosCursor {
  try {
    if (encoded.length === 0 || encoded.length > 1024) {
      throw new InvalidAdminUserLancamentosCursorError();
    }
    const cursor = LancamentosCursorSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (cursor.filtersDigest !== expectedDigest) {
      throw new InvalidAdminUserLancamentosCursorError();
    }
    return cursor;
  } catch (error: unknown) {
    if (error instanceof InvalidAdminUserLancamentosCursorError) throw error;
    throw new InvalidAdminUserLancamentosCursorError();
  }
}

export interface LancamentoAdminClassificado {
  readonly fato: FatoLancamentoAdmin;
  readonly classificacao: ClassificacaoAdmin;
}

/** Comparador canônico: criado_em DESC, id ASC. */
function compareLancamentos(a: FatoLancamentoAdmin, b: FatoLancamentoAdmin): number {
  const dt = b.criadoEm.getTime() - a.criadoEm.getTime();
  if (dt !== 0) return dt;
  return a.idLancamento < b.idLancamento ? -1 : a.idLancamento > b.idLancamento ? 1 : 0;
}

/** True quando `x` vem ESTRITAMENTE depois do cursor na ordem canônica. */
function isAfterCursor(x: FatoLancamentoAdmin, cursor: LancamentosCursor): boolean {
  const cursorMs = new Date(cursor.criadoEm).getTime();
  const xMs = x.criadoEm.getTime();
  if (xMs !== cursorMs) return xMs < cursorMs;
  return x.idLancamento > cursor.idLancamento;
}

export function paginateLancamentosAdmin(input: {
  readonly fatos: readonly FatoLancamentoAdmin[];
  readonly now: Date;
  readonly idConta: string;
  readonly estado: BucketAdmin | null;
  readonly idCampanha: string | null;
  readonly cursor: string | null;
  readonly limit: number;
  readonly cursorSecret: string;
}): {
  readonly rows: readonly LancamentoAdminClassificado[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
} {
  const digest = lancamentosFiltersDigest(input.cursorSecret, {
    idConta: input.idConta,
    estado: input.estado,
    idCampanha: input.idCampanha,
  });
  const cursor = input.cursor === null ? null : decodeLancamentosCursor(input.cursor, digest);

  // Dedup defensivo por id (uma campanha nunca soma/lista duas vezes).
  const vistos = new Set<string>();
  const classificados: LancamentoAdminClassificado[] = [];
  for (const fato of input.fatos) {
    if (vistos.has(fato.idLancamento)) continue;
    vistos.add(fato.idLancamento);
    if (input.idCampanha !== null && fato.idCampanha !== input.idCampanha) continue;
    const classificacao = classificarBucketAdmin(fato, input.now);
    if (input.estado !== null && classificacao.bucket !== input.estado) continue;
    classificados.push({ fato, classificacao });
  }
  classificados.sort((a, b) => compareLancamentos(a.fato, b.fato));

  const afterCursor =
    cursor === null ? classificados : classificados.filter((x) => isAfterCursor(x.fato, cursor));
  const page = afterCursor.slice(0, input.limit);
  const hasMore = afterCursor.length > input.limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeLancamentosCursor({
          version: 1,
          criadoEm: last.fato.criadoEm.toISOString(),
          idLancamento: last.fato.idLancamento,
          filtersDigest: digest,
        })
      : null;

  return { rows: page, nextCursor, totalCount: classificados.length };
}

// ────────────────────────────────────────────────────────────────────
//  Repasses — keyset em SQL sobre as campanhas administradas
// ────────────────────────────────────────────────────────────────────

const RepassesCursorSchema = z
  .object({
    version: z.literal(1),
    solicitadoEm: z.string().datetime(),
    idRepasse: z.string().uuid(),
    filtersDigest: z.string().length(43),
  })
  .strict();
type RepassesCursor = z.infer<typeof RepassesCursorSchema>;

export class InvalidAdminUserRepassesCursorError extends Error {
  constructor() {
    super("invalid_admin_user_repasses_cursor");
    this.name = "InvalidAdminUserRepassesCursorError";
  }
}

function repassesFiltersDigest(secret: string, value: object): string {
  return createHmac("sha256", secret)
    .update("admin-user-financeiro-repasses-cursor:v1\0")
    .update(JSON.stringify(value))
    .digest("base64url");
}

function decodeRepassesCursor(encoded: string, expectedDigest: string): RepassesCursor {
  try {
    if (encoded.length === 0 || encoded.length > 1024) {
      throw new InvalidAdminUserRepassesCursorError();
    }
    const cursor = RepassesCursorSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (cursor.filtersDigest !== expectedDigest) {
      throw new InvalidAdminUserRepassesCursorError();
    }
    return cursor;
  } catch (error: unknown) {
    if (error instanceof InvalidAdminUserRepassesCursorError) throw error;
    throw new InvalidAdminUserRepassesCursorError();
  }
}

interface RepasseRow {
  id: string;
  id_campanha: string;
  campanha_titulo: string;
  amount_cents: number | string;
  status: string;
  solicitado_em: Date;
  aprovado_em: Date | null;
  enviado_ao_banco_em: Date | null;
  bank_transfer_ref: string | null;
  transfer_referencia: string | null;
  inter_codigo_solicitacao: string | null;
  transfer_attempts: number | string;
  last_transfer_error: string | null;
  needs_manual_resolution: boolean;
  recebedor_nome: string | null;
  num_lancamentos: number | string;
  valor_transferido_cents: number | string | null;
  concluido_em: Date | null;
}

interface CountRow {
  total: number | string;
}

export interface RepasseAdminUsuarioRow {
  readonly idRepasse: string;
  readonly idCampanha: string;
  readonly campanhaTitulo: string;
  readonly recebedorNome: string | null;
  readonly amountCents: number;
  readonly status: string;
  readonly solicitadoEm: Date;
  readonly aprovadoEm: Date | null;
  readonly enviadoAoBancoEm: Date | null;
  readonly bankTransferRef: string | null;
  readonly transferReferencia: string | null;
  readonly interCodigoSolicitacao: string | null;
  readonly transferAttempts: number;
  readonly lastTransferError: string | null;
  readonly needsManualResolution: boolean;
  /** Grupo do ledger para `projectRepasseEstado` (mesma projeção do extrato). */
  readonly ledger: {
    readonly quantidade: number;
    readonly valorTransferidoCents: number;
    readonly concluidoEm: Date | null;
  };
}

export async function listAdminUserRepasses(
  db: Database,
  input: {
    readonly idConta: string;
    readonly platformId: string;
    readonly cursor: string | null;
    readonly limit: number;
    readonly cursorSecret: string;
  },
): Promise<{
  readonly rows: readonly RepasseAdminUsuarioRow[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}> {
  const digest = repassesFiltersDigest(input.cursorSecret, { idConta: input.idConta });
  const cursor = input.cursor === null ? null : decodeRepassesCursor(input.cursor, digest);
  const cursorSolicitadoEm = cursor ? new Date(cursor.solicitadoEm) : null;
  const cursorId = cursor ? cursor.idRepasse : null;
  const fetchLimit = input.limit + 1;

  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);

      const pageRes = (await sql<RepasseRow>`
        SELECT
          r.id,
          r.id_campanha,
          c.titulo AS campanha_titulo,
          r.amount_cents,
          r.status,
          r.solicitado_em,
          r.aprovado_em,
          r.enviado_ao_banco_em,
          r.bank_transfer_ref,
          r.transfer_referencia,
          r.inter_codigo_solicitacao,
          r.transfer_attempts,
          r.last_transfer_error,
          r.needs_manual_resolution,
          (
            SELECT rc.nome_titular
              FROM recebedores rc
              WHERE rc.campanha_id = r.id_campanha
                AND rc.is_active = TRUE
              ORDER BY rc.criada_em DESC, rc.id ASC
              LIMIT 1
          ) AS recebedor_nome,
          (
            SELECT COUNT(*) FROM lancamentos_financeiros l WHERE l.id_repasse = r.id
          ) AS num_lancamentos,
          (
            SELECT COALESCE(SUM(l.amount_cents), 0)::bigint
              FROM lancamentos_financeiros l
              WHERE l.id_repasse = r.id AND l.transferido_em IS NOT NULL
          ) AS valor_transferido_cents,
          (
            SELECT MIN(l.transferido_em)
              FROM lancamentos_financeiros l
              WHERE l.id_repasse = r.id AND l.transferido_em IS NOT NULL
          ) AS concluido_em
        FROM repasses_recebedor r
        INNER JOIN campanhas c
          ON c.id = r.id_campanha
         AND c.id_plataforma = ${input.platformId}
        WHERE r.id_campanha IN ${campanhasAdministradasSubquery(input.idConta)}
          AND (
            ${cursorSolicitadoEm}::timestamptz IS NULL
            OR r.solicitado_em < ${cursorSolicitadoEm}::timestamptz
            OR (r.solicitado_em = ${cursorSolicitadoEm}::timestamptz AND r.id > ${cursorId}::uuid)
          )
        ORDER BY r.solicitado_em DESC, r.id ASC
        LIMIT ${fetchLimit}
      `.execute(trx)) as unknown as { rows: RepasseRow[] };

      const countRes = (await sql<CountRow>`
        SELECT COUNT(*) AS total
          FROM repasses_recebedor r
          INNER JOIN campanhas c
            ON c.id = r.id_campanha
           AND c.id_plataforma = ${input.platformId}
          WHERE r.id_campanha IN ${campanhasAdministradasSubquery(input.idConta)}
      `.execute(trx)) as unknown as { rows: CountRow[] };

      const all = pageRes.rows.map(
        (row): RepasseAdminUsuarioRow => ({
          idRepasse: row.id,
          idCampanha: row.id_campanha,
          campanhaTitulo: row.campanha_titulo,
          recebedorNome: row.recebedor_nome,
          amountCents: toInt(row.amount_cents),
          status: row.status,
          solicitadoEm: new Date(row.solicitado_em),
          aprovadoEm: row.aprovado_em ? new Date(row.aprovado_em) : null,
          enviadoAoBancoEm: row.enviado_ao_banco_em ? new Date(row.enviado_ao_banco_em) : null,
          bankTransferRef: row.bank_transfer_ref,
          transferReferencia: row.transfer_referencia,
          interCodigoSolicitacao: row.inter_codigo_solicitacao,
          transferAttempts: toInt(row.transfer_attempts),
          lastTransferError: row.last_transfer_error,
          needsManualResolution: row.needs_manual_resolution === true,
          ledger: {
            quantidade: toInt(row.num_lancamentos),
            valorTransferidoCents: toInt(row.valor_transferido_cents),
            concluidoEm: row.concluido_em ? new Date(row.concluido_em) : null,
          },
        }),
      );

      const hasMore = all.length > input.limit;
      const rows = all.slice(0, input.limit);
      const last = rows[rows.length - 1];
      const nextCursor =
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                solicitadoEm: last.solicitadoEm.toISOString(),
                idRepasse: last.idRepasse,
                filtersDigest: digest,
              } satisfies RepassesCursor),
              "utf8",
            ).toString("base64url")
          : null;

      return { rows, nextCursor, totalCount: toInt(countRes.rows[0]?.total) };
    });
}
