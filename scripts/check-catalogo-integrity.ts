import { sql } from 'kysely';
import { createDatabase, type Database } from '../src/adapters/database.js';

interface CatalogoIntegrityReport {
  readonly categorias: number;
  readonly produtos: number;
  readonly produtosAtivos: number;
  readonly produtosLegados: number;
  readonly listas: number;
  readonly listasAtivas: number;
  readonly itens: number;
  readonly categoriasSemProdutos: number;
  readonly produtosOrfaos: number;
  readonly itensOrfaos: number;
}

function toCount(value: string | number | bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid database count: ${String(value)}`);
  }
  return parsed;
}

async function checkCatalogoIntegrity(db: Database): Promise<CatalogoIntegrityReport> {
  const queryResult = await sql<{
    categorias: string;
    produtos: string;
    produtos_ativos: string;
    produtos_legados: string;
    listas: string;
    listas_ativas: string;
    itens: string;
    categorias_sem_produtos: string;
    produtos_orfaos: string;
    itens_orfaos: string;
  }>`
    SELECT
      (SELECT count(*) FROM catalogo_categorias) AS categorias,
      (SELECT count(*) FROM catalogo_produtos) AS produtos,
      (SELECT count(*) FROM catalogo_produtos WHERE ativo) AS produtos_ativos,
      (SELECT count(*) FROM catalogo_produtos WHERE id_legado IS NOT NULL) AS produtos_legados,
      (SELECT count(*) FROM catalogo_listas) AS listas,
      (SELECT count(*) FROM catalogo_listas WHERE ativo) AS listas_ativas,
      (SELECT count(*) FROM catalogo_lista_itens) AS itens,
      (
        SELECT count(*)
        FROM catalogo_categorias c
        WHERE NOT EXISTS (
          SELECT 1 FROM catalogo_produtos p WHERE p.id_categoria = c.id
        )
      ) AS categorias_sem_produtos,
      (
        SELECT count(*)
        FROM catalogo_produtos p
        LEFT JOIN catalogo_categorias c ON c.id = p.id_categoria
        WHERE c.id IS NULL
      ) AS produtos_orfaos,
      (
        SELECT count(*)
        FROM catalogo_lista_itens li
        LEFT JOIN catalogo_listas l ON l.id = li.id_lista
        LEFT JOIN catalogo_produtos p ON p.id = li.id_produto
        WHERE l.id IS NULL OR p.id IS NULL
      ) AS itens_orfaos
  `.execute(db);
  const result = queryResult.rows[0];
  if (!result) {
    throw new Error('Catalog integrity query returned no row');
  }

  const report: CatalogoIntegrityReport = {
    categorias: toCount(result.categorias),
    produtos: toCount(result.produtos),
    produtosAtivos: toCount(result.produtos_ativos),
    produtosLegados: toCount(result.produtos_legados),
    listas: toCount(result.listas),
    listasAtivas: toCount(result.listas_ativas),
    itens: toCount(result.itens),
    categoriasSemProdutos: toCount(result.categorias_sem_produtos),
    produtosOrfaos: toCount(result.produtos_orfaos),
    itensOrfaos: toCount(result.itens_orfaos),
  };

  const failures = [
    report.categorias === 0 ? 'expected at least one category' : null,
    report.produtos < 501 ? `expected at least 501 products, got ${report.produtos}` : null,
    report.produtosAtivos === 0 ? 'expected at least one active product' : null,
    report.produtosLegados < 501
      ? `expected all 501 backfilled legacy IDs, got ${report.produtosLegados}`
      : null,
    report.listas === 0 ? 'expected at least one ready list' : null,
    report.listasAtivas === 0 ? 'expected at least one active ready list' : null,
    report.itens === 0 ? 'expected at least one ready-list item' : null,
    report.produtosOrfaos > 0 ? `${report.produtosOrfaos} orphan products` : null,
    report.itensOrfaos > 0 ? `${report.itensOrfaos} orphan ready-list items` : null,
  ].filter((failure): failure is string => failure !== null);

  if (failures.length > 0) {
    throw new Error(`Catalog integrity failed:\n- ${failures.join('\n- ')}`);
  }
  return report;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required and must be non-empty');
}

const db = createDatabase(databaseUrl);
try {
  const report = await checkCatalogoIntegrity(db);
  process.stdout.write(`Catalog integrity OK: ${JSON.stringify(report)}\n`);
} finally {
  await db.destroy();
}
