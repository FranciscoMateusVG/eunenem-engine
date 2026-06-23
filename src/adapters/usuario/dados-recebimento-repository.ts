import type { DadosRecebimentoUsuario } from '../../domain/usuario/entities/dados-recebimento-usuario.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';

/**
 * Persistência dos dados de recebimento do usuário (porta) — aperture-mcvyw.
 *
 * 1:1 com Usuario: `save` é um upsert por `idUsuario` (idempotente) e a busca
 * canônica é por `idUsuario`. O adapter é um persistidor "burro"; o use-case
 * decide criar-vs-atualizar.
 */
export interface DadosRecebimentoRepository {
  save(registro: DadosRecebimentoUsuario): Promise<void>;
  findByUsuarioId(idUsuario: IdUsuario): Promise<DadosRecebimentoUsuario | undefined>;
}
