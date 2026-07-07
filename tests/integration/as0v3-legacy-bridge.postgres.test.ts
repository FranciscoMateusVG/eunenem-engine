import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { ClerkBridgeClient } from '../../apps/eunenem-server/server/legacy-bridge.js';
import { createLegacyBridgeHandler } from '../../apps/eunenem-server/server/legacy-bridge.js';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../../src/adapters/usuario/auth-service.better-auth.js';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import type { Observability } from '../../src/observability/observability.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { criarSessaoUsuario } from '../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';

/**
 * aperture-as0v3 — handler decision-table integration test for GET
 * /api/legacy-bridge, driven against REAL Postgres (users/sessions/rate_limit
 * + the session-resolver) with a FAKE Clerk client (no network, no sk_live).
 * Pins every branch of the security decision table + the fail-open-to-fallback
 * posture + the token-never-logged rule.
 */

const SESSION_COOKIE = 'better-auth.session_token';
const TEST_PASSWORD = 'senha-teste-123';
const SALT = 'x'.repeat(48);
const FALLBACK = 'https://eunenem.com/minha-area';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  process.env.LOG_PII_HASH_SALT = SALT;
}, 60_000);

afterAll(async () => {
  delete process.env.CLERK_SECRET_KEY;
  await testDb.teardown();
});

beforeEach(async () => {
  await truncateBetterAuthTables(testDb.db);
  await testDb.db.deleteFrom('rate_limit').execute();
  process.env.CLERK_SECRET_KEY = 'sk_test_fake';
});

/** A recording fake Clerk client. */
function fakeClerk(overrides: Partial<ClerkBridgeClient> = {}): ClerkBridgeClient {
  return {
    findVerifiedUserByEmail: async () => ({ kind: 'found', userId: 'clerk_user_1' }),
    mintSignInToken: async () => 'THE_SECRET_TICKET',
    ...overrides,
  };
}

function buildDeps(clerk: ClerkBridgeClient, logs: Array<Record<string, unknown>>): ServerDeps {
  const observability: Observability = {
    logger: {
      info: (event: string, ctx: Record<string, unknown>) => logs.push({ event, ...ctx }),
      warn: (event: string, ctx: Record<string, unknown>) =>
        logs.push({ event, level: 'warn', ...ctx }),
      error: (event: string, ctx: Record<string, unknown>) =>
        logs.push({ event, level: 'error', ...ctx }),
    } as unknown as Observability['logger'],
    tracer: noopTracer(),
  };
  const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
  const deps = {
    db: testDb.db,
    auth: criarAuth(testDb.db, {
      secret: 'test-secret-at-least-32-chars-long-xxxxx',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3001'],
      sendResetPassword: async () => {},
      useSecureCookies: false,
      idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
    }),
    authService: new AuthServiceBetterAuth(testDb.db),
    usuarioRepository: new UsuarioRepositoryPostgres(testDb.db),
    plataformaRepository: new PlataformaRepositoryMemory(),
    recebedorRepository,
    campanhaRepository: new CampanhaRepositoryPostgres(testDb.db, recebedorRepository),
    observability,
    clock: () => new Date(),
    sessionCookieName: SESSION_COOKIE,
    logPiiHashSalt: SALT,
    trustedHopCount: 0,
  } as unknown as ServerDeps;
  // clerk factory is injected at handler-build time (see makeApp).
  return deps;
}

/** Register a full domain user (saga → users+credential+usuarios+campanha), set
 *  email_verified, return a live session cookie. */
async function registerUser(deps: ServerDeps, email: string, verified: boolean): Promise<string> {
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
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      nomeExibicao: 'Bridge User',
      senhaSimulada: TEST_PASSWORD,
    },
  );
  await testDb.db
    .updateTable('users')
    .set({ email_verified: verified })
    .where('id', '=', idUsuario)
    .execute();
  const sessao = await criarSessaoUsuario(
    {
      usuarioRepository: deps.usuarioRepository,
      authService: deps.authService,
      observability: deps.observability,
    },
    { idPlataforma: ID_PLATAFORMA_EUNENEM, email, senhaSimulada: TEST_PASSWORD },
  );
  return sessao.token;
}

function makeApp(deps: ServerDeps, clerk: ClerkBridgeClient) {
  const app = new Hono();
  app.get(
    '/api/legacy-bridge',
    createLegacyBridgeHandler(deps, () => clerk),
  );
  return app;
}

async function hit(app: Hono, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'user-agent': 'test-agent' };
  if (token) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  return app.request('/api/legacy-bridge', { headers });
}

describe('GET /api/legacy-bridge decision table (aperture-as0v3)', () => {
  it('⭐ EMPTY-STRING LEGACY_SITE_ORIGIN env → ABSOLUTE fallback (regression: compose empty-string 404)', async () => {
    // The compose wires LEGACY_SITE_ORIGIN=${LEGACY_SITE_ORIGIN:-} → empty
    // string when unset. It must NOT produce a relative /minha-area (which 404s
    // on the new domain — the operator's live-test break).
    process.env.LEGACY_SITE_ORIGIN = '';
    try {
      const logs: Array<Record<string, unknown>> = [];
      const deps = buildDeps(fakeClerk(), logs);
      const token = await registerUser(deps, `emptyorigin-${randomUUID()}@x.com`, false);
      const res = await hit(makeApp(deps, fakeClerk()), token);
      expect(res.status).toBe(302);
      expect(
        res.headers.get('location'),
        'empty-string env must fall back to the ABSOLUTE legacy URL, never a relative one',
      ).toBe('https://eunenem.com/minha-area');
    } finally {
      delete process.env.LEGACY_SITE_ORIGIN;
    }
  });

  it('no session → 302 to "/" (never leaks an old-site URL to an anon prober)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps = buildDeps(fakeClerk(), logs);
    const res = await hit(makeApp(deps, fakeClerk()), null);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(logs.at(-1)?.outcome).toBe('sem_sessao');
  });

  it('⭐ session but email_verified=FALSE → fallback redirect (the trust-anchor gate)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps = buildDeps(fakeClerk(), logs);
    const token = await registerUser(deps, `unverified-${randomUUID()}@x.com`, false);
    const res = await hit(makeApp(deps, fakeClerk()), token);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(FALLBACK);
    expect(logs.at(-1)?.outcome).toBe('nao_verificado');
  });

  it('verified + Clerk user found → 302 to /ponte with the ticket', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps = buildDeps(fakeClerk(), logs);
    const token = await registerUser(deps, `verified-${randomUUID()}@x.com`, true);
    const clerk = fakeClerk();
    const res = await hit(makeApp(deps, clerk), token);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toBe('https://eunenem.com/ponte?__clerk_ticket=THE_SECRET_TICKET');
    expect(logs.at(-1)?.outcome).toBe('mintado');
  });

  it('⭐ the minted token NEVER appears in any log line', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps = buildDeps(fakeClerk(), logs);
    const token = await registerUser(deps, `verified-${randomUUID()}@x.com`, true);
    await hit(makeApp(deps, fakeClerk()), token);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('THE_SECRET_TICKET');
  });

  it('verified but no CLERK_SECRET_KEY → fallback (endpoint inert without the key)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps = buildDeps(fakeClerk(), logs);
    const token = await registerUser(deps, `verified-${randomUUID()}@x.com`, true);
    delete process.env.CLERK_SECRET_KEY;
    const res = await hit(makeApp(deps, fakeClerk()), token);
    expect(res.headers.get('location')).toBe(FALLBACK);
    expect(logs.at(-1)?.outcome).toBe('sem_chave');
  });

  it('verified but no matching Clerk user → fallback', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps = buildDeps(fakeClerk(), logs);
    const token = await registerUser(deps, `verified-${randomUUID()}@x.com`, true);
    const clerk = fakeClerk({ findVerifiedUserByEmail: async () => ({ kind: 'none' }) });
    const res = await hit(makeApp(deps, clerk), token);
    expect(res.headers.get('location')).toBe(FALLBACK);
    expect(logs.at(-1)?.outcome).toBe('sem_usuario_clerk');
  });

  it('⭐ ambiguous Clerk match → fallback + WARN (never pick-first)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps = buildDeps(fakeClerk(), logs);
    const token = await registerUser(deps, `verified-${randomUUID()}@x.com`, true);
    const clerk = fakeClerk({ findVerifiedUserByEmail: async () => ({ kind: 'ambiguous' }) });
    const res = await hit(makeApp(deps, clerk), token);
    expect(res.headers.get('location')).toBe(FALLBACK);
    expect(logs.some((l) => l.level === 'warn')).toBe(true);
    expect(logs.at(-1)?.outcome).toBe('clerk_ambiguo');
  });

  it('Clerk error → fallback (never an error page)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps = buildDeps(fakeClerk(), logs);
    const token = await registerUser(deps, `verified-${randomUUID()}@x.com`, true);
    const clerk = fakeClerk({
      mintSignInToken: async () => {
        throw new Error('clerk 500');
      },
    });
    const res = await hit(makeApp(deps, clerk), token);
    expect(res.headers.get('location')).toBe(FALLBACK);
    expect(logs.at(-1)?.outcome).toBe('erro_clerk');
  });

  it('⭐ mint is rate-limited per user (6th call in the window → fallback)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps = buildDeps(fakeClerk(), logs);
    const token = await registerUser(deps, `verified-${randomUUID()}@x.com`, true);
    const app = makeApp(deps, fakeClerk());
    const outcomes: unknown[] = [];
    for (let i = 0; i < 6; i += 1) {
      await hit(app, token);
      outcomes.push(logs.at(-1)?.outcome);
    }
    expect(outcomes.slice(0, 5).every((o) => o === 'mintado')).toBe(true);
    expect(outcomes[5]).toBe('rate_limited');
  });
});
