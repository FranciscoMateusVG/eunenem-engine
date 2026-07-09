import type { PerfilCampanha } from '../../domain/arrecadacao/entities/perfil-campanha.js';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Persistência do perfil da campanha (porta) — aperture-aphk8 (W1a).
 *
 * 1:1 com Campanha: `save` é um upsert por `idCampanha` (idempotente), e a
 * busca canônica é por `idCampanha`. A identidade (`id`) e o `criadoEm` de um
 * perfil existente são preservados em saves subsequentes — o adapter é um
 * persistidor "burro"; o caller decide criar-vs-atualizar. Espelha
 * `PerfilCriadorRepository` (1:1 com Usuario) campo a campo.
 */
export interface PerfilCampanhaRepository {
  save(perfil: PerfilCampanha): Promise<void>;
  findByIdCampanha(idCampanha: IdCampanha): Promise<PerfilCampanha | undefined>;
}
