import type { Database } from '../../src/adapters/database.js';

/** Trunca tabelas do BC Arrecadação respeitando FKs. */
export async function truncateArrecadacaoTables(db: Database): Promise<void> {
  await db.deleteFrom('contribuicoes').execute();
  await db.deleteFrom('opcoes_contribuicao').execute();
  await db.deleteFrom('campanha_administradores').execute();
  await db.deleteFrom('campanhas').execute();
}
