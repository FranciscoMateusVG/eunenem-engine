import type { Database } from '../../src/adapters/database.js';

/** Trunca tabelas do BC Evento respeitando as FKs. */
export async function truncateEventoTables(db: Database): Promise<void> {
  await db.deleteFrom('convidados').execute();
  await db.deleteFrom('listas_de_convidados').execute();
  await db.deleteFrom('convites').execute();
  await db.deleteFrom('eventos').execute();
}
