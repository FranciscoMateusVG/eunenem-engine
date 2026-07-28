import { randomUUID } from 'node:crypto';
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
  ID_PLATAFORMA_EUCASEI,
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
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';
import { truncateUsuarioTables } from '../helpers/truncate-usuario.js';

/**
 * aperture-d7993 — integration tests for the unified login-or-signup
 * mutation `auth.continuarComEmail` (Option B).
 *
 * Real Postgres (testcontainers shared container) so the rate-limit
 * buckets (rate_limit table) AND the user lookup / account-create paths
 * exercise the same DB the production deps use. AuthServiceBetterAuth +
 * Postgres repos = the real adapters. Plataforma stays in-memory (seeded)
 * exactly like production's buildServerDeps.
 */

const SESSION_COOKIE = 'better-auth.session_token';

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

function buildDeps(
  logger: CapturingLogger,
  options: {
    readonly trustedHopCount?: number;
    readonly trustedOrigins?: readonly string[];
  } = {},
): ServerDeps {
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
    // setSessionCookie reads deps.auth.options.advanced?.useSecureCookies.
    auth: {
      options: {
        advanced: { useSecureCookies: false },
        trustedOrigins: options.trustedOrigins ?? ['http://localhost:3001'],
      },
    } as never,
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
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: options.trustedHopCount ?? 0,
    logPiiHashSalt: '',
    webhookEventArchive,
  } as never as ServerDeps;
}

function makeCaller(deps: ServerDeps, headers?: HeadersInit) {
  const ctx: TrpcContext = {
    deps,
    headers: new Headers(headers),
    resHeaders: new Headers(),
  };
  return { caller: appRouter.createCaller(ctx), resHeaders: ctx.resHeaders };
}

async function seedForeignTenantAccount(
  deps: ServerDeps,
  email: string,
  senha: string,
): Promise<{ idUsuario: string }> {
  const idUsuario = randomUUID();
  await registrarContaUsuario(
    {
      usuarioRepository: deps.usuarioRepository,
      plataformaRepository: deps.plataformaRepository,
      campanhaRepository: deps.campanhaRepository,
      recebedorRepository: deps.recebedorRepository,
      authService: deps.authService,
      clock: deps.clock,
      observability: deps.observability,
    },
    {
      idUsuario,
      idConta: randomUUID(),
      idPlataforma: ID_PLATAFORMA_EUCASEI,
      email,
      nomeExibicao: 'Foreign Tenant User',
      senhaSimulada: senha,
    },
  );
  return { idUsuario };
}

function lastStatuses(logger: CapturingLogger, event: string): string[] {
  return logger.events.filter((e) => e.event === event).map((e) => e.fields.status as string);
}

const EMAIL = 'pessoa@example.com';
const PASSWORD = 'senha-teste-123';

beforeEach(async () => {
  await truncateArrecadacaoTables(testDb.db);
  await truncateBetterAuthTables(testDb.db);
  await truncateUsuarioTables(testDb.db);
});

afterEach(async () => {
  await truncateArrecadacaoTables(testDb.db);
  await truncateBetterAuthTables(testDb.db);
  await truncateUsuarioTables(testDb.db);
});

describe('auth.continuarComEmail — unified login-or-signup (aperture-d7993)', () => {
  it('P0: signUp ignores a caller-selected foreign tenant and creates only an EuNeném principal', async () => {
    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller, resHeaders } = makeCaller(deps);

    const result = await caller.auth.signUp({
      email: 'foreign-signup@example.com',
      senha: PASSWORD,
      nomeExibicao: 'Server Bound',
      idPlataforma: ID_PLATAFORMA_EUCASEI,
    });

    const rows = await testDb.db
      .selectFrom('users')
      .select(['id', 'id_plataforma'])
      .where('email', '=', 'foreign-signup@example.com')
      .execute();
    expect(rows).toEqual([
      expect.objectContaining({
        id: result.idUsuario,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
      }),
    ]);
    expect(resHeaders.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
  });

  it('P0: signIn cannot authenticate a foreign-tenant credential through EuNeném', async () => {
    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    await seedForeignTenantAccount(deps, 'foreign-signin@example.com', PASSWORD);
    const { caller, resHeaders } = makeCaller(deps);

    await expect(
      caller.auth.signIn({
        email: 'foreign-signin@example.com',
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUCASEI,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(resHeaders.get('set-cookie')).toBeNull();
    const sessions = await testDb.db.selectFrom('sessions').select('id').execute();
    expect(sessions).toHaveLength(0);
  });

  it('P0: continuarComEmail binds to EuNeném even when the same email exists in a foreign tenant', async () => {
    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const foreign = await seedForeignTenantAccount(deps, 'foreign-continue@example.com', PASSWORD);
    const { caller, resHeaders } = makeCaller(deps);

    const result = await caller.auth.continuarComEmail({
      email: 'foreign-continue@example.com',
      senha: PASSWORD,
      idPlataforma: ID_PLATAFORMA_EUCASEI,
      nomeExibicao: 'EuNeném Account',
    });

    expect(result.criado).toBe(true);
    expect(result.idUsuario).not.toBe(foreign.idUsuario);
    const rows = await testDb.db
      .selectFrom('users')
      .select(['id', 'id_plataforma'])
      .where('email', '=', 'foreign-continue@example.com')
      .orderBy('id_plataforma')
      .execute();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: foreign.idUsuario,
          id_plataforma: ID_PLATAFORMA_EUCASEI,
        }),
        expect.objectContaining({
          id: result.idUsuario,
          id_plataforma: ID_PLATAFORMA_EUNENEM,
        }),
      ]),
    );
    expect(resHeaders.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
  });

  it('new email → creates account (emailVerified false), returns session, emits signup_success', async () => {
    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller, resHeaders } = makeCaller(deps);

    const result = await caller.auth.continuarComEmail({
      email: EMAIL,
      senha: PASSWORD,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      nomeExibicao: 'Pessoa Teste',
    });

    expect(result.idUsuario).toBeTruthy();
    expect(result.idConta).toBeTruthy();
    expect(result.expiraEm).toBeInstanceOf(Date);
    // Session cookie was set.
    expect(resHeaders.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);

    // Account row exists with email_verified = false (forward-compat).
    const userRow = await testDb.db
      .selectFrom('users')
      .select(['id', 'email_verified'])
      .where('email', '=', EMAIL)
      .where('id_plataforma', '=', ID_PLATAFORMA_EUNENEM)
      .executeTakeFirst();
    expect(userRow).toBeTruthy();
    expect(userRow?.email_verified).toBe(false);

    expect(lastStatuses(logger, 'usuario.continue_with_email.tentativa')).toContain(
      'signup_success',
    );
  });

  it('accepts public/trusted/no Origin and rejects a hostile browser Origin before limiter, audit, lookup, or write', async () => {
    const logger = makeCapturingLogger();
    const deps = buildDeps(logger, {
      trustedOrigins: ['https://trusted.example'],
    });

    const hostile = makeCaller(deps, {
      origin: 'https://attacker.example',
    });
    await expect(
      hostile.caller.auth.continuarComEmail({
        email: 'hostile-origin@example.com',
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Origem nao autorizada',
    });

    expect(await testDb.db.selectFrom('rate_limit').select('id').execute()).toHaveLength(0);
    expect(
      await testDb.db
        .selectFrom('users')
        .select('id')
        .where('email', '=', 'hostile-origin@example.com')
        .execute(),
    ).toHaveLength(0);
    expect(logger.events).toHaveLength(0);

    const publicOrigin = makeCaller(deps, {
      origin: 'http://localhost:3001',
    });
    await expect(
      publicOrigin.caller.auth.continuarComEmail({
        email: 'same-origin@example.com',
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      }),
    ).resolves.toMatchObject({ criado: true });

    const configuredOrigin = makeCaller(deps, {
      origin: 'https://trusted.example',
    });
    await expect(
      configuredOrigin.caller.auth.continuarComEmail({
        email: 'trusted-origin@example.com',
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      }),
    ).resolves.toMatchObject({ criado: true });

    const serverCaller = makeCaller(deps);
    await expect(
      serverCaller.caller.auth.continuarComEmail({
        email: 'no-origin@example.com',
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      }),
    ).resolves.toMatchObject({ criado: true });
  });

  it('canonicalizes email once before hashing, tenant lookup, persistence, and account-result selection', async () => {
    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller } = makeCaller(deps);

    const created = await caller.auth.continuarComEmail({
      email: '  Pessoa@EXAMPLE.COM  ',
      senha: PASSWORD,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      nomeExibicao: 'Pessoa Canonica',
    });

    const loggedIn = await caller.auth.continuarComEmail({
      email: ' PESSOA@example.com ',
      senha: PASSWORD,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
    });

    expect(loggedIn).toMatchObject({
      criado: false,
      idUsuario: created.idUsuario,
      idConta: created.idConta,
    });

    const rows = await testDb.db
      .selectFrom('users')
      .select(['id', 'email'])
      .where('id_plataforma', '=', ID_PLATAFORMA_EUNENEM)
      .where('email', '=', EMAIL)
      .execute();
    expect(rows).toEqual([{ id: created.idUsuario, email: EMAIL }]);

    const attempts = logger.events.filter(
      (event) => event.event === 'usuario.continue_with_email.tentativa',
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.map((event) => event.fields.emailHash)).toEqual([
      `unhashed:${EMAIL}`,
      `unhashed:${EMAIL}`,
    ]);
  });

  it('returning user + correct password → login_success, session returned', async () => {
    // First call creates the account.
    {
      const logger = makeCapturingLogger();
      const deps = buildDeps(logger);
      const { caller } = makeCaller(deps);
      await caller.auth.continuarComEmail({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        nomeExibicao: 'Pessoa Teste',
      });
    }

    // Second call with the SAME email + correct password → login branch.
    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller, resHeaders } = makeCaller(deps);

    const result = await caller.auth.continuarComEmail({
      email: EMAIL,
      senha: PASSWORD,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
    });

    expect(result.idUsuario).toBeTruthy();
    expect(result.idConta).toBeTruthy();
    expect(resHeaders.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
    expect(lastStatuses(logger, 'usuario.continue_with_email.tentativa')).toContain(
      'login_success',
    );
  });

  it('returning user + wrong password → throws the standard ambiguous error (NOT a distinct "no account" error), emits login_failed', async () => {
    // Create account first.
    {
      const logger = makeCapturingLogger();
      const deps = buildDeps(logger);
      const { caller } = makeCaller(deps);
      await caller.auth.continuarComEmail({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        nomeExibicao: 'Pessoa Teste',
      });
    }

    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller } = makeCaller(deps);

    await expect(
      caller.auth.continuarComEmail({
        email: EMAIL,
        senha: 'senha-errada-999',
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      }),
    ).rejects.toMatchObject({
      // The SAME error signIn throws on bad credentials: BAD_REQUEST with
      // the ambiguous message — NOT a 'no account' / NOT_FOUND error.
      code: 'BAD_REQUEST',
    });

    const statuses = lastStatuses(logger, 'usuario.continue_with_email.tentativa');
    expect(statuses).toContain('login_failed');
    // Must NOT have signup_success'd or created a second account.
    expect(statuses).not.toContain('signup_success');
  });

  it('login-cap exhausted → TOO_MANY_REQUESTS + rate_limited emission', async () => {
    // Create the account via signUp (DIFFERENT rate-limit bucket:
    // trpc:signUp) so the trpc:signIn bucket we exhaust below starts
    // fresh — otherwise the create call would consume one signIn slot and
    // skew the count.
    {
      const logger = makeCapturingLogger();
      const deps = buildDeps(logger);
      const { caller } = makeCaller(deps);
      await caller.auth.signUp({
        email: EMAIL,
        senha: PASSWORD,
        nomeExibicao: 'Pessoa Teste',
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      });
    }

    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller } = makeCaller(deps);

    // RATE_LIMIT_SIGN_IN_MAX = 10. Consume up to the cap with correct
    // password (all succeed), then the 11th must be throttled.
    for (let i = 0; i < 10; i++) {
      await caller.auth.continuarComEmail({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      });
    }

    await expect(
      caller.auth.continuarComEmail({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    expect(lastStatuses(logger, 'usuario.continue_with_email.tentativa')).toContain('rate_limited');
  });

  it('ANTI-BYPASS: consuming signIn cap via auth.signIn throttles the shared sign-in buckets on continuarComEmail', async () => {
    // Register via signUp (trpc:signUp bucket) so the trpc:signIn bucket
    // starts fresh for the exhaustion loop below.
    {
      const logger = makeCapturingLogger();
      const deps = buildDeps(logger);
      const { caller } = makeCaller(deps);
      await caller.auth.signUp({
        email: EMAIL,
        senha: PASSWORD,
        nomeExibicao: 'Pessoa Teste',
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      });
    }

    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller } = makeCaller(deps);

    // Exhaust both shared sign-in buckets through auth.signIn (10/60s).
    for (let i = 0; i < 10; i++) {
      await caller.auth.signIn({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      });
    }

    // continuarComEmail shares both the email-only and (ip,email) rows, so
    // the very next call through the unified endpoint is already throttled.
    await expect(
      caller.auth.continuarComEmail({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    expect(lastStatuses(logger, 'usuario.continue_with_email.tentativa')).toContain('rate_limited');
  });

  it('ANTI-BYPASS: the email-only 10/60 bucket is shared across rotating IPs and both credential procedures', async () => {
    {
      const logger = makeCapturingLogger();
      const deps = buildDeps(logger);
      const { caller } = makeCaller(deps);
      await caller.auth.signUp({
        email: EMAIL,
        senha: PASSWORD,
        nomeExibicao: 'Pessoa Teste',
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      });
    }

    const logger = makeCapturingLogger();
    const deps = buildDeps(logger, { trustedHopCount: 1 });

    // Every request uses a different trusted client IP, so every pair bucket
    // remains at count=1. Five attempts use signIn and five use the unified
    // procedure; only the independent email bucket can reject attempt 11.
    for (let i = 0; i < 5; i++) {
      const { caller } = makeCaller(deps, {
        'x-forwarded-for': `203.0.113.${i + 1}`,
      });
      await caller.auth.signIn({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      });
    }
    for (let i = 0; i < 5; i++) {
      const { caller } = makeCaller(deps, {
        'x-forwarded-for': `198.51.100.${i + 1}`,
      });
      await caller.auth.continuarComEmail({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      });
    }

    const { caller } = makeCaller(deps, {
      'x-forwarded-for': '192.0.2.250',
    });
    await expect(
      caller.auth.signIn({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    const emailBucket = await testDb.db
      .selectFrom('rate_limit')
      .select(['count', 'key'])
      .where('key', '=', `trpc:signIn:email:unhashed:${EMAIL}`)
      .executeTakeFirstOrThrow();
    expect(emailBucket).toEqual({
      count: 11,
      key: `trpc:signIn:email:unhashed:${EMAIL}`,
    });

    const pairBuckets = await testDb.db
      .selectFrom('rate_limit')
      .select(['count'])
      .where('key', 'like', 'trpc:signIn:unhashed:%')
      .execute();
    expect(pairBuckets).toHaveLength(10);
    expect(pairBuckets.every((row) => row.count === 1)).toBe(true);
  });

  it('ENUMERATION: exhausted create cap returns the same ambiguous error as a wrong password and creates no user', async () => {
    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller } = makeCaller(deps);

    await caller.auth.signUp({
      email: EMAIL,
      senha: PASSWORD,
      nomeExibicao: 'Existing User',
      idPlataforma: ID_PLATAFORMA_EUNENEM,
    });
    // Isolate the assertion from the setup call's signup bucket.
    await testDb.db.deleteFrom('rate_limit').execute();

    const wrongPasswordError: unknown = await caller.auth
      .continuarComEmail({
        email: EMAIL,
        senha: 'senha-errada-999',
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      })
      .catch((error: unknown) => error);
    expect(wrongPasswordError).toMatchObject({ code: 'BAD_REQUEST' });
    expect(wrongPasswordError).toBeInstanceOf(Error);
    if (!(wrongPasswordError instanceof Error)) {
      throw new Error('Expected wrong-password attempt to reject');
    }
    expect(wrongPasswordError.message).toContain('Email ou senha invalidos');

    // signUp cap = 3 per 60s per IP. Create 3 distinct accounts via signUp
    // (same IP — empty rawIp in dev → same ipHash → same bucket).
    for (let i = 0; i < 3; i++) {
      await caller.auth.signUp({
        email: `signup-${i}@example.com`,
        senha: PASSWORD,
        nomeExibicao: `User ${i}`,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      });
    }

    // A brand-new email reaches the exhausted create-only bucket. The router
    // deliberately executes consumeDummyPasswordVerificationWork (the real
    // Better Auth verifyPassword helper in password-verification-work.ts)
    // before returning. ESM module binding makes a non-invasive invocation spy
    // unreliable here; the stable contract evidence is identical code/message,
    // the internal-only rate_limited event, and absence of the user write.
    const exhaustedCreateError: unknown = await caller.auth
      .continuarComEmail({
        email: 'brand-new@example.com',
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        nomeExibicao: 'Brand New',
      })
      .catch((error: unknown) => error);
    expect(exhaustedCreateError).toMatchObject({
      code: 'BAD_REQUEST',
      message: wrongPasswordError.message,
    });

    expect(lastStatuses(logger, 'usuario.continue_with_email.tentativa')).toContain('rate_limited');

    // The brand-new account must NOT have been created (rate-limited before
    // registrarContaUsuario ran).
    const row = await testDb.db
      .selectFrom('users')
      .select(['id'])
      .where('email', '=', 'brand-new@example.com')
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('SECURITY (aperture-oss3g): create-branch BetterAuth-users collision (orphan with no usuarios row) → SAME ambiguous BAD_REQUEST, NOT a distinguishable CONFLICT', async () => {
    // Seed the orphan: create a full account (BetterAuth `users` row + domain
    // `usuarios`/`contas` rows), then delete ONLY the domain rows. The
    // BetterAuth `users` row survives → an email that findUsuarioByEmail (which
    // only checks the domain `usuarios` table) MISSES, but criarConta's INSERT
    // into the BetterAuth `users` table COLLIDES on (UNIQUE id_plataforma,
    // email). Today this is only reachable via a saga-orphan; it becomes
    // systematic the moment any social/OAuth provider is wired (OAuth users get
    // a BetterAuth row without a domain row). Pre-fix, the collision surfaced as
    // a tRPC CONFLICT — a status DISTINGUISHABLE from the ambiguous BAD_REQUEST
    // wrong-password returns = an email-enumeration oracle that doesn't even
    // create an account.
    {
      const logger = makeCapturingLogger();
      const deps = buildDeps(logger);
      const { caller } = makeCaller(deps);
      await caller.auth.continuarComEmail({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        nomeExibicao: 'Pessoa Teste',
      });
    }

    // Drop the domain rows; the BetterAuth `users` row stays → orphan state.
    await testDb.db.deleteFrom('contas').execute();
    await testDb.db.deleteFrom('usuarios').execute();
    // Sanity: the BetterAuth users row genuinely survived the domain wipe.
    const orphan = await testDb.db
      .selectFrom('users')
      .select(['id'])
      .where('email', '=', EMAIL)
      .where('id_plataforma', '=', ID_PLATAFORMA_EUNENEM)
      .executeTakeFirst();
    expect(orphan).toBeTruthy();

    const logger = makeCapturingLogger();
    const deps = buildDeps(logger);
    const { caller } = makeCaller(deps);

    // The collision MUST surface as the SAME ambiguous BAD_REQUEST as
    // wrong-password — code BAD_REQUEST mutually excludes the pre-fix CONFLICT,
    // so an attacker cannot distinguish this orphan email from a failed login.
    await expect(
      caller.auth.continuarComEmail({
        email: EMAIL,
        senha: PASSWORD,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        nomeExibicao: 'Pessoa Teste',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Internal observability: the collision is emitted (so the data-integrity
    // orphan stays queryable) and NO account-creation success leaked.
    const statuses = lastStatuses(logger, 'usuario.continue_with_email.tentativa');
    expect(statuses).toContain('signup_collision');
    expect(statuses).not.toContain('signup_success');
  });
});
