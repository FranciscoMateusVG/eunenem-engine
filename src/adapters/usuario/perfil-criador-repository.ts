import type { PerfilCriador } from '../../domain/usuario/entities/perfil-criador.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';

/**
 * Persistência do perfil do criador (porta) — aperture-3dlzs.
 *
 * 1:1 com Usuario: `save` é um upsert por `idUsuario` (idempotente), e a
 * busca canônica é por `idUsuario`. A identidade (`id`) e o `criadoEm` de um
 * perfil existente são preservados em saves subsequentes — o adapter é um
 * persistidor "burro"; o use-case (R3) decide criar-vs-atualizar.
 */
export interface PerfilCriadorRepository {
  save(perfil: PerfilCriador): Promise<void>;
  findByUsuarioId(idUsuario: IdUsuario): Promise<PerfilCriador | undefined>;
}
