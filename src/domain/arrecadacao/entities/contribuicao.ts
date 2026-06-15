import { z } from 'zod/v4';
import type { MoneyCents } from '../../money.js';
import type { IdCampanha, IdContribuicao, IdOpcaoContribuicao } from '../value-objects/ids.js';

/**
 * @aggregateRoot Contribuição (BC Arrecadação)
 *
 * Slot definition inside an opção (sacola). Admin-owned, visitor-read-only.
 * No state machine, no contribuinte, no transitions.
 *
 * Persisted via: `ContribuicaoRepository`.
 *
 * **Plan 0015 collapse (aperture-7pqee).** Before 0015, Contribuição had:
 *   - a `status` enum (`disponivel | indisponivel`) mirroring whether a
 *     pagamento had claimed the slot;
 *   - a `contribuinte: DadosContribuinte | null` field set by the
 *     visitor at checkout-finalize time;
 *   - a saga that flipped the status atomically with contribuinte
 *     association.
 *
 * The mirror status was the source of race-condition concerns (backwards
 * transitions on estorno cascade, claim-vs-iframe-abandonment locking).
 * Plan 0015 collapses the model: contribuição becomes a pure slot
 * definition, contribuinte moves to IntencaoPagamento (per-pagamento
 * snapshot, since 1:N contribuição→pagamentos is now allowed), and the
 * "indisponivel" badge becomes a query-time predicate
 * (`EXISTS pagamento WHERE idContribuicao = X AND status='aprovado'`).
 *
 * Aggregate boundary: only admin patches go through this root. References
 * Campanha + OpcaoContribuicao by ID only — never imports those aggregates.
 *
 * `NomeContribuicao` is inlined here as an intrinsic field schema.
 *
 * **Plan 0016 multi-item + quantidade (aperture-aj8qw).** Contribuição
 * gains a single field — `quantidade: number` (default 1) — that lifts
 * cardinality onto the slot. Pre-0016, "5 wine glasses" meant 5
 * identical Contribuição rows; post-0016, it's 1 row with
 * `quantidade = 5`. The `indisponivel` boolean predicate retires;
 * `quantidadeRestante(c)` + `esgotada(c)` are the new query-time
 * predicates (live in use-case layer; see `quantidade-restante.ts`).
 * Operator-accepted overshoot (locked decision #10): `quantidadeRestante`
 * can return ≤ 0 when more items got bought than the slot holds; the
 * domain doesn't reject this, it surfaces `esgotada = true`.
 */

/**
 * Limite por opção de contribuição — guardrail de escala. Cap deliberadamente
 * baixo porque ninguém precisa de mais que 10k items em uma única "sacola"
 * (presentes/rifa/convite) e o cap protege a leitura full-list de virar um
 * problema de payload/renderização antes de termos paginação no repo.
 * Quando virar tight, o caminho é introduzir `listPaged` no
 * `ContribuicaoRepository` (ver plano deferido `0004`).
 */
export const LIMITE_CONTRIBUICOES_POR_OPCAO = 10_000;

export const NomeContribuicaoSchema = z
  .string()
  .trim()
  .min(1, 'Nome da contribuicao nao pode ser vazio')
  .max(120);

export interface Contribuicao {
  readonly id: IdContribuicao;
  readonly idCampanha: IdCampanha;
  readonly idOpcaoContribuicao: IdOpcaoContribuicao;
  readonly nome: string;
  readonly valor: MoneyCents;
  readonly imagemUrl: string | null;
  /**
   * Agrupamento opcional para a UI da loja (ex: "vestuário", "alimentação"
   * dentro de uma opção `presente`). Sem semântica de domínio — não afeta
   * preço nem financeiro; só organiza a exibição. `null` quando o tipo da
   * opção não se beneficia de grupos (ex: rifa).
   */
  readonly grupo: string | null;
  /**
   * Plan 0016 (aperture-aj8qw): cardinality of the slot — how many
   * exemplares the admin's listing represents. Positive integer (DB-side
   * CHECK + schema-time validation). Defaults to 1 at construction; the
   * pre-0016 "1 row per countable thing" pattern is the workaround this
   * field eliminates.
   *
   * `quantidadeRestante(c)` derives from this minus the sum of
   * `intencao_items.quantidade` across `aprovado` pagamentos pointing at
   * `c`. Overshoot is fine (locked decision #10) — `quantidadeRestante`
   * can return ≤ 0; `esgotada` returns true.
   */
  readonly quantidade: number;
  readonly criadaEm: Date;
}

/** Monta um slot de contribuição criado pelo administrador. */
export function criarContribuicao(params: {
  id: IdContribuicao;
  idCampanha: IdCampanha;
  idOpcaoContribuicao: IdOpcaoContribuicao;
  nome: string;
  valor: MoneyCents;
  imagemUrl?: string | null;
  grupo?: string | null;
  /**
   * Plan 0016 (aperture-aj8qw): opcional na construção; defaulta para 1.
   * Validado como inteiro positivo (DB-side CHECK + zod-style
   * application-layer validation on the use-case boundary). Lift de
   * cardinalidade pra slot — 5 taças de vinho = 1 contribuição com
   * `quantidade = 5`, não 5 linhas idênticas.
   */
  quantidade?: number;
  criadaEm: Date;
}): Contribuicao {
  const quantidade = params.quantidade ?? 1;
  if (!Number.isInteger(quantidade) || quantidade < 1) {
    throw new Error(
      `Quantidade da contribuição deve ser um inteiro positivo (recebido: ${quantidade}).`,
    );
  }
  return {
    id: params.id,
    idCampanha: params.idCampanha,
    idOpcaoContribuicao: params.idOpcaoContribuicao,
    nome: params.nome,
    valor: params.valor,
    imagemUrl: params.imagemUrl ?? null,
    grupo: params.grupo ?? null,
    quantidade,
    criadaEm: params.criadaEm,
  };
}

/**
 * Patch de campos administrativos editáveis. Aplica apenas as chaves
 * presentes em `patch` — campos omitidos preservam o valor atual. `null`
 * em `imagemUrl`/`grupo` é tratado como "limpar"; `undefined` é "não
 * alterar".
 *
 * **Plan 0015:** o guard de `status === 'disponivel'` foi removido. Sem
 * status na contribuição, o admin pode atualizar a qualquer momento. Se
 * houver pagamentos aprovados sobre a slot, a edição passa pelo
 * `contribuicaoEstaIndisponivel` query no use-case (Phase 2) — não é
 * uma invariante do agregado.
 */
export function contribuicaoAtualizada(
  contribuicao: Contribuicao,
  patch: {
    readonly nome?: string | undefined;
    readonly valor?: MoneyCents | undefined;
    readonly imagemUrl?: string | null | undefined;
    readonly grupo?: string | null | undefined;
    /**
     * Plan 0016 (aperture-aj8qw): admin pode ajustar a cardinalidade do
     * slot. Lowering below current sold count is allowed —
     * `quantidadeRestante` will go negative, `esgotada` returns true.
     * Operator-accepted per locked decision #10.
     */
    readonly quantidade?: number | undefined;
  },
): Contribuicao {
  const quantidade = patch.quantidade ?? contribuicao.quantidade;
  if (!Number.isInteger(quantidade) || quantidade < 1) {
    throw new Error(
      `Quantidade da contribuição deve ser um inteiro positivo (recebido: ${quantidade}).`,
    );
  }
  return {
    id: contribuicao.id,
    idCampanha: contribuicao.idCampanha,
    idOpcaoContribuicao: contribuicao.idOpcaoContribuicao,
    nome: patch.nome ?? contribuicao.nome,
    valor: patch.valor ?? contribuicao.valor,
    imagemUrl: patch.imagemUrl === undefined ? contribuicao.imagemUrl : patch.imagemUrl,
    grupo: patch.grupo === undefined ? contribuicao.grupo : patch.grupo,
    quantidade,
    criadaEm: contribuicao.criadaEm,
  };
}
