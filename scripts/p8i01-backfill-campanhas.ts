/**
 * p8i01 — one-shot backfill: default Campanha + 'presente' OpcaoContribuicao
 * for every existing usuario that doesn't already have one.
 *
 * Why: the p8i01 saga (`registrarContaUsuario`) was the first place that
 * auto-creates a default "Lista de <nomeExibicao>" campanha at signup.
 * Users who signed up before the saga shipped have no campanha and would
 * land on an empty /painel/<slug>. This script retrofits them.
 *
 * Behaviour:
 *   - Iterate every row in `usuarios`.
 *   - For each, check `campanhaRepository.findFirstByAdministrador(idConta)`.
 *     - If present → skip (idempotent).
 *     - If absent → call `criarCampanha` (no Recebedor, lifecycle pré-bank-info,
 *       see aperture-66klh) then `adicionarOpcaoContribuicao` with tipo
 *       'presente'. Both use the existing use-cases so OTel spans, validation,
 *       and event emission stay consistent with the signup saga.
 *
 * Idempotency: the `findFirstByAdministrador` guard is the only thing that
 * stands between re-runs and duplicate campanhas. Re-running the script on
 * a fully-backfilled DB must be a no-op.
 *
 * Errors: per-user errors are logged and the loop continues. Exit code is
 * 1 if any user errored, 0 otherwise.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/p8i01-backfill-campanhas.ts
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { CampanhaRepository } from '../src/adapters/arrecadacao/campanha-repository.js';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import type { RecebedorRepository } from '../src/adapters/arrecadacao/recebedor-repository.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import type { Database } from '../src/adapters/database.js';
import { createDatabase } from '../src/adapters/database.js';
import type { PlataformaRepository } from '../src/adapters/plataforma/repository.js';
import { PlataformaRepositoryMemory } from '../src/adapters/plataforma/repository.memory.js';
import type {
  IdCampanha,
  IdOpcaoContribuicao,
} from '../src/domain/arrecadacao/value-objects/ids.js';
import { ConsoleLogger } from '../src/observability/console-logger.js';
import type { Logger } from '../src/observability/logger.js';
import type { Observability } from '../src/observability/observability.js';
import { adicionarOpcaoContribuicao } from '../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../src/use-cases/arrecadacao/criar-campanha.js';
import { construirTituloListaPadrao } from '../src/use-cases/usuario/registrar-conta-usuario.js';

export interface BackfillDeps {
  readonly db: Database;
  readonly campanhaRepository: CampanhaRepository;
  readonly recebedorRepository: RecebedorRepository;
  readonly plataformaRepository: PlataformaRepository;
  readonly observability: Observability;
  readonly clock: () => Date;
  /** Optional override for deterministic id generation in tests. */
  readonly gerarIdCampanha?: () => IdCampanha;
  /** Optional override for deterministic id generation in tests. */
  readonly gerarIdOpcao?: () => IdOpcaoContribuicao;
  /**
   * Optional override for the logger used to emit per-user backfill events.
   * Falls back to `observability.logger`. Useful for tests that want to
   * assert on emitted lines without piping through stdout.
   */
  readonly logger?: Logger;
}

export interface BackfillResult {
  readonly total: number;
  readonly criadas: number;
  readonly skipped: number;
  readonly erros: number;
}

interface UsuarioRow {
  readonly id: string;
  readonly idConta: string;
  readonly nomeExibicao: string;
}

/**
 * Reads every row from `usuarios` directly via Kysely. This is a deliberate
 * bypass of the `UsuarioRepository` port — the domain has no "iterate all
 * users" concern, and `findAll` would only ever exist for ops scripts like
 * this one. Adding it to the port would force every adapter (Memory +
 * Postgres + future ones) to implement and conformance-test something that
 * has no place in application code.
 *
 * The script stays a one-off; if a second use-case ever needs it, that's
 * the moment to promote it to the port.
 */
async function loadAllUsuarios(db: Database): Promise<UsuarioRow[]> {
  const rows = await db
    .selectFrom('usuarios')
    .select(['id', 'id_conta', 'nome_exibicao'])
    .execute();

  return rows.map((row) => ({
    id: row.id,
    idConta: row.id_conta,
    nomeExibicao: row.nome_exibicao,
  }));
}

/**
 * Backfills the default Campanha + 'presente' OpcaoContribuicao for every
 * usuario in the DB that doesn't already have one. See file-level docstring
 * for the why and the per-user behaviour.
 *
 * Exported (vs. inlined into main) so integration tests can call it with a
 * test-container DB + the same deps the CLI uses.
 */
export async function backfillCampanhasParaUsuariosExistentes(
  deps: BackfillDeps,
): Promise<BackfillResult> {
  const {
    db,
    campanhaRepository,
    recebedorRepository,
    plataformaRepository,
    observability,
    clock,
    gerarIdCampanha = randomUUID,
    gerarIdOpcao = randomUUID,
    logger = observability.logger,
  } = deps;

  const usuarios = await loadAllUsuarios(db);
  let criadas = 0;
  let skipped = 0;
  let erros = 0;

  for (const usuario of usuarios) {
    try {
      const existing = await campanhaRepository.findFirstByAdministrador(usuario.idConta);
      if (existing) {
        logger.info('p8i01.backfill.skipped', {
          idUsuario: usuario.id,
          idCampanhaExistente: existing.id,
        });
        skipped++;
        continue;
      }

      const idCampanha = gerarIdCampanha();
      const idOpcao = gerarIdOpcao();
      const titulo = construirTituloListaPadrao(usuario.nomeExibicao);

      // Re-read idPlataforma per user — it's part of the usuario row and
      // criarCampanha enforces plataforma existence. We need both columns,
      // so widen the projection. (Cheap second query keeps this loop
      // readable; could be folded into loadAllUsuarios if perf matters.)
      const platRow = await db
        .selectFrom('usuarios')
        .select('id_plataforma')
        .where('id', '=', usuario.id)
        .executeTakeFirstOrThrow();

      await criarCampanha(
        {
          campanhaRepository,
          recebedorRepository,
          plataformaRepository,
          clock,
          observability,
        },
        {
          id: idCampanha,
          idPlataforma: platRow.id_plataforma,
          idsAdministradores: [usuario.idConta],
          titulo,
          // No dadosRecebedor — backfilled users may not have PIX yet.
          // Same lifecycle as p8i01 signup (aperture-66klh).
        },
      );

      await adicionarOpcaoContribuicao(
        { campanhaRepository, observability },
        { idCampanha, idOpcao, tipo: 'presente' },
      );

      logger.info('p8i01.backfill.criada', {
        idUsuario: usuario.id,
        idCampanha,
        idOpcao,
        titulo,
      });
      criadas++;
    } catch (error) {
      logger.error('p8i01.backfill.erro', {
        idUsuario: usuario.id,
        erro: error instanceof Error ? error.message : String(error),
      });
      erros++;
    }
  }

  return { total: usuarios.length, criadas, skipped, erros };
}

/**
 * CLI entrypoint — runs only when this file is executed directly (not when
 * imported by tests). Loads env, builds deps with prod adapters + the
 * Memory plataforma repo (plataformas are seed data, no Postgres backing
 * adapter exists yet), calls the backfill, prints the summary, and exits.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.length === 0) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const logger: Logger = new ConsoleLogger();
  const observability: Observability = {
    logger,
    // Tracer not wired up for a one-shot CLI — adapters fall back to the
    // no-op global tracer from @opentelemetry/api.
    tracer: (await import('@opentelemetry/api')).trace.getTracer('p8i01-backfill'),
  };

  const db = createDatabase(databaseUrl);
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  const campanhaRepository = new CampanhaRepositoryPostgres(db, recebedorRepository);
  const plataformaRepository = new PlataformaRepositoryMemory();

  try {
    const result = await backfillCampanhasParaUsuariosExistentes({
      db,
      campanhaRepository,
      recebedorRepository,
      plataformaRepository,
      observability,
      clock: () => new Date(),
    });

    logger.info('p8i01.backfill.summary', { ...result });
    console.log(JSON.stringify({ event: 'p8i01.backfill.summary', ...result }));

    if (result.erros > 0) {
      process.exit(1);
    }
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('p8i01.backfill.fatal', err);
    process.exit(1);
  });
}
