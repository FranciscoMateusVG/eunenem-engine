import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { ConviteRepositoryMemory } from '../../src/adapters/evento/convite-repository.memory.js';
import { EventoRepositoryMemory } from '../../src/adapters/evento/evento-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoProviderFake } from '../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import {
  ProvedorRegraTaxaMemory,
  REGRAS_TAXA_SEED,
} from '../../src/adapters/taxas/regra-provider.memory.js';
import { AuthServiceBetterAuth } from '../../src/adapters/usuario/auth-service.better-auth.js';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import { WebhookEventArchiveMemory } from '../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import type { Logger } from '../../src/observability/logger.js';
import type { Observability } from '../../src/observability/observability.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateChaRifaWaitlist } from '../helpers/truncate-cha-rifa-waitlist.js';

interface CapturingLogger extends Logger {
  readonly events: Array<{ event: string; fields: Record<string, unknown> }>;
}

function makeCapturingLogger(): CapturingLogger {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const logger: CapturingLogger = {
    events,
    info(event: string, fields: Record<string, unknown> = {}) {
      events.push({ event, fields });
    },
    error(event: string, fields: Record<string, unknown> = {}) {
      events.push({ event, fields });
    },
    warn(event: string, fields: Record<string, unknown> = {}) {
      events.push({ event, fields });
    },
    debug(event: string, fields: Record<string, unknown> = {}) {
      events.push({ event, fields });
    },
  } as CapturingLogger;
  return logger;
}

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

function buildDeps(logger: CapturingLogger): ServerDeps {
  const observability: Observability = { logger, tracer: noopTracer() };
  const db = testDb.db;

  const authService = new AuthServiceBetterAuth(db);
  const usuarioRepository = new UsuarioRepositoryPostgres(db);
  const plataformaRepository = new PlataformaRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  const campanhaRepository = new CampanhaRepositoryPostgres(db, recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryPostgres(db);
  const eventoRepository = new EventoRepositoryMemory();
  const conviteRepository = new ConviteRepositoryMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoProvider = new PagamentoProviderFake();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory(
    recebedorRepository,
    pagamentoRepository,
  );
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory(REGRAS_TAXA_SEED);
  const webhookEventArchive = new WebhookEventArchiveMemory();

  return {
    db,
    auth: { options: { advanced: { useSecureCookies: false } } } as never,
    authService,
    usuarioRepository,
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
    eventoRepository,
    conviteRepository,
    pagamentoRepository,
    pagamentoProvider,
    checkoutSessionProvider: pagamentoProvider,
    pagamentoEventPublisher,
    livroFinanceiroRepository,
    provedorRegraTaxa,
    observability,
    clock: () => new Date(),
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive,
  } as never as ServerDeps;
}

function makeCaller(deps: ServerDeps) {
  const ctx: TrpcContext = {
    deps,
    headers: new Headers(),
    resHeaders: new Headers(),
  };
  return { caller: appRouter.createCaller(ctx) };
}

const EMAIL = 'cha-rifa@example.com';

beforeEach(async () => {
  await truncateChaRifaWaitlist(testDb.db);
  await testDb.db.deleteFrom('rate_limit').execute();
});

afterEach(async () => {
  await truncateChaRifaWaitlist(testDb.db);
  await testDb.db.deleteFrom('rate_limit').execute();
});

describe('landing.cadastrarInteresseChaRifa — waitlist chá rifa', () => {
  it('e-mail válido → 1 row inserida, ok true, notificado_em NULL', async () => {
    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller } = makeCaller(deps);

    const result = await caller.landing.cadastrarInteresseChaRifa({ email: EMAIL });
    expect(result).toEqual({ ok: true });

    const row = await testDb.db
      .selectFrom('cha_rifa_waitlist')
      .selectAll()
      .where('email', '=', EMAIL)
      .where('id_plataforma', '=', ID_PLATAFORMA_EUNENEM)
      .executeTakeFirst();

    expect(row).toBeTruthy();
    expect(row?.notificado_em).toBeNull();

    expect(
      logger.events.some(
        (e) =>
          e.event === 'landing.cha_rifa_waitlist.cadastro' &&
          typeof e.fields.emailHash === 'string',
      ),
    ).toBe(true);
  });

  it('mesmo e-mail duas vezes → ok true, continua 1 row (dedup)', async () => {
    const deps = buildDeps(makeCapturingLogger());
    const { caller } = makeCaller(deps);

    await caller.landing.cadastrarInteresseChaRifa({ email: EMAIL });
    const second = await caller.landing.cadastrarInteresseChaRifa({ email: EMAIL });
    expect(second).toEqual({ ok: true });

    const count = await testDb.db
      .selectFrom('cha_rifa_waitlist')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('email', '=', EMAIL)
      .executeTakeFirst();

    expect(Number(count?.count ?? 0)).toBe(1);
  });

  it('e-mail inválido → BAD_REQUEST', async () => {
    const deps = buildDeps(makeCapturingLogger());
    const { caller } = makeCaller(deps);

    await expect(
      caller.landing.cadastrarInteresseChaRifa({ email: 'nao-e-email' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rate limit estourado → TOO_MANY_REQUESTS', async () => {
    const deps = buildDeps(makeCapturingLogger());
    const { caller } = makeCaller(deps);

    for (let i = 0; i < 5; i++) {
      await caller.landing.cadastrarInteresseChaRifa({
        email: `cha-rifa-${i}@example.com`,
      });
    }

    await expect(
      caller.landing.cadastrarInteresseChaRifa({
        email: 'cha-rifa-overflow@example.com',
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});
