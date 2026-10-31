import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureFirstTouch } from '../../apps/eunenem-server/pages/lib/signup-attribution.js';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import { resolverUsuarioAutenticado } from '../../apps/eunenem-server/server/trpc/session-resolver.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../../src/adapters/usuario/auth-service.better-auth.js';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';

// Real BetterAuth and Postgres account insertion; other aggregate repositories are isolated.
describe('signup attribution through real BetterAuth and PG', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  beforeEach(async () => {
    await truncateBetterAuthTables(testDb.db);
  });

  /**
   * Build a fresh deps graph: REAL BetterAuth + AuthServiceBetterAuth over
   * Postgres for the auth tables; in-memory domain repos for the heal target.
   * `useSecureCookies` is parameterized so we can assert BOTH the default
   * (unprefixed signed cookie) and the prod (`__Secure-` prefixed) shapes.
   */
  function buildDeps(opts: { useSecureCookies: boolean; idPlataformaPadrao?: string }) {
    let capturedMagicLinkUrl: string | null = null;
    const auth = criarAuth(testDb.db, {
      secret: 'test-secret-at-least-thirty-two-characters-long',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3001'],
      idPlataformaPadrao: opts.idPlataformaPadrao ?? ID_PLATAFORMA_EUNENEM,
      socialProviders: { google: { clientId: 'x', clientSecret: 'y' } },
      useSecureCookies: opts.useSecureCookies,
      sendMagicLink: async ({ url }) => {
        capturedMagicLinkUrl = url;
      },
    });
    const authService = new AuthServiceBetterAuth(testDb.db);
    const recebedorRepository = new RecebedorRepositoryMemory();
    const deps = {
      db: testDb.db,
      auth,
      authService,
      usuarioRepository: new UsuarioRepositoryPostgres(testDb.db),
      plataformaRepository: new PlataformaRepositoryMemory(),
      campanhaRepository: new CampanhaRepositoryMemory(recebedorRepository),
      recebedorRepository,
      observability: { logger: new NoopLogger(), tracer: noopTracer() },
      clock: () => new Date(),
      sessionCookieName: 'better-auth.session_token',
    } as unknown as ServerDeps;
    return { deps, auth, readMagicLinkUrl: () => capturedMagicLinkUrl };
  }

  /**
   * Create the OAuth-shaped orphan through the real magic-link request + verify
   * flow. BetterAuth writes users + sessions and runs the dm7s3 idPlataforma
   * hook WITHOUT running the engine domain saga — exactly the post-OAuth
   * callback state this resolver must heal. Returns the `Cookie` header for the
   * established session.
   */
  async function criarOrfaoOAuthCookie(
    auth: ReturnType<typeof criarAuth>,
    email: string,
    name: string,
    readMagicLinkUrl: () => string | null,
  ): Promise<string> {
    await auth.api.signInMagicLink({
      body: { email, name, callbackURL: '/dashboard' },
      headers: new Headers({ origin: 'http://localhost:3001' }),
    });
    const url = readMagicLinkUrl();
    if (!url) throw new Error('signInMagicLink did not invoke the configured sender');
    const verifyResponse = await auth.handler(
      new Request(url, { method: 'GET', redirect: 'manual' }),
    );
    const setCookies = verifyResponse.headers.getSetCookie();
    const sessionSet = setCookies.find((cookie) => cookie.includes('session_token='));
    if (!sessionSet) {
      throw new Error(`magic-link verify set no session cookie; got: ${setCookies.join(' | ')}`);
    }
    // `name=value` — drop the attributes after the first ';'.
    return sessionSet.split(';')[0];
  }

  function headersComCookie(cookie: string): Headers {
    const h = new Headers();
    h.set('cookie', cookie);
    return h;
  }

  it('OAuth orphan → getSession resolves the signed cookie + heal provisions the domain user', async () => {
    const { deps, auth, readMagicLinkUrl } = buildDeps({ useSecureCookies: false });
    const cookie = await criarOrfaoOAuthCookie(
      auth,
      'guvaw-first-touch@example.com',
      'Orphan OAuth',
      readMagicLinkUrl,
    );

    // PRECONDITION: no domain usuarios row exists yet (the orphan).
    // (resolver will heal it.)
    const browser = {
      location: new URL('https://eunenem.com/faq?utm_source=ads&gclid=click'),
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { referrer: '', cookie: '' },
    };
    captureFirstTouch(browser);
    const headers = headersComCookie(`${cookie}; ${browser.document.cookie.split(';')[0]}`);
    const { usuario, expiraEm } = await resolverUsuarioAutenticado(deps, headers);
    const read = () =>
      sql<{
        signup_utm_source: string;
        signup_gclid: string;
        signup_landing_path: string;
      }>`SELECT signup_utm_source,signup_gclid,signup_landing_path FROM usuarios WHERE id=${usuario.id}`.execute(
        testDb.db,
      );
    expect((await read()).rows[0]).toEqual({
      signup_utm_source: 'ads',
      signup_gclid: 'click',
      signup_landing_path: '/faq',
    });
    browser.location = new URL('https://eunenem.com/?utm_source=overwrite');
    captureFirstTouch(browser);
    await resolverUsuarioAutenticado(
      deps,
      headersComCookie(`${cookie}; ${browser.document.cookie.split(';')[0]}`),
    );
    expect((await read()).rows[0].signup_utm_source).toBe('ads');

    // (2) tenant came from getSession's id_plataforma additionalField — the
    // server constant, never user input (Cipher #1).
    expect(usuario.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(usuario.email).toBe('guvaw-first-touch@example.com');
    expect(usuario.nomeExibicao).toBe('Orphan OAuth');
    expect(expiraEm).toBeInstanceOf(Date);

    // (3) the heal actually wrote the domain usuarios row — re-readable now.
    const healed = await deps.usuarioRepository.findUsuarioById(usuario.id as never);
    expect(healed).toBeDefined();
    expect(healed?.idConta).toBe(usuario.idConta);
  });
  it.each([
    '',
    '; eunenem_first_touch=%not-json',
  ])('missing/malformed attribution never blocks signup (%s)', async (extra) => {
    const { deps, auth, readMagicLinkUrl } = buildDeps({ useSecureCookies: false });
    const cookie = await criarOrfaoOAuthCookie(
      auth,
      `missing-${extra.length}@example.com`,
      'Cliente',
      readMagicLinkUrl,
    );
    const { usuario } = await resolverUsuarioAutenticado(deps, headersComCookie(cookie + extra));
    const row = await testDb.db
      .selectFrom('usuarios')
      .select(['signup_utm_source', 'signup_captured_at'])
      .where('id', '=', usuario.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ signup_utm_source: null, signup_captured_at: null });
  });
});
