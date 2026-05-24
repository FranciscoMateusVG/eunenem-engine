import type { IdPlataforma } from '../value-objects/ids.js';
import type { SlugPlataforma } from '../value-objects/slug-plataforma.js';

/**
 * @aggregateRoot Plataforma (BC Plataforma)
 *
 * The multi-tenant boundary of the engine. Each plataforma (eunenem,
 * eucasei, ...) is a white-label product running on the same engine, with
 * its own pricing (RegraTaxa), its own user base, and its own campanhas.
 *
 * Persisted via: `PlataformaRepository`. Minimum-viable shape today: id,
 * slug, display name, creation timestamp. Status lifecycle (ativa /
 * suspensa / arquivada) is deferred.
 *
 * Aggregate boundary: a Plataforma is a self-contained identity record. No
 * child entities live inside this aggregate. Other BCs reference it via
 * their own `IdPlataformaReferencia` mirror VOs — they do NOT import from
 * `src/domain/plataforma/`.
 */
export interface Plataforma {
  readonly id: IdPlataforma;
  readonly slug: SlugPlataforma;
  readonly nome: string;
  readonly criadaEm: Date;
}

export interface CriarPlataformaInput {
  readonly id: IdPlataforma;
  readonly slug: SlugPlataforma;
  readonly nome: string;
  readonly criadaEm: Date;
}

export function criarPlataforma(input: CriarPlataformaInput): Plataforma {
  return {
    id: input.id,
    slug: input.slug,
    nome: input.nome,
    criadaEm: input.criadaEm,
  };
}
