import { ArrecadacaoCampanhaRecebedorInvarianteError } from '../../../errors/arrecadacao/campanha-recebedor-invariante.error.js';
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
 *   helpers; violation raises `ArrecadacaoCampanhaRecebedorInvarianteError`.
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
 * ou ambos preenchidos. Lança `ArrecadacaoCampanhaRecebedorInvarianteError`
 * em estado meio-nulo. Usado por todos os construtores/projeções do agregado.
 */
function assertInvarianteRecebedor(campanha: Campanha): void {
  const idVazio = campanha.idRecebedor === null;
  const dadosVazios = campanha.dadosRecebedor === null;
  if (idVazio !== dadosVazios) {
    throw new ArrecadacaoCampanhaRecebedorInvarianteError(campanha.id);
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
  params: Omit<Campanha, 'idRecebedor' | 'dadosRecebedor'> & {
    readonly recebedor: Recebedor;
  },
): Campanha {
  const { recebedor, ...rest } = params;
  const next: Campanha = {
    ...rest,
    idRecebedor: recebedor.id,
    dadosRecebedor: recebedor.dadosRecebedor,
  };
  assertInvarianteRecebedor(next);
  return next;
}

/** Monta campanha sem recebedor (lifecycle: pre-bank-info). */
export function criarCampanhaSemRecebedor(
  params: Omit<Campanha, 'idRecebedor' | 'dadosRecebedor'>,
): Campanha {
  const next: Campanha = {
    ...params,
    idRecebedor: null,
    dadosRecebedor: null,
  };
  assertInvarianteRecebedor(next);
  return next;
}
