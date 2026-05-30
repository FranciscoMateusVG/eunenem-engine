import { z } from 'zod';
import {
  AuthServiceBetterAuth,
  type AuthService,
  type Auth,
  ConsoleLogger,
  type CriarAuthConfig,
  createDatabase,
  criarAuth,
  type Database,
  ID_PLATAFORMA_EUNENEM,
  type Observability,
  PlataformaRepositoryMemory,
  type PlataformaRepository,
  UsuarioRepositoryPostgres,
  type UsuarioRepository,
} from '../../../../src/index.js';
import { noopTracer } from '../../../../src/observability/tracer.js';

/**
 * Engine-side dependencies wired for the eunenem-server (aperture-ht7sq).
 *
 * Constructed ONCE at boot — the same instances are reused across every
 * request via the tRPC `createContext` factory. tRPC procedures grab
 * what they need from the context object instead of standing up new
 * adapters per call.
 */
export interface ServerDeps {
  readonly db: Database;
  readonly auth: Auth;
  readonly authService: AuthService;
  readonly usuarioRepository: UsuarioRepository;
  readonly plataformaRepository: PlataformaRepository;
  readonly observability: Observability;
  readonly clock: () => Date;
  /** Cookie name shared by the engine's BetterAuth sessions table + our tRPC procedures. */
  readonly sessionCookieName: string;
}

/**
 * Env vars consumed at boot. **All required in production** (T6 from recon
 * §4 — no defaults that leak into prod). Dev defaults live in `.env.example`
 * so a fresh clone can `pnpm dev` without crashing on missing secrets;
 * production deploys MUST override every value.
 */
const ServerEnvSchema = z.object({
  /** ≥32 chars per BetterAuth's signing requirements (T6 from recon §4). */
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 chars (HMAC signing key)'),
  /** Public origin of the eunenem-server (e.g. https://eunenem.programaincluir.org). */
  BETTER_AUTH_URL: z.url('BETTER_AUTH_URL must be a valid URL'),
  /**
   * Comma-separated explicit allowlist of trusted origins (T6 — no wildcards,
   * append don't replace). Engine appends BETTER_AUTH_URL automatically;
   * this list is additive for cross-origin cookie-bearing requests (e.g.
   * local-dev front-end on a different port).
   */
  TRUSTED_ORIGINS: z.string().min(1, 'TRUSTED_ORIGINS required (comma-separated)'),
  /**
   * Postgres connection string for the engine's domain + BetterAuth tables.
   * Both schemas live in the same DB. Migrations are owned by the engine
   * repo (`pnpm db:migrate` from the engine root) — eunenem-server is a
   * consumer, not a schema owner.
   */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL required (postgres connection string for the engine schema)'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

/**
 * Validate process.env against the schema. **Throws at boot if anything is
 * missing or malformed** — no silent fallback in production. Dev defaults
 * live in `.env.example`, NOT in this validator.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = ServerEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nSee apps/eunenem-server/.env.example for the required variables.`,
    );
  }
  return parsed.data;
}

/**
 * Build all engine-side deps from validated env. Called ONCE at boot from
 * `server.tsx`.
 *
 * - Single Kysely instance powers BOTH the engine's domain repos AND the
 *   BetterAuth tables (anti-trap §8 #2 — pool-sharing, one Kysely, one
 *   migration runner).
 * - `criarAuth` accepts an injected `sendResetPassword`. For now this is
 *   a console-log stub — the actual email transport is a follow-up bead
 *   (Vance / operator's choice of SMTP / SES).
 * - `PlataformaRepository` is in-memory (the seeded plataformas
 *   eunenem + eucasei live in the engine package). When Plataforma BC
 *   gets a Postgres adapter, swap it here.
 */
export function buildServerDeps(env: ServerEnv): ServerDeps {
  const observability: Observability = {
    logger: new ConsoleLogger(),
    tracer: noopTracer(),
  };

  const db = createDatabase(env.DATABASE_URL);

  const authConfig: CriarAuthConfig = {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.TRUSTED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sendResetPassword: async ({ user, url }) => {
      // Stub — log only. Real transport (SMTP/SES) lands in a follow-up
      // bead. Keep the contract here so swapping is a one-line change.
      observability.logger.info('eunenem.auth.password_reset_email_stub', {
        idUsuario: user.id,
        email: user.email,
        url,
      });
    },
    useSecureCookies: env.NODE_ENV === 'production',
  };

  const auth = criarAuth(db, authConfig);

  const authService: AuthService = new AuthServiceBetterAuth(db, {
    clock: () => new Date(),
  });

  const usuarioRepository = new UsuarioRepositoryPostgres(db);

  // Plataforma BC is still in-memory; the engine ships seeded values for
  // ID_PLATAFORMA_EUNENEM + ID_PLATAFORMA_EUCASEI via the seed array.
  const plataformaRepository = new PlataformaRepositoryMemory();

  return {
    db,
    auth,
    authService,
    usuarioRepository,
    plataformaRepository,
    observability,
    clock: () => new Date(),
    // BetterAuth's default cookie name — keep parity with `auth.handler`
    // mounted at /api/auth/* so the same session cookie is recognized
    // whether the request hits the BetterAuth runtime OR the engine's
    // AuthService through our tRPC procedures.
    sessionCookieName: 'better-auth.session_token',
  };
}

export { ID_PLATAFORMA_EUNENEM };
