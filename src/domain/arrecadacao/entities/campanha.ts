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
  readonly idRecebedor: IdRecebedor;
  readonly dadosRecebedor: DadosRecebedor;
  readonly titulo: string;
  readonly opcoes: readonly OpcaoContribuicao[];
  readonly criadaEm: Date;
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
  return {
    ...campanha,
    idRecebedor: recebedor.id,
    dadosRecebedor: recebedor.dadosRecebedor,
  };
}

/** Monta campanha a partir de metadados e recebedor inicial ativo. */
export function campanhaComRecebedorInicial(
  params: Omit<Campanha, 'idRecebedor' | 'dadosRecebedor'> & {
    readonly recebedor: Recebedor;
  },
): Campanha {
  const { recebedor, ...rest } = params;
  return {
    ...rest,
    idRecebedor: recebedor.id,
    dadosRecebedor: recebedor.dadosRecebedor,
  };
}
