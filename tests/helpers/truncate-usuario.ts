import type { Database } from '../../src/adapters/database.js';

/**
 * Truncate Usuario BC tables between tests (aperture-xyhjr).
 *
 * `contas.id_usuario` has `ON DELETE CASCADE` against `usuarios.id`, so
 * deleting usuarios alone would also clear contas. Deleting both
 * explicitly is clearer + survives any future FK direction changes.
 */
export async function truncateUsuarioTables(db: Database): Promise<void> {
  await db.deleteFrom('contas').execute();
  await db.deleteFrom('usuarios').execute();
}
