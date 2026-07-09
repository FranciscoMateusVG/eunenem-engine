import type { DadosRecebedor } from '../value-objects/dados-recebedor.js';
import type {
  IdCampanha,
  IdConta,
  IdOpcaoContribuicao,
  IdPlataformaReferencia,
  IdRecebedor,
} from '../value-objects/ids.js';
import type { OpcaoContribuicao } from '../value-objects/opcao-contribuicao.js';
import type { Recebedor } from './recebedor.js';

/**
 * @aggregateRoot Campanha (BC Arrecadação)
 *
 * Owns: `idsAdministradores`, `opcoes` (sacolas), `titulo`, plus a projection of
 * the active recebedor's data (`idRecebedor` + `dadosRecebedor` snapshot).
 *
 * Lifecycle — Recebedor is OPTIONAL:
 *   A campanha CAN exist without a Recebedor (e.g. just after signup, before the
 *   user has provided bank info). Creation, contributions, payment-aproval flows
 *   all work without one. Only the withdrawal flow (`iniciarRepasseRecebedor`)
 *   gates on its presence — it throws `CheckoutCampanhaSemRecebedorError` when
 *   absent. Helper: `campanhaTemRecebedor(campanha)`.
 *
 * TOGETHER invariant:
 *   `idRecebedor` and `dadosRecebedor` are either BOTH null or BOTH set —
 *   never half. The aggregate enforces this in its constructors and projection
 *   helpers; violation throws a plain `Error` (matches the convention used by
 *   other domain invariants — see `contribuicao.ts`). Structured-error classes
 *   live in `src/errors/` for use-case-level throws, not domain-level.
 *
 * Belongs to exactly one Plataforma (multi-tenant boundary): the
 * `idPlataforma` is immutable after creation and scopes all downstream
 * pricing (RegraTaxa lookup) and authorization decisions.
 *
 * Persisted via: `CampanhaRepository`.
 *
 * Aggregate boundary: changes to administradores, opções, or the active
 * recebedor projection happen atomically through this root.
 */
export interface Campanha {
  readonly id: IdCampanha;
  readonly idPlataforma: IdPlataformaReferencia;
  readonly idsAdministradores: readonly IdConta[];
  readonly idRecebedor: IdRecebedor | null;
  readonly dadosRecebedor: DadosRecebedor | null;
  readonly titulo: string;
  /**
   * The campanha's own URL segment (aperture-aphk8, W1a) — null until the
   * owner claims one via `campanhas.definirSlug`. Uniqueness is PER-CONTA,
   * enforced at the application layer (NOT a DB constraint): two different
   * contas may hold the same campanha slug.
   */
  readonly slug: string | null;
  readonly opcoes: readonly OpcaoContribuicao[];
  readonly criadaEm: Date;
}

/** True quando a campanha tem um Recebedor ativo projetado. */
export function campanhaTemRecebedor(campanha: Campanha): campanha is Campanha & {
  idRecebedor: IdRecebedor;
  dadosRecebedor: DadosRecebedor;
} {
  return campanha.idRecebedor !== null && campanha.dadosRecebedor !== null;
}

/**
 * Asserta o invariante TOGETHER: idRecebedor e dadosRecebedor ambos nulos
 * ou ambos preenchidos. Lança Error em estado meio-nulo. Usado por todos
 * os construtores/projeções do agregado como defense-in-depth contra
 * futuras helpers que mutem só um dos campos.
 */
function assertInvarianteRecebedor(campanha: Campanha): void {
  const idVazio = campanha.idRecebedor === null;
  const dadosVazios = campanha.dadosRecebedor === null;
  if (idVazio !== dadosVazios) {
    throw new Error(
      `Invariante TOGETHER violado: campanha "${campanha.id}" deve ter idRecebedor e dadosRecebedor ambos nulos ou ambos preenchidos.`,
    );
  }
}

/** Indica se a conta é administradora da campanha. */
export function campanhaPossuiAdministrador(campanha: Campanha, idConta: IdConta): boolean {
  return campanha.idsAdministradores.includes(idConta);
}

/** Anexa um administrador, imutavelmente. O caso de uso deve garantir ausência de duplicados. */
export function campanhaComAdministrador(campanha: Campanha, idConta: IdConta): Campanha {
  return {
    ...campanha,
    idsAdministradores: [...campanha.idsAdministradores, idConta],
  };
}

/** Remove um administrador, imutavelmente. O caso de uso deve garantir que reste pelo menos um. */
export function campanhaSemAdministrador(campanha: Campanha, idConta: IdConta): Campanha {
  return {
    ...campanha,
    idsAdministradores: campanha.idsAdministradores.filter((id) => id !== idConta),
  };
}

/** Procura uma opção de contribuição (sacola) na campanha. */
export function encontrarOpcaoContribuicao(
  campanha: Campanha,
  idOpcao: IdOpcaoContribuicao,
): OpcaoContribuicao | undefined {
  return campanha.opcoes.find((o) => o.id === idOpcao);
}

/** Anexa uma opção, imutavelmente. O caso de uso deve garantir ausência de duplicados de `opcao.id`. */
export function campanhaComOpcao(campanha: Campanha, opcao: OpcaoContribuicao): Campanha {
  return {
    ...campanha,
    opcoes: [...campanha.opcoes, opcao],
  };
}

/** Projeta na campanha o recebedor ativo. */
export function campanhaComRecebedorAtivo(campanha: Campanha, recebedor: Recebedor): Campanha {
  const next: Campanha = {
    ...campanha,
    idRecebedor: recebedor.id,
    dadosRecebedor: recebedor.dadosRecebedor,
  };
  assertInvarianteRecebedor(next);
  return next;
}

/** Limpa a projeção de Recebedor da campanha (mantém o invariante TOGETHER). */
export function campanhaSemRecebedor(campanha: Campanha): Campanha {
  const next: Campanha = {
    ...campanha,
    idRecebedor: null,
    dadosRecebedor: null,
  };
  assertInvarianteRecebedor(next);
  return next;
}

/** Monta campanha a partir de metadados e recebedor inicial ativo. */
export function campanhaComRecebedorInicial(
  params: Omit<Campanha, 'idRecebedor' | 'dadosRecebedor' | 'slug'> & {
    readonly recebedor: Recebedor;
    /** Optional — defaults to null (aperture-aphk8; keeps existing call-sites intact). */
    readonly slug?: string | null;
  },
): Campanha {
  const { recebedor, slug, ...rest } = params;
  const next: Campanha = {
    ...rest,
    slug: slug ?? null,
    idRecebedor: recebedor.id,
    dadosRecebedor: recebedor.dadosRecebedor,
  };
  assertInvarianteRecebedor(next);
  return next;
}

/** Monta campanha sem recebedor (lifecycle: pre-bank-info). */
export function criarCampanhaSemRecebedor(
  params: Omit<Campanha, 'idRecebedor' | 'dadosRecebedor' | 'slug'> & {
    /** Optional — defaults to null (aperture-aphk8; keeps existing call-sites intact). */
    readonly slug?: string | null;
  },
): Campanha {
  const { slug, ...rest } = params;
  const next: Campanha = {
    ...rest,
    slug: slug ?? null,
    idRecebedor: null,
    dadosRecebedor: null,
  };
  assertInvarianteRecebedor(next);
  return next;
}
