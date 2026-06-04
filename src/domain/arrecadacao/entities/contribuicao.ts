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
  criadaEm: Date;
}): Contribuicao {
  return {
    id: params.id,
    idCampanha: params.idCampanha,
    idOpcaoContribuicao: params.idOpcaoContribuicao,
    nome: params.nome,
    valor: params.valor,
    imagemUrl: params.imagemUrl ?? null,
    grupo: params.grupo ?? null,
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
  },
): Contribuicao {
  return {
    id: contribuicao.id,
    idCampanha: contribuicao.idCampanha,
    idOpcaoContribuicao: contribuicao.idOpcaoContribuicao,
    nome: patch.nome ?? contribuicao.nome,
    valor: patch.valor ?? contribuicao.valor,
    imagemUrl: patch.imagemUrl === undefined ? contribuicao.imagemUrl : patch.imagemUrl,
    grupo: patch.grupo === undefined ? contribuicao.grupo : patch.grupo,
    criadaEm: contribuicao.criadaEm,
  };
}
