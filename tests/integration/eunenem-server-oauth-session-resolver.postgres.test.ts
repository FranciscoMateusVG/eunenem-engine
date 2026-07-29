import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import {
  resolverUsuarioAutenticado,
  resolverUsuarioAutenticadoOuNull,
  SessaoNaoAutenticadaError,
} from '../../apps/eunenem-server/server/trpc/session-resolver.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../../src/adapters/usuario/auth-service.better-auth.js';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';

/**
 * aperture-6wo1f — right-reality tests for the central session resolver.
 *
 * The bug: an OAuth user completed the Google flow (BetterAuth wrote
 * users/sessions/accounts) but landed logged-out because (A) the bare-cookie
 * read missed BetterAuth's signed cookie and (B) no domain `usuarios` row
 * existed. These tests drive the ACTUAL artifacts — a REAL BetterAuth instance
 * over REAL Postgres for the auth tables — so they exercise the load-bearing
 * runtime unknowns the data-layer test (38wja) could not:
 *
 *   1. `auth.api.getSession` actually RESOLVES the signed cookie BetterAuth set
 *      (the bare path provably misses it) — the A2 fallback.
 *   2. `getSession` actually RETURNS the `idPlataforma` additionalField on the
 *      user object (the tenant the heal provisions into — Cipher #1).
 *   3. The orphan self-heal provisions the domain `usuarios` row and the
 *      resolver returns the now-existing user.
 *   4. A concurrent double-resolve provisions EXACTLY ONCE (UNIQUE backstop).
 *   5. No cookie / forged cookie → fail-closed (null / sentinel).
 *
 * Domain repos are in-memory (they enforce the same composite-UNIQUE +
 * PERMISSOES_PADRAO the postgres repos do — proven by the saga conformance
 * suite); Postgres backs ONLY the BetterAuth tables, which is the layer
 * `getSession` actually reads. The session cookie BetterAuth sets is SIGNED
 * (`<token>.<hmac>`) regardless of the `__Secure-` prefix, so the bare
 * `validarSessao` lookup misses it and PATH 2 (getSession) is the path under
 * test — exactly the production OAuth shape.
 */
describe('central session resolver — OAuth A2 + orphan self-heal (aperture-6wo1f)', () => {
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
      usuarioRepository: new UsuarioRepositoryMemory(),
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
      'orphan@example.com',
      'Orphan OAuth',
      readMagicLinkUrl,
    );

    // PRECONDITION: no domain usuarios row exists yet (the orphan).
    // (resolver will heal it.)
    const { usuario, expiraEm } = await resolverUsuarioAutenticado(deps, headersComCookie(cookie));

    // (2) tenant came from getSession's id_plataforma additionalField — the
    // server constant, never user input (Cipher #1).
    expect(usuario.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(usuario.email).toBe('orphan@example.com');
    expect(usuario.nomeExibicao).toBe('Orphan OAuth');
    expect(expiraEm).toBeInstanceOf(Date);

    // (3) the heal actually wrote the domain usuarios row — re-readable now.
    const healed = await deps.usuarioRepository.findUsuarioById(usuario.id as never);
    expect(healed).toBeDefined();
    expect(healed?.idConta).toBe(usuario.idConta);
  });

  it('also resolves under prod useSecureCookies=true (__Secure- prefixed signed cookie)', async () => {
    const { deps, auth, readMagicLinkUrl } = buildDeps({ useSecureCookies: true });
    const cookie = await criarOrfaoOAuthCookie(
      auth,
      'secure@example.com',
      'Secure User',
      readMagicLinkUrl,
    );
    // Sanity: the prod cookie name carries the __Secure- prefix — the exact
    // name the BARE tRPC read can't match, which is WHY A2 is needed.
    expect(cookie.startsWith('__Secure-')).toBe(true);

    const { usuario } = await resolverUsuarioAutenticado(deps, headersComCookie(cookie));
    expect(usuario.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(usuario.email).toBe('secure@example.com');
  });

  it('P0: a signed Better Auth cookie for a foreign tenant is rejected and never self-healed', async () => {
    const { deps, auth, readMagicLinkUrl } = buildDeps({
      useSecureCookies: false,
      idPlataformaPadrao: ID_PLATAFORMA_EUCASEI,
    });
    const cookie = await criarOrfaoOAuthCookie(
      auth,
      'foreign-signed@example.com',
      'Foreign Signed',
      readMagicLinkUrl,
    );

    expect(await resolverUsuarioAutenticadoOuNull(deps, headersComCookie(cookie))).toBeNull();
    const foreignRow = await testDb.db
      .selectFrom('users')
      .select(['id', 'id_plataforma'])
      .where('email', '=', 'foreign-signed@example.com')
      .executeTakeFirstOrThrow();
    expect(foreignRow.id_plataforma).toBe(ID_PLATAFORMA_EUCASEI);
    expect(await deps.usuarioRepository.findUsuarioById(foreignRow.id as never)).toBeUndefined();
  });

  it('P0: a bare engine cookie for a foreign tenant is rejected', async () => {
    const { deps } = buildDeps({ useSecureCookies: false });
    const email = 'foreign-bare@example.com';
    const senha = 'BogusBogus123!';
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
        idUsuario: randomUUID(),
        idConta: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        email,
        nomeExibicao: 'Foreign Bare',
        senhaSimulada: senha,
      },
    );
    const sessao = await deps.authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUCASEI,
      email,
      senha,
    });

    expect(
      await resolverUsuarioAutenticadoOuNull(
        deps,
        headersComCookie(`better-auth.session_token=${encodeURIComponent(sessao.token)}`),
      ),
    ).toBeNull();
  });

  it('idempotent: a second resolve finds the healed user, provisions nothing new', async () => {
    const { deps, auth, readMagicLinkUrl } = buildDeps({ useSecureCookies: false });
    const cookie = await criarOrfaoOAuthCookie(
      auth,
      'idem@example.com',
      'Idem User',
      readMagicLinkUrl,
    );
    const h = headersComCookie(cookie);

    const first = await resolverUsuarioAutenticado(deps, h);
    const second = await resolverUsuarioAutenticado(deps, h);

    expect(second.usuario.id).toBe(first.usuario.id);
    expect(second.usuario.idConta).toBe(first.usuario.idConta);
  });

  it('concurrent double-resolve provisions exactly once (UNIQUE backstop, Cipher #4)', async () => {
    const { deps, auth, readMagicLinkUrl } = buildDeps({ useSecureCookies: false });
    const cookie = await criarOrfaoOAuthCookie(
      auth,
      'race@example.com',
      'Race User',
      readMagicLinkUrl,
    );
    const h = headersComCookie(cookie);

    const [a, b] = await Promise.all([
      resolverUsuarioAutenticado(deps, h),
      resolverUsuarioAutenticado(deps, h),
    ]);

    // Both calls return the SAME single provisioned user — no duplicate, no
    // error escaping the UNIQUE backstop.
    expect(a.usuario.id).toBe(b.usuario.id);
    expect(a.usuario.idConta).toBe(b.usuario.idConta);
  });

  it('no cookie → fail-closed (throws the sentinel; OuNull returns null)', async () => {
    const { deps } = buildDeps({ useSecureCookies: false });
    await expect(resolverUsuarioAutenticado(deps, new Headers())).rejects.toBeInstanceOf(
      SessaoNaoAutenticadaError,
    );
    expect(await resolverUsuarioAutenticadoOuNull(deps, new Headers())).toBeNull();
  });

  it('forged/garbage cookie → fail-closed (getSession rejects the bad signature)', async () => {
    const { deps } = buildDeps({ useSecureCookies: false });
    const h = headersComCookie('better-auth.session_token=not-a-valid-signed-token.deadbeef');
    expect(await resolverUsuarioAutenticadoOuNull(deps, h)).toBeNull();
  });
});
