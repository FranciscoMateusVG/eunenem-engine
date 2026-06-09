/**
 * Admin tRPC router (rsidz.2 + tinly + rsidz.3).
 *
 * The data layer for the operator's DDD-trace drill-down. v1 is read-only.
 *
 *   W1 (rsidz.2): `searchUsers`, `findUsuarioByConta`
 *   tinly:        nested `usuarios.listPaginated` (browse-as-default table)
 *   W2 (rsidz.3): nested `campanhas` sub-router —
 *                 `listByUsuario`, `listByContribuinte`, `findById`
 *                 (contribuicoes lookups are W3 territory — rsidz.4)
 *
 * v1 has NO auth gate (operator directive). Anyone with the URL gets in.
 * When auth lands in v2, this is one of the boundaries that gates against
 * the operator role.
 *
 * Tenant scope is hardcoded to `ID_PLATAFORMA_EUNENEM`. Multi-tenancy is
 * deferred; for v1 every admin query is implicitly scoped to eunenem.
 *
 * Procedures intentionally project the engine aggregates down to flat
 * result shapes with just the fields the UI needs. We don't leak the full
 * aggregate over the wire — that's both a footprint and a discipline win:
 * the wire contract is decoupled from the domain model.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Campanha } from "../../../../src/domain/arrecadacao/entities/campanha.js";
import type { Contribuicao } from "../../../../src/domain/arrecadacao/entities/contribuicao.js";
import type {
  IdCampanha,
  IdConta,
  IdContribuicao,
} from "../../../../src/domain/arrecadacao/value-objects/ids.js";
import type { LancamentoFinanceiro } from "../../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js";
import type { IdPagamentoReferencia } from "../../../../src/domain/pagamentos/financeiro/value-objects/ids.js";
import type { Pagamento } from "../../../../src/domain/pagamentos/entities/pagamento.js";
import type { IdContribuicaoPagamento } from "../../../../src/domain/pagamentos/value-objects/ids.js";
import {
  aprovarRepasseRecebedor,
  FinanceiroInputInvalidoError,
  FinanceiroRepasseNaoEncontradoError,
  FinanceiroRepasseStatusInvalidoError,
  ID_PLATAFORMA_EUNENEM,
} from "../../../../src/index.js";
import type { TrpcContext } from "./context.js";

const t = initTRPC.context<TrpcContext>().create();

/** Wire shape — kept narrow so we never leak the full Usuario aggregate. */
const UsuarioMatchSchema = z.object({
  idConta: z.string(),
  email: z.string(),
  nomeExibicao: z.string(),
});
export type UsuarioMatch = z.infer<typeof UsuarioMatchSchema>;

/* ─────────────────────────────────────────────────────────────────────────
 * usuarios.listPaginated — browse-as-default users table (aperture-tinly).
 *
 * Wires through to the engine port `findUsuariosPaginated(idPlataforma, input)`
 * from aperture-qatwz (Rex, PR #98). The DTO projection is the only
 * eunenem-specific shape — the wire output trims the full Usuario aggregate
 * down to the six fields the UI consumes (id, idConta, email, nomeExibicao,
 * slug, criadoEm) so we never leak the aggregate over the wire.
 * ────────────────────────────────────────────────────────────────────── */

const UsuarioAdminDTOSchema = z.object({
  id: z.string(),
  idConta: z.string(),
  email: z.string(),
  nomeExibicao: z.string(),
  slug: z.string(),
  criadoEm: z.string(),
});
export type UsuarioAdminDTO = z.infer<typeof UsuarioAdminDTOSchema>;

const SortBySchema = z.enum(["criadoEm", "email", "nomeExibicao"]);
const SortDirSchema = z.enum(["asc", "desc"]);

const ListPaginatedInputSchema = z.object({
  cursor: z.string().nullable(),
  limit: z.number().int().min(1).max(100),
  sortBy: SortBySchema,
  sortDir: SortDirSchema,
  emailPrefix: z.string().max(120).optional(),
});

const ListPaginatedOutputSchema = z.object({
  usuarios: z.array(UsuarioAdminDTOSchema),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().min(0),
});

const usuariosRouter = t.router({
  /**
   * Cursor-paginated tenant-scoped browse of usuarios. Tri-state sort
   * (criadoEm / email / nomeExibicao × asc/desc), LIKE-escaped
   * emailPrefix filter, exact totalCount.
   *
   * Backed by `UsuarioRepository.findUsuariosPaginated` (Wheatley §6
   * contract, Rex aperture-qatwz / PR #98). The proc projects the full
   * Usuario aggregate down to the lean DTO the UI consumes; cursor +
   * sort + filter semantics live on the port.
   */
  listPaginated: t.procedure
    .input(ListPaginatedInputSchema)
    .output(ListPaginatedOutputSchema)
    .query(async ({ ctx, input }) => {
      const result = await ctx.deps.usuarioRepository.findUsuariosPaginated(
        ID_PLATAFORMA_EUNENEM,
        {
          cursor: input.cursor,
          limit: input.limit,
          sortBy: input.sortBy,
          sortDir: input.sortDir,
          emailPrefix: input.emailPrefix,
        },
      );

      return {
        usuarios: result.usuarios.map((u) => ({
          id: u.id,
          idConta: u.idConta,
          email: u.email,
          nomeExibicao: u.nomeExibicao,
          slug: u.slug,
          criadoEm: u.criadoEm.toISOString(),
        })),
        nextCursor: result.nextCursor,
        totalCount: result.totalCount,
      };
    }),
});

/**
 * Wire shape for a campanha row in the admin lists. Projection of the
 * Campanha aggregate down to the fields the admin UI actually renders.
 * NEVER widens to the full aggregate (opcoes, idsAdministradores, etc).
 */
const CampanhaAdminDTOSchema = z.object({
  id: z.string(),
  titulo: z.string(),
  status: z.enum(["com-recebedor", "sem-recebedor"]),
  criadaEm: z.string(), // ISO 8601 — clients can parse to Date.
  recebedor: z
    .object({
      nome: z.string(),
    })
    .nullable(),
});
export type CampanhaAdminDTO = z.infer<typeof CampanhaAdminDTOSchema>;

/** Detail wire shape — superset of the row DTO, adds idPlataforma + opcoes count. */
const CampanhaDetailDTOSchema = CampanhaAdminDTOSchema.extend({
  idPlataforma: z.string(),
  qtdOpcoes: z.number().int().min(0),
});
export type CampanhaDetailDTO = z.infer<typeof CampanhaDetailDTOSchema>;

const SEARCH_LIMIT = 20;

/** Project a Campanha aggregate down to the admin row DTO. */
function toCampanhaAdminDTO(c: Campanha): CampanhaAdminDTO {
  return {
    id: c.id,
    titulo: c.titulo,
    status: c.dadosRecebedor === null ? "sem-recebedor" : "com-recebedor",
    criadaEm: c.criadaEm.toISOString(),
    recebedor:
      c.dadosRecebedor === null
        ? null
        : { nome: c.dadosRecebedor.nomeTitular },
  };
}

const campanhasRouter = t.router({
  /**
   * Campanhas administered by the usuario identified by `idConta`.
   *
   * Uses the 1..N port `findCampanhasByAdministrador` (aperture-u2tko) —
   * returns ALL campanhas the usuario administers, ordered criadaEm ASC.
   * Includes campanhas without a recebedor (mirrors
   * `findFirstByAdministrador` semantics: bank-info readiness does NOT
   * gate visibility in the admin "Administra" tab).
   *
   * Tenant guard: the engine resolves campanhas through the
   * `campanha_administradores` join, which is scoped by `campanha_id` to
   * a single plataforma row. We still filter the returned aggregate by
   * `idPlataforma === ID_PLATAFORMA_EUNENEM` — belt and braces for the
   * multi-tenancy boundary, in case a usuario has memberships across
   * plataformas in the future.
   */
  listByUsuario: t.procedure
    .input(z.object({ idConta: z.string() }))
    .output(z.object({ campanhas: z.array(CampanhaAdminDTOSchema) }))
    .query(async ({ ctx, input }) => {
      const campanhas =
        await ctx.deps.campanhaRepository.findCampanhasByAdministrador(
          input.idConta as IdConta,
        );
      const visiveis = campanhas.filter(
        (c) => c.idPlataforma === ID_PLATAFORMA_EUNENEM,
      );
      return { campanhas: visiveis.map(toCampanhaAdminDTO) };
    }),

  /**
   * Campanhas this email has CONTRIBUTED to (any status). Reuses the
   * engine port shipped in aperture-2ma52 / PR #94. Tenant-scoped via
   * the explicit `idPlataforma` arg — the SQL filters at the campanhas
   * row level.
   *
   * Email-based by design: visitor checkouts identify the contribuinte by
   * email only (no idConta on `contribuicoes`). The caller passes the
   * usuario's email (already resolved by the picker / detail page).
   */
  listByContribuinte: t.procedure
    .input(z.object({ email: z.string() }))
    .output(z.object({ campanhas: z.array(CampanhaAdminDTOSchema) }))
    .query(async ({ ctx, input }) => {
      const cleaned = input.email.trim();
      if (cleaned === "") return { campanhas: [] };
      const campanhas =
        await ctx.deps.campanhaRepository.findCampanhasByContribuinte(
          ID_PLATAFORMA_EUNENEM,
          cleaned,
        );
      return {
        campanhas: campanhas.map(toCampanhaAdminDTO),
      };
    }),

  /**
   * Single campanha lookup by id. Used by /admin/campanha/:idCampanha.
   * Tenant-guarded — returns null when the campanha lives on another
   * plataforma (defensive; the engine `findById` does NOT pre-filter
   * by tenant).
   */
  findById: t.procedure
    .input(z.object({ idCampanha: z.string() }))
    .output(CampanhaDetailDTOSchema.nullable())
    .query(async ({ ctx, input }) => {
      const campanha = await ctx.deps.campanhaRepository.findById(
        input.idCampanha as never,
      );
      if (!campanha) return null;
      if (campanha.idPlataforma !== ID_PLATAFORMA_EUNENEM) return null;
      const row = toCampanhaAdminDTO(campanha);
      return {
        ...row,
        idPlataforma: campanha.idPlataforma,
        qtdOpcoes: campanha.opcoes.length,
      };
    }),
});

/* ─────────────────────────────────────────────────────────────────────────
 * contribuicoes — W3 (aperture-rsidz.4).
 *
 * Two procedures, both tenant-guarded against ID_PLATAFORMA_EUNENEM:
 *   - listByCampanha({ idCampanha }) → all contribuicoes for the campanha,
 *     used by the embedded ContribuicoesList on /admin/campanha/:idCampanha.
 *     v1 has NO server-side pagination/filtering — filters apply client-side
 *     in the list component. Documented in §2 of Wheatley's scope: if a
 *     campanha grows past ~500 contribuicoes, file a paging follow-up bead.
 *   - findById({ idContribuicao }) → multi-aggregate lookup for the detail
 *     page (/admin/contribuicao/:idContribuicao). Returns the contribuicao
 *     plus its campanha + recebedor (from the campanha snapshot) + the
 *     contribuinte (if a usuario with that email exists on this plataforma).
 *
 * Wire shape is intentionally narrow — never leaks the full Contribuicao
 * aggregate. Mirrors the projection discipline established by
 * `toCampanhaAdminDTO` above.
 * ────────────────────────────────────────────────────────────────────── */

const ContribuinteDTOSchema = z
  .object({
    nome: z.string(),
    email: z.string(),
    mensagem: z.string().nullable(),
  })
  .nullable();

const ContribuicaoAdminDTOSchema = z.object({
  id: z.string(),
  nome: z.string(),
  valorCentavos: z.number().int().nonnegative(),
  grupo: z.string().nullable(),
  idOpcaoContribuicao: z.string(),
  criadaEm: z.string(),
  // Plan 0015 Phase 6 — computed predicate (`EXISTS pagamento WHERE
  // id_contribuicao=X AND status='aprovado'`). The contribuicao detail
  // screen's Arrecadação status pill reads this. Phase 1 dropped the
  // stored `status` field; this is now the only source of truth.
  // Computed in `toContribuicaoAdminDTO` via `pagamentoRepository`.
  indisponivel: z.boolean(),
  // aperture-6iqum — contribuinte attribution from the most-recent
  // aprovado pagamento's intencao.contribuinte. Mirrors the per-
  // pagamento projection xfw5c added on PagamentoAdminDTO. Null when:
  //   - no aprovado pagamento exists yet (gift not received)
  //   - aprovado pagamento has anonymous checkout (contribuinte=null)
  //   - pre-webhook race window before contribuinte_stamped fires
  // Frontend list row shows "presented by X" when non-null,
  // "(sem contribuinte)" affordance otherwise.
  contribuinte: ContribuinteDTOSchema,
});
export type ContribuicaoAdminDTO = z.infer<typeof ContribuicaoAdminDTOSchema>;

const CampanhaSummaryDTOSchema = z.object({
  id: z.string(),
  titulo: z.string(),
});
export type CampanhaSummaryDTO = z.infer<typeof CampanhaSummaryDTOSchema>;

const RecebedorSummaryDTOSchema = z.object({
  nome: z.string(),
});
export type RecebedorSummaryDTO = z.infer<typeof RecebedorSummaryDTOSchema>;

const UsuarioSummaryDTOSchema = z.object({
  idConta: z.string(),
  nomeExibicao: z.string(),
  email: z.string(),
});
export type UsuarioSummaryDTO = z.infer<typeof UsuarioSummaryDTOSchema>;

/**
 * Sync projection — caller hands in the pre-fetched bulk results
 * (indisponivelSet + contribuintesByIdContribuicao) so the function
 * itself doesn't fan out N+1 lookups. Used by listByCampanha (bulk)
 * and by detail-resolution paths (singletons wrapping the bulk port).
 */
function toContribuicaoAdminDTO(
  c: Contribuicao,
  indisponivelSet: Set<string>,
  contribuintesByIdContribuicao: Map<
    string,
    { nome: string; email: string; mensagem?: string } | null
  >,
): ContribuicaoAdminDTO {
  // Post-Phase-1 swap: contribuição has NO status, NO contribuinte (those
  // moved to IntencaoPagamento per-pagamento). The "indisponivel" badge is
  // a computed predicate: at least one approved pagamento exists for this
  // slot.
  //
  // aperture-6iqum: `contribuinte` is the most-recent aprovado
  // pagamento's intencao.contribuinte (anonymous + pre-webhook race
  // surface as null; UI affordance handles either).
  const contribuinte = contribuintesByIdContribuicao.get(c.id) ?? null;
  return {
    id: c.id,
    nome: c.nome,
    valorCentavos: c.valor as unknown as number,
    grupo: c.grupo,
    idOpcaoContribuicao: c.idOpcaoContribuicao,
    criadaEm: c.criadaEm.toISOString(),
    indisponivel: indisponivelSet.has(c.id),
    contribuinte:
      contribuinte === null
        ? null
        : {
            nome: contribuinte.nome,
            email: contribuinte.email,
            mensagem: contribuinte.mensagem ?? null,
          },
  };
}

const contribuicoesRouter = t.router({
  /**
   * All contribuicoes for a campanha. Tenant-guarded: resolves the campanha
   * first and verifies idPlataforma; an unknown or cross-tenant campanha
   * returns an empty array (defensive, matches the campanhas.findById null
   * behavior on cross-tenant lookups).
   *
   * NOT paginated server-side (see file header §2). Filters live in the
   * client-side ContribuicoesList state machine.
   */
  listByCampanha: t.procedure
    .input(z.object({ idCampanha: z.string() }))
    .output(z.object({ contribuicoes: z.array(ContribuicaoAdminDTOSchema) }))
    .query(async ({ ctx, input }) => {
      const campanha = await ctx.deps.campanhaRepository.findById(
        input.idCampanha as IdCampanha,
      );
      if (!campanha) return { contribuicoes: [] };
      if (campanha.idPlataforma !== ID_PLATAFORMA_EUNENEM) {
        return { contribuicoes: [] };
      }
      const contribuicoes =
        await ctx.deps.contribuicaoRepository.findByCampanhaId(
          input.idCampanha as IdCampanha,
        );
      // Plan 0016 Phase 2 (aperture-eg1s2): bulk-fetch esgotada set +
      // contribuinte attribution in TWO indexed queries. The sums
      // query gives `quantidade` sold per slot; esgotada derives from
      // `quantidade - sold <= 0`.
      const ids = contribuicoes.map(
        (c) => c.id as unknown as IdContribuicaoPagamento,
      );
      const [sumsMap, contribuintesMap] =
        ids.length === 0
          ? [
              new Map<IdContribuicaoPagamento, number>(),
              new Map() as Map<
                string,
                { nome: string; email: string; mensagem?: string } | null
              >,
            ]
          : await Promise.all([
              ctx.deps.pagamentoRepository.somarQuantidadesContribuicoesEmPagamentosAprovados(
                ids,
              ),
              ctx.deps.pagamentoRepository.findContribuintesFromLatestAprovadoPagamento(
                ids,
              ),
            ]);
      const indisponivelSet = new Set<string>();
      for (const c of contribuicoes) {
        const sold = sumsMap.get(c.id as unknown as IdContribuicaoPagamento) ?? 0;
        if (c.quantidade - sold <= 0) {
          indisponivelSet.add(c.id);
        }
      }
      return {
        contribuicoes: contribuicoes.map((c) =>
          toContribuicaoAdminDTO(c, indisponivelSet, contribuintesMap),
        ),
      };
    }),

  /**
   * Multi-aggregate lookup for the contribuicao detail page (W3).
   *
   * Returns null when:
   *   - the contribuicao does not exist
   *   - the resolving campanha lives on another plataforma (tenant guard)
   *
   * Includes:
   *   - contribuicao: lean DTO of the Arrecadacao aggregate
   *   - campanha: { id, titulo } summary (link target for the campanha block)
   *   - recebedor: { nome } | null — taken from the campanha's dadosRecebedor
   *     snapshot (the active recebedor projection). Null when the campanha
   *     has no recebedor yet ("gift-not-claimed" affordance).
   *   - contribuinte: { idConta, nomeExibicao, email } | null — resolved
   *     via findUsuarioByEmail(plataforma, contribuinte.email). Anonymous
   *     visitor checkouts (no contribuinte attached) → null. Identified
   *     contribuinte whose email is NOT a registered usuario on this
   *     plataforma → also null (rendered as "(sem contribuinte identificado)"
   *     by the page).
   */
  findById: t.procedure
    .input(z.object({ idContribuicao: z.string() }))
    .output(
      z
        .object({
          contribuicao: ContribuicaoAdminDTOSchema,
          campanha: CampanhaSummaryDTOSchema,
          recebedor: RecebedorSummaryDTOSchema.nullable(),
          contribuinte: UsuarioSummaryDTOSchema.nullable(),
        })
        .nullable(),
    )
    .query(async ({ ctx, input }) => {
      const contribuicao = await ctx.deps.contribuicaoRepository.findById(
        input.idContribuicao as IdContribuicao,
      );
      if (!contribuicao) return null;

      const campanha = await ctx.deps.campanhaRepository.findById(
        contribuicao.idCampanha,
      );
      if (!campanha) return null;
      // Tenant guard — never cross the multi-tenant boundary.
      if (campanha.idPlataforma !== ID_PLATAFORMA_EUNENEM) return null;

      const recebedor: RecebedorSummaryDTO | null =
        campanha.dadosRecebedor === null
          ? null
          : { nome: campanha.dadosRecebedor.nomeTitular };

      // Post-Phase-1: contribuição no longer carries a single contribuinte
      // (data moved to IntencaoPagamento per-pagamento). The
      // contribuinte-summary lookup-by-email path is retired here — the
      // detail screen surfaces per-pagamento contribuintes via the
      // Pagamentos card directly. Always null at the campanha-level summary
      // surface. Follow-up bead can reintroduce a "first/most-recent aprovado
      // pagamento's contribuinte" lookup if the campanha view needs it.
      const contribuinteSummary: UsuarioSummaryDTO | null = null;

      // Plan 0016 Phase 2 (aperture-eg1s2): single-row resolution via
      // the same bulk somar port (Map with one entry). Mirrors the
      // listByCampanha shape so the projection function stays uniform.
      const idCp = contribuicao.id as unknown as IdContribuicaoPagamento;
      const [sumsMap, contribuintesMap] = await Promise.all([
        ctx.deps.pagamentoRepository.somarQuantidadesContribuicoesEmPagamentosAprovados([idCp]),
        ctx.deps.pagamentoRepository.findContribuintesFromLatestAprovadoPagamento([idCp]),
      ]);
      const sold = sumsMap.get(idCp) ?? 0;
      const indisponivelSet = new Set<string>();
      if (contribuicao.quantidade - sold <= 0) {
        indisponivelSet.add(contribuicao.id);
      }

      return {
        contribuicao: toContribuicaoAdminDTO(
          contribuicao,
          indisponivelSet,
          contribuintesMap,
        ),
        campanha: { id: campanha.id, titulo: campanha.titulo },
        recebedor,
        contribuinte: contribuinteSummary,
      };
    }),
});

/* ─────────────────────────────────────────────────────────────────────────
 * Shared cross-BC schema — used by both `pagamentos` (W4) and
 * `financeiro` (W5) sub-routers.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Pagamento FSM — 5 states per plan 0015 Locked Decision #7.
 *
 *   pendente   → processing   (payment_intent.processing — pix QR scanned)
 *   pendente   → aprovado     (charge.succeeded, card happy path)
 *   processing → aprovado     (charge.succeeded after pix/ACH confirmation)
 *   pendente   → rejeitado    (failure before processing)
 *   processing → rejeitado    (failure during processing)
 *   aprovado   → estornado    (charge.refunded — pre-transfer guard enforced)
 *
 * Parallel-prep note (aperture-i45g5): until Rex's Phase 3 webhook handler
 * ships, the engine only emits {pendente, aprovado, rejeitado}. The schema
 * is widened in advance so the UI can render all 5 states without coupling
 * to the rollout order. Current data flows through the same 3-state subset
 * it always did.
 */
const PagamentoStatusSchema = z.enum([
  "pendente",
  "processing",
  "aprovado",
  "rejeitado",
  "estornado",
]);

/* ─────────────────────────────────────────────────────────────────────────
 * financeiro — W5 (aperture-rsidz.6).
 *
 * Fills the bottom section of the contribuicao detail page. The Financeiro
 * BC's double-entry ledger is the operator-visible payoff of the DDD spine:
 * every aprovado pagamento books TWO lancamentos (saldo do recebedor +
 * receita da plataforma). Operators see that booking discipline directly.
 *
 * Single procedure: `listByContribuicao`. Server-side composes across two
 * BCs (Pagamentos → Financeiro) because:
 *   1. W3 locked the FinanceiroSection seam at `(idContribuicao) => JSX`
 *   2. The Financeiro port keys lancamentos by `idPagamento`, NOT by
 *      `idContribuicao` (the ledger only knows pagamento references).
 *   3. A clean port-level `findLancamentosByIdContribuicao` is +1 engine
 *      bead we don't need yet — N ≤ ~3 pagamentos/contribuicao in practice,
 *      so the N+1 loop is bounded and explicit.
 *
 * Output is grouped by pagamento so the UI renders per-pagamento blocks
 * (matches the operator's mental model: "for THIS payment, here are the
 * two ledger entries it booked").
 *
 * Tenant guard: resolves the contribuicao via Arrecadação first → its
 * campanha must live on ID_PLATAFORMA_EUNENEM. Cross-tenant lookups
 * return an empty result (mirrors the contribuicoes.findById null behavior).
 * ────────────────────────────────────────────────────────────────────── */

const LancamentoTipoSchema = z.enum([
  "credito_saldo_recebedor",
  "credito_receita_plataforma",
  // Buyer-paid card surcharge (aperture-bjshv / PR #110). Only emitted when
  // composicaoValores.surchargeCents > 0 — PIX pagamentos still produce two
  // lancamentos. Operator-readable label "Repasse Stripe (taxa cartão)" is
  // applied in the frontend tipo→label map.
  "credito_passthrough_surcharge",
]);

const LancamentoFinanceiroAdminDTOSchema = z.object({
  id: z.string(),
  idPagamento: z.string(),
  idContribuicao: z.string(),
  idCampanha: z.string().nullable(),
  tipo: LancamentoTipoSchema,
  amountCents: z.number().int().nonnegative(),
  criadoEm: z.string(),
  // Plan 0015 Locked Decision #9 — observed timestamps replace the FSM.
  // Lançamento has NO status enum; "state" is derived from the two dates:
  //
  //   transferidoEm: when admin marked the row as transferred to the
  //     recebedor (manual action; no cron yet — operator clicks a button).
  //   canceladoEm: when the parent pagamento went `estornado` AND this
  //     lancamento was still untransferred (cascade-scope-discipline:
  //     transferred rows are NOT cancelled — the estorno gate returns
  //     409 if any lancamento has transferidoEm set).
  //
  // Implicit "states" via query-time predicates:
  //   pending     = transferidoEm IS NULL AND canceladoEm IS NULL
  //   transferred = transferidoEm IS NOT NULL AND canceladoEm IS NULL
  //   cancelado   = canceladoEm IS NOT NULL
  //
  // Phase 1 entity surgery dropped the status + maturaEm fields from the
  // domain entity; Phase 6's parallel-prep additive stubs (status,
  // maturaEm, null transferidoEm/canceladoEm) are now retired and the DTO
  // wires through the real LancamentoFinanceiro fields. (Cross-app drift
  // fix surfaced by Peppy's Phase-7 deploy verify.)
  transferidoEm: z.string().nullable(),
  canceladoEm: z.string().nullable(),
});
export type LancamentoFinanceiroAdminDTO = z.infer<
  typeof LancamentoFinanceiroAdminDTOSchema
>;

const LancamentosByPagamentoSchema = z.object({
  idPagamento: z.string(),
  pagamentoStatus: PagamentoStatusSchema,
  pagamentoCriadoEm: z.string(), // ISO
  lancamentos: z.array(LancamentoFinanceiroAdminDTOSchema),
});
export type LancamentosByPagamento = z.infer<
  typeof LancamentosByPagamentoSchema
>;

function toLancamentoAdminDTO(l: LancamentoFinanceiro): LancamentoFinanceiroAdminDTO {
  return {
    id: l.id,
    idPagamento: l.idPagamento,
    idContribuicao: l.idContribuicao,
    idCampanha: l.idCampanha ?? null,
    tipo: l.tipo,
    amountCents: l.amountCents as unknown as number,
    criadoEm: l.criadoEm.toISOString(),
    // Post-Phase-1 / Phase-6 parallel-prep swap (cross-app drift fix). The
    // entity now carries the two nullable dates directly.
    transferidoEm: l.transferidoEm?.toISOString() ?? null,
    canceladoEm: l.canceladoEm?.toISOString() ?? null,
  };
}

const financeiroRouter = t.router({
  /**
   * All lancamentos financeiros generated by every pagamento attached to a
   * single contribuicao, grouped by pagamento. v1 has no server-side
   * pagination — N pagamentos per contribuicao is bounded small (~≤3
   * lifetime in practice).
   *
   * Composition (server-side, see header §a):
   *   1. PagamentoRepository.findByContribuicao(idContribuicao) → Pagamento[]
   *   2. For each Pagamento p: LivroFinanceiroRepository.findLancamentosByIdPagamento(p.id)
   *   3. Project each Lancamento to the lean admin DTO; group by idPagamento.
   *
   * Pendente/rejeitado pagamentos yield empty lancamento arrays — the UI
   * renders "Sem lançamentos (pagamento ainda não aprovado)" affordance.
   *
   * Sort: pagamentos descending by criadoEm (most recent attempt first).
   */
  listByContribuicao: t.procedure
    .input(z.object({ idContribuicao: z.string() }))
    .output(
      z.object({
        lancamentosByPagamento: z.array(LancamentosByPagamentoSchema),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Tenant guard: resolve the contribuicao + its campanha; bail on
      // cross-plataforma. Matches contribuicoes.findById behavior.
      const contribuicao = await ctx.deps.contribuicaoRepository.findById(
        input.idContribuicao as IdContribuicao,
      );
      if (!contribuicao) return { lancamentosByPagamento: [] };
      const campanha = await ctx.deps.campanhaRepository.findById(
        contribuicao.idCampanha,
      );
      if (!campanha) return { lancamentosByPagamento: [] };
      if (campanha.idPlataforma !== ID_PLATAFORMA_EUNENEM) {
        return { lancamentosByPagamento: [] };
      }

      const pagamentos = await ctx.deps.pagamentoRepository.findByContribuicao(
        input.idContribuicao as IdContribuicaoPagamento,
      );

      // Compose per-pagamento groups. N+1 by design (see header §a): N is
      // bounded small, and we explicitly want the per-block shape on the
      // wire so the UI doesn't have to re-group client-side.
      const groups = await Promise.all(
        pagamentos.map(async (p: Pagamento) => {
          const lancamentos =
            await ctx.deps.livroFinanceiroRepository.findLancamentosByIdPagamento(
              p.id as unknown as IdPagamentoReferencia,
            );
          return {
            idPagamento: p.id,
            pagamentoStatus: p.status,
            pagamentoCriadoEm: p.criadoEm.toISOString(),
            lancamentos: lancamentos.map(toLancamentoAdminDTO),
          };
        }),
      );

      // Sort: most recent pagamento first.
      groups.sort((a, b) =>
        a.pagamentoCriadoEm < b.pagamentoCriadoEm ? 1 : -1,
      );

      return { lancamentosByPagamento: groups };
    }),
});

/* ─────────────────────────────────────────────────────────────────────────
 * pagamentos — W4 (aperture-rsidz.5).
 *
 * One procedure: `listByContribuicao({ idContribuicao })` →
 * `{ pagamentos: PagamentoAdminDTO[] }` sorted by `criadoEm desc`.
 *
 * Tenant guard: Pagamento has no idPlataforma directly. We resolve the
 * owning contribuicao first (Arrecadação aggregate) and walk up to the
 * campanha to verify `idPlataforma === ID_PLATAFORMA_EUNENEM`. An
 * unknown / cross-tenant contribuicao returns an empty list (defensive,
 * matches the contribuicoes.listByCampanha pattern).
 *
 * The wire DTO mirrors the Pagamento aggregate but turns Dates into ISO
 * strings (JSON-safe) and inlines the IntencaoPagamento + TransacaoExterna
 * entities. We deliberately ship the FULL aggregate to the client — the
 * UI renders a structured composição table AND a raw JSON viewer for
 * operator inspection, so projecting down would just make us round-trip
 * for the same data.
 *
 * Sort: `findByContribuicao` returns `criadoEm ASC` (aperture-i0pz8); we
 * reverse to DESC so the latest attempt sits first in the admin card list
 * (visitor-retry flow: pendente → rejeitado → new pendente → aprovado).
 *
 * `PagamentoStatusSchema` is hoisted above the financeiro block (shared
 * with W5's per-block header chip).
 * ────────────────────────────────────────────────────────────────────── */

const TransacaoExternaStatusSchema = z.enum(["aprovado", "rejeitado"]);

const SnapshotComposicaoValoresDTOSchema = z.object({
  idContribuicao: z.string(),
  contributionAmountCents: z.number().int().nonnegative(),
  feeAmountCents: z.number().int().nonnegative(),
  surchargeCents: z.number().int().nonnegative(),
  totalPaidCents: z.number().int().nonnegative(),
  receiverAmountCents: z.number().int().nonnegative(),
  responsavelTaxa: z.literal("contribuinte"),
});

/**
 * IntencaoPagamento wire shape.
 *
 * Plan 0015 Phase 1 (Rex) moves DadosContribuinte off Contribuicao onto
 * IntencaoPagamento. Set by the webhook handler at `checkout.session.completed`
 * (Stripe `custom_fields` payload). Nullable at intent-creation time because
 * the visitor hasn't completed the iframe yet.
 *
 * Parallel-prep note (aperture-i45g5): until Rex's Phase 1 + Phase 3 ship,
 * `intencao.contribuinte` is null in every row. UI handles the null state
 * with a "(sem contribuinte ainda)" affordance — same as the anonymous
 * checkout path. When Rex's PRs land, `toPagamentoAdminDTO` reads
 * `p.intencao.contribuinte`.
 */
const IntencaoPagamentoDTOSchema = z.object({
  id: z.string(),
  idContribuicao: z.string(),
  amountCents: z.number().int().nonnegative(),
  metodo: z.enum(["pix", "credit_card"]),
  externalRef: z.string().nullable(),
  criadaEm: z.string(),
  composicaoValores: SnapshotComposicaoValoresDTOSchema,
  contribuinte: ContribuinteDTOSchema,
});

const TransacaoExternaDTOSchema = z.object({
  id: z.string(),
  provedor: z.string(),
  status: TransacaoExternaStatusSchema,
  amountCents: z.number().int().nonnegative(),
  criadaEm: z.string(),
  statusBruto: z.string().optional(),
});

/**
 * Plan 0015 derived-liberação extension (aperture-mjgxe). Two sub-states
 * of `aprovado` exposed at the DTO layer as a derived predicate over
 * the new `intencao.balanceTransactionAvailableOn` column:
 *
 *   - `aguardando_liberacao` — status='aprovado' AND
 *     (availableOn IS NULL OR availableOn > now()).
 *     Money received from Stripe but not yet available to the recebedor.
 *     Admin transfer-to-recebedor is BLOCKED in this state.
 *   - `disponivel` — status='aprovado' AND availableOn <= now().
 *     Money is settled; admin transfer is unblocked.
 *   - `null` — any non-aprovado status. The UI shows the status-level
 *     chip (pendente, processing, rejeitado, estornado) without the
 *     liberação overlay.
 *
 * Vance's parallel-prep scaffold (#135, aperture-ft5t1) already reads
 * `pagamento.liberacao` + `pagamento.availableOn` at the top level —
 * the chip + sub-label light up automatically on the wire-shape swap.
 */
const LiberacaoSchema = z.enum(['aguardando_liberacao', 'disponivel']).nullable();
export type Liberacao = z.infer<typeof LiberacaoSchema>;

const PagamentoAdminDTOSchema = z.object({
  id: z.string(),
  status: PagamentoStatusSchema,
  criadoEm: z.string(),
  atualizadoEm: z.string(),
  intencao: IntencaoPagamentoDTOSchema,
  transacaoExterna: TransacaoExternaDTOSchema.optional(),
  /**
   * Plan 0015 / aperture-mjgxe. Server-side derived liberação sub-state
   * (see LiberacaoSchema docblock). Top-level field — NOT nested under
   * intencao — matches Vance's scaffold contract.
   */
  liberacao: LiberacaoSchema,
  /**
   * Plan 0015 / aperture-mjgxe. ISO string of when the money becomes
   * (or became) available to the recebedor. `null` when the webhook
   * hasn't populated it yet (typically a brief window after pi.succeeded
   * for cartão while Stripe's Balance Transaction hasn't been minted).
   * UI sub-label "liberação prevista DD/MM" formats this; only renders
   * when liberacao === 'aguardando_liberacao' AND availableOn !== null.
   */
  availableOn: z.string().nullable(),
});
export type PagamentoAdminDTO = z.infer<typeof PagamentoAdminDTOSchema>;

/**
 * `PagamentoAdminDTO` extended with the financial ledger entries it
 * produced. The `lancamentos` array is empty for every non-aprovado
 * pagamento (no rows exist in the ledger until aprovação) — the UI
 * uses that empty-array signal to skip the financeiro block on
 * pendente/processing/rejeitado payments and show "Sem lançamentos"
 * affordance.
 *
 * Plan 0015 / aperture-aqlv2 contract pin: the Financeiro section
 * on /admin/contribuicao/:id collapses into the Pagamentos section
 * because Financeiro is now a MODULE UNDER Pagamentos (Locked
 * Decision #1). Vance's `aperture-c5vq2` parallel-prep scaffold
 * binds against this shape; the contribuição.detail page renders
 * each pagamento with its lançamentos nested inline.
 *
 * `LancamentoFinanceiroAdminDTOSchema` already encodes the
 * plan-0015 timestamp pair (`transferidoEm`, `canceladoEm`) — no
 * status field. See its docblock above for the implicit-state
 * predicates.
 */
const PagamentoWithLancamentosAdminDTOSchema = PagamentoAdminDTOSchema.extend({
  lancamentos: z.array(LancamentoFinanceiroAdminDTOSchema),
});
export type PagamentoWithLancamentosAdminDTO = z.infer<
  typeof PagamentoWithLancamentosAdminDTOSchema
>;

/**
 * Plan 0015 / aperture-mjgxe. Compute the derived liberação sub-state
 * from (status, availableOn, now).
 *
 * Rules (locked at the bead spec):
 *   - status !== 'aprovado'               → null (no overlay)
 *   - aprovado AND availableOn === null   → 'aguardando_liberacao'
 *     (defensive — brief window before webhook persists availableOn)
 *   - aprovado AND availableOn > now      → 'aguardando_liberacao'
 *   - aprovado AND availableOn <= now     → 'disponivel'
 */
function deriveLiberacao(
  status: Pagamento['status'],
  availableOn: Date | null | undefined,
  now: Date,
): Liberacao {
  if (status !== 'aprovado') return null;
  // Loose-equality catches both null AND undefined — old test fixtures
  // built pre-mjgxe (with `as never` casts) lack the field; production
  // entities always carry null at minimum (set in criarPagamentoPendente).
  if (availableOn == null) return 'aguardando_liberacao';
  return availableOn.getTime() <= now.getTime() ? 'disponivel' : 'aguardando_liberacao';
}

function toPagamentoAdminDTO(p: Pagamento, now: Date): PagamentoAdminDTO {
  return {
    id: p.id,
    status: p.status,
    criadoEm: p.criadoEm.toISOString(),
    atualizadoEm: p.atualizadoEm.toISOString(),
    liberacao: deriveLiberacao(p.status, p.intencao.balanceTransactionAvailableOn ?? null, now),
    availableOn: p.intencao.balanceTransactionAvailableOn?.toISOString() ?? null,
    intencao: {
      id: p.intencao.id,
      idContribuicao: p.intencao.idContribuicao,
      amountCents: p.intencao.amountCents as unknown as number,
      metodo: p.intencao.metodo,
      externalRef: p.intencao.externalRef,
      criadaEm: p.intencao.criadaEm.toISOString(),
      // aperture-xfw5c: surface the contribuinte the webhook stamped at
      // `checkout.session.completed`. Engine's DadosContribuinte carries
      // `mensagem?: string` (optional); the DTO schema is `string | null`
      // (nullable + required) — normalise undefined → null at the
      // boundary so the wire shape stays uniform across rows that did vs
      // didn't capture the optional recadinho.
      contribuinte:
        p.intencao.contribuinte === null
          ? null
          : {
              nome: p.intencao.contribuinte.nome,
              email: p.intencao.contribuinte.email,
              mensagem: p.intencao.contribuinte.mensagem ?? null,
            },
      composicaoValores: {
        idContribuicao: p.intencao.composicaoValores.idContribuicao,
        contributionAmountCents: p.intencao.composicaoValores
          .contributionAmountCents as unknown as number,
        feeAmountCents: p.intencao.composicaoValores
          .feeAmountCents as unknown as number,
        surchargeCents: p.intencao.composicaoValores.surchargeCents,
        totalPaidCents: p.intencao.composicaoValores
          .totalPaidCents as unknown as number,
        receiverAmountCents: p.intencao.composicaoValores
          .receiverAmountCents as unknown as number,
        responsavelTaxa: p.intencao.composicaoValores.responsavelTaxa,
      },
    },
    transacaoExterna:
      p.transacaoExterna === undefined
        ? undefined
        : {
            id: p.transacaoExterna.id,
            provedor: p.transacaoExterna.provedor,
            status: p.transacaoExterna.status,
            amountCents: p.transacaoExterna.amountCents as unknown as number,
            criadaEm: p.transacaoExterna.criadaEm.toISOString(),
            statusBruto: p.transacaoExterna.statusBruto,
          },
  };
}

const pagamentosRouter = t.router({
  /**
   * All pagamentos for a contribuicao, sorted criadoEm DESC (latest first).
   * Each pagamento now carries its lançamentos inline (plan 0015 /
   * aperture-aqlv2 — Financeiro is a MODULE UNDER Pagamentos, so the
   * BC-collapsed UI nests lançamentos under each pagamento block).
   *
   * Tenant guard: resolves the contribuicao → campanha → idPlataforma chain.
   * Unknown contribuicao or cross-tenant campanha → empty list (no leak).
   *
   * Composition: for each pagamento p, calls
   * `livroFinanceiroRepository.findLancamentosByIdPagamento(p.id)`. N+1
   * by design — same shape as `financeiro.listByContribuicao` and N is
   * bounded small (≤3 pagamentos/contribuicao in practice). Pendente,
   * processing, rejeitado, and estornado pagamentos yield empty arrays
   * (lançamentos only exist for aprovado; estornado rows have
   * canceladoEm set but the rows themselves persist for the audit
   * trail).
   *
   * The pre-existing `financeiro.listByContribuicao` endpoint stays in
   * place — it has its own LancamentosByPagamento shape that other
   * callers may depend on. Future cleanup: deprecate that endpoint
   * after grep confirms it's only Vance's frontend that consumed it
   * and the frontend has fully migrated to the nested shape here.
   */
  listByContribuicao: t.procedure
    .input(z.object({ idContribuicao: z.string() }))
    .output(
      z.object({
        pagamentos: z.array(PagamentoWithLancamentosAdminDTOSchema),
      }),
    )
    .query(async ({ ctx, input }) => {
      const contribuicao = await ctx.deps.contribuicaoRepository.findById(
        input.idContribuicao as IdContribuicao,
      );
      if (!contribuicao) return { pagamentos: [] };

      const campanha = await ctx.deps.campanhaRepository.findById(
        contribuicao.idCampanha,
      );
      if (!campanha) return { pagamentos: [] };
      if (campanha.idPlataforma !== ID_PLATAFORMA_EUNENEM) {
        return { pagamentos: [] };
      }

      const pagamentos =
        await ctx.deps.pagamentoRepository.findByContribuicao(
          input.idContribuicao as IdContribuicaoPagamento,
        );

      // Plan 0015 / aperture-mjgxe: snapshot "now" once for the whole
      // query so every pagamento in the list derives liberação against
      // the same reference timestamp (no cross-row jitter on rapid
      // re-renders).
      const now = ctx.deps.clock();

      // Compose lançamentos per pagamento (plan 0015 BC reshape — see
      // header). N+1 by design: N ≤ ~3 in practice; bulk port lookup
      // is a +1 engine bead we don't need yet.
      const enriched = await Promise.all(
        pagamentos.map(async (p) => {
          const lancamentos =
            await ctx.deps.livroFinanceiroRepository.findLancamentosByIdPagamento(
              p.id as unknown as IdPagamentoReferencia,
            );
          return {
            pagamentoDTO: toPagamentoAdminDTO(p, now),
            criadoEm: p.criadoEm,
            lancamentosDTO: lancamentos.map(toLancamentoAdminDTO),
          };
        }),
      );

      // Engine port returns criadoEm ASC; admin UI wants DESC.
      enriched.sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime());

      return {
        pagamentos: enriched.map((e) => ({
          ...e.pagamentoDTO,
          lancamentos: e.lancamentosDTO,
        })),
      };
    }),
});

/* ─────────────────────────────────────────────────────────────────────────
 * webhooks — payment_webhook_events trail per pagamento (aperture-2sp6m).
 *
 * Parent epic: aperture-3zxkn (operator wants webhook trails visible on
 * /admin/contribuicao/:id detail page).
 *
 * Two procedures:
 *   - `listByPagamento({ idPagamento })` — LEAN DTO array (no rawPayload,
 *     no signatureHeader). Tenant guard returns 403 on cross-plataforma.
 *   - `getEventDetail({ idEvent })` — FULL DTO including rawPayload +
 *     signatureHeader for the "Ver payload" modal. Orphan events
 *     (pagamento_id NULL) throw 403; unknown ids throw 404.
 *
 * Tenant guard: webhook event → pagamento → contribuicao → campanha →
 * idPlataforma. The helper `resolveAdminPagamentoContext` factors this
 * out — both procedures use it, and a future admin.pagamentos refactor
 * can adopt it too. Distinct from the silent-empty-array pattern in
 * pagamentos.listByContribuicao + financeiro.listByContribuicao: those
 * procedures take a contribuicao id and return empty on miss/cross-tenant
 * (matches contribuicoes.findById null behavior); these throw concrete
 * 404/403/500 so the admin UI can distinguish "no events yet" (empty
 * array, success) from "you don't have access" (403).
 * ────────────────────────────────────────────────────────────────────── */

const WebhookEventAdminDTOSchema = z.object({
  id: z.string(),
  provider: z.string(),
  eventType: z.string(),
  receivedAt: z.string(), // ISO
  signatureValid: z.boolean(),
  processedAt: z.string().nullable(), // ISO | null
  processingError: z.string().nullable(),
  pagamentoId: z.string().nullable(),
});
export type WebhookEventAdminDTO = z.infer<typeof WebhookEventAdminDTOSchema>;

const WebhookEventDetailDTOSchema = WebhookEventAdminDTOSchema.extend({
  rawPayload: z.unknown(),
  signatureHeader: z.string(),
});
export type WebhookEventDetailDTO = z.infer<typeof WebhookEventDetailDTOSchema>;

/**
 * Resolve the admin tenant-guard chain from a `pagamentoId`. Throws:
 *   - 404 `pagamento_nao_encontrado` when the pagamento doesn't exist
 *   - 500 `dados_corrompidos` when the contribuicao/campanha chain is broken
 *   - 403 `tenant_mismatch` when the campanha is on a different plataforma
 *
 * Returns the resolved `{ pagamento, contribuicao, campanha }` triple so
 * callers can pass any of them to downstream queries without re-fetching.
 */
async function resolveAdminPagamentoContext(
  ctx: TrpcContext,
  idPagamento: string,
): Promise<{
  pagamento: Pagamento;
  contribuicao: Contribuicao;
  campanha: Campanha;
}> {
  const pagamento = await ctx.deps.pagamentoRepository.findById(
    idPagamento as never,
  );
  if (!pagamento) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "pagamento_nao_encontrado",
    });
  }
  const contribuicao = await ctx.deps.contribuicaoRepository.findById(
    pagamento.intencao.idContribuicao as unknown as IdContribuicao,
  );
  if (!contribuicao) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "dados_corrompidos: contribuicao_nao_encontrada",
    });
  }
  const campanha = await ctx.deps.campanhaRepository.findById(
    contribuicao.idCampanha,
  );
  if (!campanha) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "dados_corrompidos: campanha_nao_encontrada",
    });
  }
  if (campanha.idPlataforma !== ID_PLATAFORMA_EUNENEM) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "tenant_mismatch",
    });
  }
  return { pagamento, contribuicao, campanha };
}

function toWebhookEventAdminDTO(record: {
  id: string;
  provider: string;
  eventType: string;
  receivedAt: Date;
  signatureValid: boolean;
  processedAt: Date | null;
  processingError: string | null;
  pagamentoId: string | null;
}): WebhookEventAdminDTO {
  return {
    id: record.id,
    provider: record.provider,
    eventType: record.eventType,
    receivedAt: record.receivedAt.toISOString(),
    signatureValid: record.signatureValid,
    processedAt: record.processedAt ? record.processedAt.toISOString() : null,
    processingError: record.processingError ?? null,
    pagamentoId: record.pagamentoId ?? null,
  };
}

const webhooksRouter = t.router({
  /**
   * All payment_webhook_events linked to a pagamento, ordered
   * `received_at ASC` (oldest first — visitor lifecycle reads top-to-
   * bottom). LEAN DTO: no rawPayload, no signatureHeader. The
   * "Ver payload" affordance fetches getEventDetail on demand.
   */
  listByPagamento: t.procedure
    .input(z.object({ idPagamento: z.string() }))
    .output(z.object({ events: z.array(WebhookEventAdminDTOSchema) }))
    .query(async ({ ctx, input }) => {
      // Tenant guard: resolves pagamento → contribuicao → campanha →
      // plataforma. Throws 404 if pagamento missing, 403 if cross-tenant.
      await resolveAdminPagamentoContext(ctx, input.idPagamento);

      const records = await ctx.deps.webhookEventArchive.findByPagamentoId(
        input.idPagamento,
        { orderBy: "received_at_asc" },
      );
      return { events: records.map(toWebhookEventAdminDTO) };
    }),

  /**
   * Full webhook event including rawPayload + signatureHeader. Powers
   * the "Ver payload" modal on the per-pagamento webhook list.
   *
   * Lifecycle:
   *   - 404 when the event id doesn't exist
   *   - 403 when the event is orphan (pagamento_id NULL) — orphan
   *     browsing is explicitly out of scope on the per-pagamento surface
   *   - 403 when the linked pagamento's campanha is on a different
   *     plataforma
   */
  getEventDetail: t.procedure
    .input(z.object({ idEvent: z.string() }))
    .output(z.object({ event: WebhookEventDetailDTOSchema }))
    .query(async ({ ctx, input }) => {
      const event = await ctx.deps.webhookEventArchive.findById(input.idEvent);
      if (!event) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "evento_nao_encontrado",
        });
      }
      if (event.pagamentoId === null) {
        // Orphan event — never expose via the per-pagamento surface.
        // Operator browses orphans via a separate (out-of-scope) page.
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "evento_orfao_fora_do_escopo",
        });
      }
      // Tenant guard — same chain as listByPagamento; throws 403 on
      // cross-tenant. We don't read the resolved triple here (the event
      // itself carries everything we need), but the guard is what
      // enforces the boundary.
      await resolveAdminPagamentoContext(ctx, event.pagamentoId);

      return {
        event: {
          ...toWebhookEventAdminDTO(event),
          rawPayload: event.rawPayload,
          signatureHeader: event.signatureHeader,
        },
      };
    }),
});

/* ─────────────────────────────────────────────────────────────────────────
 * repasses — aperture-riywh (Track 3 backend).
 *
 * Admin queue + drill-down + approval for RepasseRecebedor (the 2-state
 * FSM landed in Track 1 / aperture-s03dr). Three procedures:
 *
 *   1. list({ statusFilter, cursor, limit })
 *      Cursor-paginated browse across ALL campanhas (defaults to
 *      statusFilter='solicitado' — the action queue). Each row carries
 *      campanha title + recebedor name lookups (N+1 by design — admin
 *      queue is bounded small). Returns totalCount so the UI can render
 *      "N pendentes" without exhausting pagination.
 *
 *   2. aprovar({ idRepasse, bankTransferRef })
 *      Wraps `aprovarRepasseRecebedor` use-case from Track 1.
 *      Idempotent at same terminal state. Typed errors map to TRPCError:
 *        - FinanceiroRepasseNaoEncontradoError → NOT_FOUND
 *        - FinanceiroRepasseStatusInvalidoError → CONFLICT
 *        - FinanceiroInputInvalidoError → BAD_REQUEST
 *
 *   3. show({ idRepasse })
 *      Drill-down detail: repasse summary + linked lançamentos. Each
 *      lançamento gets contribuição-aware enrichment (contribuinte
 *      name from the parent pagamento's intencao).
 *
 * Vance scaffolds the /admin/repasses UI (bead aperture-vi0hy) against
 * the schemas EXPORTED from this block. Parallel-prep per
 * specialist-delegation §9 + contract-pinning 4-layer defense.
 *
 * Supersedes aperture-09hap (admin marcarLancamentoTransferido tRPC) —
 * the approval path is now the bulk transition under aprovar, not a
 * per-lançamento flip.
 * ────────────────────────────────────────────────────────────────────── */

const RepasseStatusSchema = z.enum(["solicitado", "aprovado"]);
export type RepasseStatus = z.infer<typeof RepasseStatusSchema>;

const RepasseAdminDTOSchema = z.object({
  idRepasse: z.string(),
  idCampanha: z.string(),
  campanhaTitulo: z.string(),
  recebedorNome: z.string().nullable(),
  amountCents: z.number().int().nonnegative(),
  numLancamentos: z.number().int().nonnegative(),
  status: RepasseStatusSchema,
  solicitadoEm: z.string(),
  aprovadoEm: z.string().nullable(),
  bankTransferRef: z.string().nullable(),
});
export type RepasseAdminDTO = z.infer<typeof RepasseAdminDTOSchema>;

const RepasseLancamentoDetailSchema = z.object({
  idLancamento: z.string(),
  idPagamento: z.string(),
  idContribuicao: z.string(),
  amountCents: z.number().int().nonnegative(),
  contribuinteNome: z.string().nullable(),
  pagamentoCriadoEm: z.string(),
});
export type RepasseLancamentoDetail = z.infer<typeof RepasseLancamentoDetailSchema>;

const RepasseDetailDTOSchema = RepasseAdminDTOSchema.extend({
  lancamentos: z.array(RepasseLancamentoDetailSchema),
});
export type RepasseDetailDTO = z.infer<typeof RepasseDetailDTOSchema>;

const RepassesListInputSchema = z.object({
  statusFilter: RepasseStatusSchema.or(z.literal("all")).default("solicitado"),
  cursor: z.string().nullable(),
  limit: z.number().int().min(1).max(100).default(20),
});

const RepassesListOutputSchema = z.object({
  rows: z.array(RepasseAdminDTOSchema),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().min(0),
});

const RepassesAprovarInputSchema = z.object({
  idRepasse: z.string().uuid(),
  bankTransferRef: z.string().min(1).max(255).nullable().default(null),
});

const RepassesAprovarOutputSchema = z.object({
  idRepasse: z.string(),
  aprovadoEm: z.string(),
  numLancamentosTransferidos: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
});

const RepassesShowInputSchema = z.object({
  idRepasse: z.string().uuid(),
});

const RepassesShowOutputSchema = z.object({
  repasse: RepasseDetailDTOSchema.nullable(),
});

function toRepasseAdminDTO(
  repasse: {
    id: string;
    idCampanha: string;
    amountCents: number;
    status: RepasseStatus;
    solicitadoEm: Date;
    aprovadoEm: Date | null;
    bankTransferRef: string | null;
  },
  campanhaTitulo: string,
  recebedorNome: string | null,
  numLancamentos: number,
): RepasseAdminDTO {
  return {
    idRepasse: repasse.id,
    idCampanha: repasse.idCampanha,
    campanhaTitulo,
    recebedorNome,
    amountCents: repasse.amountCents as unknown as number,
    numLancamentos,
    status: repasse.status,
    solicitadoEm: repasse.solicitadoEm.toISOString(),
    aprovadoEm: repasse.aprovadoEm?.toISOString() ?? null,
    bankTransferRef: repasse.bankTransferRef,
  };
}

const repassesRouter = t.router({
  list: t.procedure
    .input(RepassesListInputSchema)
    .output(RepassesListOutputSchema)
    .query(async ({ ctx, input }) => {
      const { repasses, nextCursor, totalCount } =
        await ctx.deps.livroFinanceiroRepository.findRepassesPaginated({
          statusFilter: input.statusFilter,
          cursor: input.cursor,
          limit: input.limit,
        });

      const rows: RepasseAdminDTO[] = (
        await Promise.all(
          repasses.map(async (r) => {
            const campanha = await ctx.deps.campanhaRepository.findById(
              r.idCampanha as IdCampanha,
            );
            // Tenant filter — defensive across plataformas.
            if (campanha && campanha.idPlataforma !== ID_PLATAFORMA_EUNENEM) {
              return null;
            }
            const titulo = campanha?.titulo ?? "(campanha removida)";
            const recebedorAtivo =
              await ctx.deps.recebedorRepository.findAtivoByCampanhaId(
                r.idCampanha as IdCampanha,
              );
            const recebedorNome =
              recebedorAtivo?.dadosRecebedor.nomeTitular ?? null;
            const linked =
              await ctx.deps.livroFinanceiroRepository.findLancamentosByIdRepasse(
                r.id,
              );
            return toRepasseAdminDTO(r, titulo, recebedorNome, linked.length);
          }),
        )
      ).filter((row): row is RepasseAdminDTO => row !== null);

      return { rows, nextCursor, totalCount };
    }),

  aprovar: t.procedure
    .input(RepassesAprovarInputSchema)
    .output(RepassesAprovarOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await aprovarRepasseRecebedor(
          {
            livroFinanceiroRepository: ctx.deps.livroFinanceiroRepository,
            clock: ctx.deps.clock,
            observability: ctx.deps.observability,
          },
          {
            idRepasse: input.idRepasse as never,
            bankTransferRef: input.bankTransferRef,
          },
        );

        return {
          idRepasse: result.repasse.id,
          aprovadoEm: (
            result.repasse.aprovadoEm ?? ctx.deps.clock()
          ).toISOString(),
          numLancamentosTransferidos: result.lancamentosAfetados,
          totalCents: result.repasse.amountCents as unknown as number,
        };
      } catch (error: unknown) {
        if (error instanceof FinanceiroRepasseNaoEncontradoError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "repasse_nao_encontrado",
          });
        }
        if (error instanceof FinanceiroRepasseStatusInvalidoError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "repasse_status_invalido",
          });
        }
        if (error instanceof FinanceiroInputInvalidoError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.message,
          });
        }
        throw error;
      }
    }),

  show: t.procedure
    .input(RepassesShowInputSchema)
    .output(RepassesShowOutputSchema)
    .query(async ({ ctx, input }) => {
      const repasse = await ctx.deps.livroFinanceiroRepository.findRepasseById(
        input.idRepasse as never,
      );
      if (!repasse) return { repasse: null };

      const campanha = await ctx.deps.campanhaRepository.findById(
        repasse.idCampanha as IdCampanha,
      );
      if (!campanha || campanha.idPlataforma !== ID_PLATAFORMA_EUNENEM) {
        return { repasse: null };
      }
      const recebedorAtivo =
        await ctx.deps.recebedorRepository.findAtivoByCampanhaId(
          repasse.idCampanha as IdCampanha,
        );
      const linked =
        await ctx.deps.livroFinanceiroRepository.findLancamentosByIdRepasse(
          repasse.id,
        );

      const lancamentos: RepasseLancamentoDetail[] = await Promise.all(
        linked.map(async (l) => {
          const pagamento = await ctx.deps.pagamentoRepository.findById(
            l.idPagamento as never,
          );
          const contribuinteNome =
            pagamento?.intencao.contribuinte?.nome ?? null;
          const pagamentoCriadoEm = (
            pagamento?.criadoEm ?? l.criadoEm
          ).toISOString();
          return {
            idLancamento: l.id,
            idPagamento: l.idPagamento,
            idContribuicao: l.idContribuicao,
            amountCents: l.amountCents as unknown as number,
            contribuinteNome,
            pagamentoCriadoEm,
          };
        }),
      );

      const detailDTO: RepasseDetailDTO = {
        ...toRepasseAdminDTO(
          repasse,
          campanha.titulo,
          recebedorAtivo?.dadosRecebedor.nomeTitular ?? null,
          linked.length,
        ),
        lancamentos,
      };

      return { repasse: detailDTO };
    }),
});

export const adminRouter = t.router({
  /** Nested sub-router for usuarios browse + paginated list. */
  usuarios: usuariosRouter,

  /**
   * Prefix-search usuarios by email. Case-insensitive (the postgres
   * adapter does `LOWER(email) ILIKE LOWER($2) || '%'`). Tenant-scoped to
   * ID_PLATAFORMA_EUNENEM. Empty/blank prefix → empty array (don't return
   * the full table). Bounded by `SEARCH_LIMIT`.
   *
   * Backed by `UsuarioRepository.findUsuariosByEmailPrefix` (engine
   * aperture-5d3yz / PR #93).
   */
  searchUsers: t.procedure
    .input(
      z.object({
        prefix: z.string().max(120),
      }),
    )
    .output(z.array(UsuarioMatchSchema))
    .query(async ({ ctx, input }) => {
      const cleaned = input.prefix.trim();
      if (cleaned === "") return [];

      const usuarios = await ctx.deps.usuarioRepository.findUsuariosByEmailPrefix(
        ID_PLATAFORMA_EUNENEM,
        cleaned,
        SEARCH_LIMIT,
      );

      return usuarios.map((u) => ({
        idConta: u.idConta,
        email: u.email,
        nomeExibicao: u.nomeExibicao,
      }));
    }),

  /**
   * Single usuario lookup by `idConta` (the public conta id from URL).
   * Used by the /admin/usuario/:idConta detail page after the picker
   * hands off the id. Returns null when nothing matches OR when the
   * resolved Usuario is on a different plataforma — the page renders
   * a 404 either way.
   *
   * Backed by `UsuarioRepository.findUsuarioByConta` (aperture-lp9cw):
   * single-query JOIN that collapses the legacy 2-hop pattern
   * (findContaById → findUsuarioById → manual tenant filter) into one
   * round-trip. Tenant guard is enforced by the port itself — the
   * `idPlataforma` arg is part of the WHERE clause, so a wrong-tenant
   * idConta returns undefined rather than leaking a cross-plataforma
   * Usuario.
   */
  findUsuarioByConta: t.procedure
    .input(
      z.object({
        idConta: z.string(),
      }),
    )
    .output(UsuarioMatchSchema.nullable())
    .query(async ({ ctx, input }) => {
      const usuario = await ctx.deps.usuarioRepository.findUsuarioByConta(
        input.idConta as never,
        ID_PLATAFORMA_EUNENEM as never,
      );
      if (!usuario) return null;
      return {
        idConta: usuario.idConta,
        email: usuario.email,
        nomeExibicao: usuario.nomeExibicao,
      };
    }),

  campanhas: campanhasRouter,

  /** Nested sub-router for contribuicoes drill + multi-aggregate detail (W3). */
  contribuicoes: contribuicoesRouter,

  /** Nested sub-router for pagamentos lifecycle list per contribuicao (W4). */
  pagamentos: pagamentosRouter,

  /** Nested sub-router for the Financeiro BC lancamentos drill (W5). */
  financeiro: financeiroRouter,

  /**
   * Per-pagamento webhook event trail (aperture-2sp6m). Powers the
   * "Eventos webhook" expandable affordance on /admin/contribuicao/:id
   * (Vance bead aperture-pf348).
   */
  webhooks: webhooksRouter,

  /**
   * Admin queue + drill-down + approval for RepasseRecebedor
   * (aperture-riywh). Powers the new top-level /admin/repasses tab
   * (Vance bead aperture-vi0hy).
   */
  repasses: repassesRouter,
});
