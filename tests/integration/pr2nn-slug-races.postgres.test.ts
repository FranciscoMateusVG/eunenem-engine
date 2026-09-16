import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveRoute } from '../../apps/eunenem-server/pages/App.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase, type Database } from '../../src/adapters/database.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import type { UsuarioRepository } from '../../src/adapters/usuario/repository.js';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import { deriveSlugBase } from '../../src/domain/usuario/slug-derivation.js';
import { SlugUsuarioSchema } from '../../src/domain/usuario/value-objects/slug-usuario.js';
import { UsuarioSlugJaExisteError } from '../../src/errors/usuario/slug-ja-existe.error.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { provisionarContaUsuarioDominio } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';
import { truncateUsuarioTables } from '../helpers/truncate-usuario.js';

let testDb: TestDatabase;
let secondDb: Database;

beforeAll(async () => {
  testDb = await createTestDatabase();
  secondDb = createDatabase(testDb.connectionUri);
}, 180_000);

afterAll(async () => {
  await secondDb.destroy();
  await testDb.teardown();
});

beforeEach(async () => {
  await truncateArrecadacaoTables(testDb.db);
  await truncateUsuarioTables(testDb.db);
});

function usuarioBundle(email: string, slug: string) {
  const idUsuario = randomUUID();
  const idConta = randomUUID();
  const criadaEm = new Date('2026-09-16T10:00:00.000Z');
  return {
    usuario: {
      id: idUsuario,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idConta,
      email,
      nomeExibicao: 'Helena',
      slug,
      criadaEm,
      tutorialCompletadoEm: null,
      onboardingConcluidoEm: null,
    },
    conta: {
      id: idConta,
      idUsuario,
      permissoes: ['campaign:admin'] as const,
      criadaEm,
    },
  };
}

async function seedCampanha(id: string, idConta: string, slug: string | null = null) {
  await testDb.db
    .insertInto('campanhas')
    .values({
      id,
      id_plataforma: ID_PLATAFORMA_EUNENEM,
      titulo: `Lista ${id.slice(0, 4)}`,
      slug,
      slug_alterado_em: null,
    })
    .execute();
  await testDb.db
    .insertInto('campanha_administradores')
    .values({ campanha_id: id, id_usuario: idConta })
    .execute();
}

async function withCampaignAccountLockHeld(
  idConta: string,
  run: () => Promise<void>,
): Promise<void> {
  let releaseLock: (() => void) | undefined;
  let signalLocked: (() => void) | undefined;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const holder = testDb.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`campanha-public-slug:${idConta}`}::text, 0)
    )`.execute(trx);
    signalLocked?.();
    await release;
  });
  await locked;
  try {
    await run();
  } finally {
    releaseLock?.();
    await holder;
  }
}

async function waitForCampaignLockWaiters(expected: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const waiting = await sql<{ count: string }>`
          SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query LIKE '%pg_advisory_xact_lock%'
        `.execute(testDb.db);
        return Number(waiting.rows[0]?.count ?? 0);
      },
      { timeout: 5_000, interval: 10 },
    )
    .toBe(expected);
}

describe('PR2NN — two-connection slug regressions', () => {
  it('creator namespace has a real DB backstop: one concurrent same-tenant slug insert loses', async () => {
    const repoA = new UsuarioRepositoryPostgres(testDb.db);
    const repoB = new UsuarioRepositoryPostgres(secondDb);

    const results = await Promise.allSettled([
      repoA.saveRegistroDomain(usuarioBundle('helena-a@example.test', 'helena')),
      repoB.saveRegistroDomain(usuarioBundle('helena-b@example.test', 'helena')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(UsuarioSlugJaExisteError);
    }
  });

  it('auto-provision retries a typed slug race after both prechecks see free', async () => {
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const gateSlugPrecheck = (repo: UsuarioRepository): UsuarioRepository =>
      new Proxy(repo, {
        get(target, property) {
          if (property === 'findUsuarioBySlug') {
            return async (...args: Parameters<UsuarioRepository['findUsuarioBySlug']>) => {
              const result = await target.findUsuarioBySlug(...args);
              arrivals += 1;
              if (arrivals === 2) releaseBarrier();
              await barrier;
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

    const recebedorRepository = new RecebedorRepositoryMemory();
    const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
    const plataformaRepository = new PlataformaRepositoryMemory();
    const observability = { logger: new NoopLogger(), tracer: noopTracer() };
    const common = {
      plataformaRepository,
      campanhaRepository,
      recebedorRepository,
      clock: () => new Date('2026-09-16T10:00:00.000Z'),
      observability,
    };

    const results = await Promise.allSettled([
      provisionarContaUsuarioDominio(
        {
          ...common,
          usuarioRepository: gateSlugPrecheck(new UsuarioRepositoryPostgres(testDb.db)),
        },
        {
          idUsuario: randomUUID(),
          idConta: randomUUID(),
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'race-a@example.test',
          nome: 'Helena Silva',
        },
      ),
      provisionarContaUsuarioDominio(
        {
          ...common,
          usuarioRepository: gateSlugPrecheck(new UsuarioRepositoryPostgres(secondDb)),
        },
        {
          idUsuario: randomUUID(),
          idConta: randomUUID(),
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'race-b@example.test',
          nome: 'Helena Costa',
        },
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const persisted = await testDb.db
      .selectFrom('usuarios')
      .select(['slug'])
      .where('email', 'in', ['race-a@example.test', 'race-b@example.test'])
      .orderBy('slug')
      .execute();
    expect(persisted.map((row) => row.slug)).toEqual(['helena', 'helena-2']);
  });

  it('serializes same-account campaign writers so only one claims a slug', async () => {
    const idConta = randomUUID();
    const campanhaA = randomUUID();
    const campanhaB = randomUUID();
    await seedCampanha(campanhaA, idConta);
    await seedCampanha(campanhaB, idConta);

    const repoA = new CampanhaRepositoryPostgres(
      testDb.db,
      new RecebedorRepositoryPostgres(testDb.db),
    );
    const repoB = new CampanhaRepositoryPostgres(
      secondDb,
      new RecebedorRepositoryPostgres(secondDb),
    );

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await withCampaignAccountLockHeld(idConta, async () => {
      first = repoA.atualizarSlugAtomico({
        idConta: idConta as never,
        idCampanha: campanhaA as never,
        slug: 'mesmo-link',
        alteradoEm: new Date('2026-09-16T10:01:00.000Z'),
      });
      await waitForCampaignLockWaiters(1);
      second = repoB.atualizarSlugAtomico({
        idConta: idConta as never,
        idCampanha: campanhaB as never,
        slug: 'mesmo-link',
        alteradoEm: new Date('2026-09-16T10:01:00.000Z'),
      });
      await waitForCampaignLockWaiters(2);
    });
    if (!first || !second) throw new Error('campaign slug contenders did not start');
    await expect(first).resolves.toMatchObject({ status: 'updated' });
    await expect(second).resolves.toEqual({ status: 'slug_em_uso' });

    const rows = await testDb.db
      .selectFrom('campanhas')
      .select(['id', 'slug'])
      .where('id', 'in', [campanhaA, campanhaB])
      .orderBy('id')
      .execute();
    expect(rows.map((row) => row.slug).sort()).toEqual(['mesmo-link', null].sort());
  });

  it('serializes two replacements: one consumes the change and the other reports the conflict', async () => {
    const idConta = randomUUID();
    const campanha = randomUUID();
    await seedCampanha(campanha, idConta, 'link-inicial');

    const repoA = new CampanhaRepositoryPostgres(
      testDb.db,
      new RecebedorRepositoryPostgres(testDb.db),
    );
    const repoB = new CampanhaRepositoryPostgres(
      secondDb,
      new RecebedorRepositoryPostgres(secondDb),
    );
    const changedAt = new Date('2026-09-16T10:01:00.000Z');

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await withCampaignAccountLockHeld(idConta, async () => {
      first = repoA.atualizarSlugAtomico({
        idConta: idConta as never,
        idCampanha: campanha as never,
        slug: 'primeiro-link',
        alteradoEm: changedAt,
      });
      await waitForCampaignLockWaiters(1);
      second = repoB.atualizarSlugAtomico({
        idConta: idConta as never,
        idCampanha: campanha as never,
        slug: 'segundo-link',
        alteradoEm: changedAt,
      });
      await waitForCampaignLockWaiters(2);
    });
    if (!first || !second) throw new Error('campaign slug contenders did not start');
    await expect(first).resolves.toMatchObject({ status: 'updated' });
    await expect(second).resolves.toEqual({ status: 'slug_ja_alterado' });

    const row = await testDb.db
      .selectFrom('campanhas')
      .select(['slug', 'slug_alterado_em'])
      .where('id', '=', campanha)
      .executeTakeFirstOrThrow();
    expect(['primeiro-link', 'segundo-link']).toContain(row.slug);
    expect(row.slug_alterado_em).not.toBeNull();
  });
});

describe('PR2NN — cross-layer slug contracts', () => {
  it('auto-derivation sends reserved names to the validated safe base', () => {
    const derived = deriveSlugBase('Admin');
    expect(derived).toBe('usuario');
    expect(SlugUsuarioSchema.safeParse(derived).success).toBe(true);
  });

  it('backend and browser route both resolve a 31-character campaign slug', async () => {
    const creatorSlug = 'maria';
    const campaignSlug = `a${'b'.repeat(30)}`;
    const campaignId = randomUUID();
    const accountId = randomUUID();
    const ctx = {
      deps: {
        usuarioRepository: {
          findUsuarioBySlug: async () => ({ idConta: accountId }),
        },
        campanhaRepository: {
          findCampanhasByAdministrador: async () => [{ id: campaignId, slug: campaignSlug }],
        },
      },
      headers: new Headers(),
      resHeaders: new Headers(),
    } as unknown as TrpcContext;

    await expect(
      appRouter.createCaller(ctx).pagina.resolverCampanhaSlug({
        slug: creatorSlug,
        campanhaSlug: campaignSlug,
      }),
    ).resolves.toEqual({ idCampanha: campaignId });
    expect(resolveRoute(`/pagina/${creatorSlug}/${campaignSlug}`)).toEqual({
      kind: 'pagina',
      slug: creatorSlug,
      campanhaSlug: campaignSlug,
    });
  });
});
