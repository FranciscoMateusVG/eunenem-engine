import { z } from 'zod';
import {
  AuthServiceBetterAuth,
  type AuthService,
  type Auth,
  type CampanhaRepository,
  CampanhaRepositoryPostgres,
  type CheckoutSessionProvider,
  ConsoleLogger,
  type ContribuicaoRepository,
  ContribuicaoRepositoryPostgres,
  type CriarAuthConfig,
  createDatabase,
  criarAuth,
  type Database,
  ID_PLATAFORMA_EUNENEM,
  type Observability,
  type PagamentoEventPublisher,
  PagamentoEventPublisherMemory,
  type PagamentoProvider,
  PagamentoProviderFake,
  PagamentoProviderStripe,
  type PagamentoRepository,
  PagamentoRepositoryPostgres,
  PlataformaRepositoryMemory,
  type PlataformaRepository,
  type ProvedorRegraTaxa,
  ProvedorRegraTaxaMemory,
  REGRAS_TAXA_SEED,
  type RecebedorRepository,
  RecebedorRepositoryPostgres,
  UsuarioRepositoryPostgres,
  type UsuarioRepository,
} from '../../../../src/index.js';
import { noopTracer } from '../../../../src/observability/tracer.js';
import { getStripe } from '../../src/lib/stripe/stripe.js';

/**
 * Engine-side dependencies wired for the eunenem-server (aperture-ht7sq +
 * aperture-xaha2 visitor checkout wiring).
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
  /**
   * Arrecadação adapters (aperture-d6atj). Needed by `contribuicao.*` tRPC
   * procedures + the eventual `pagina.*` SSR loader. Repository ports are
   * shared single instances built at boot — they hold no per-request state.
   */
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly recebedorRepository: RecebedorRepository;
  /**
   * Pagamentos / Checkout adapters (aperture-xaha2). Wired for the FIRST
   * time here — the engine's pagamentos BC has been in-memory-test-only
   * until visitor checkout. `pagamentoProvider` AND `checkoutSessionProvider`
   * are the SAME instance (PagamentoProviderStripe in prod / fake otherwise),
   * which implements both ports. Repository persisted to Postgres. Event
   * publisher in-memory for now — no event consumers yet.
   */
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly checkoutSessionProvider: CheckoutSessionProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  /**
   * Taxas BC — provider of fee rules per plataforma+tipo. v1 uses the
   * in-memory seed (eunenem: 10% on presentes). When operators need
   * dynamic per-plataforma fees, swap for a Postgres-backed provider.
   */
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
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
const ServerEnvSchema = z
  .object({
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
    /**
     * Stripe server-side keys (aperture-xaha2). REQUIRED in production
     * for the PagamentoProviderStripe DI gate. In development/test the
     * fake provider is wired instead and these stay optional (empty
     * strings allowed for fresh-clone `pnpm dev` workflows).
     *
     * STRIPE_PUBLISHABLE_KEY is consumed by the client bundle via
     * esbuild's `define` (see build.mjs) — it must be set at BUILD time,
     * not just runtime, for the embedded checkout to mount.
     *
     * STRIPE_WEBHOOK_SECRET is consumed by the /api/webhooks/stripe
     * handler (aperture-24n36) for signature verification. Local dev:
     * `stripe listen --forward-to localhost:3001/api/webhooks/stripe`
     * prints a per-session whsec_xxx; paste it into .env.
     */
    STRIPE_PUBLISHABLE_KEY: z.string().default(''),
    STRIPE_SECRET_KEY: z.string().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.STRIPE_SECRET_KEY.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['STRIPE_SECRET_KEY'],
          message: 'STRIPE_SECRET_KEY required in production (Stripe adapter is the prod default).',
        });
      }
      if (env.STRIPE_PUBLISHABLE_KEY.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['STRIPE_PUBLISHABLE_KEY'],
          message: 'STRIPE_PUBLISHABLE_KEY required in production (client bundle needs it at build time).',
        });
      }
      if (env.STRIPE_WEBHOOK_SECRET.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['STRIPE_WEBHOOK_SECRET'],
          message: 'STRIPE_WEBHOOK_SECRET required in production (signature verification gate).',
        });
      }
    }
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
 * - Pagamento provider DI is gated by NODE_ENV: Stripe in production,
 *   PagamentoProviderFake otherwise. The fake implements BOTH ports
 *   (PagamentoProvider + CheckoutSessionProvider) so dev/test flows
 *   exercise the same code paths the prod adapter takes.
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

  // Arrecadação BC — Campanha + Recebedor + Contribuicao on Postgres, sharing
  // the same Kysely instance as the engine's domain repos (§8 #2 anti-trap).
  // p8i01 made Campanha+Recebedor required deps for the signup saga;
  // d6atj adds Contribuicao for the tRPC `contribuicao.*` procedures.
  // Order matters: CampanhaRepository depends on RecebedorRepository to
  // resolve the active recebedor.
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  const campanhaRepository = new CampanhaRepositoryPostgres(db, recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryPostgres(db);

  // Pagamentos BC — first wiring (aperture-xaha2). Repository persisted
  // to Postgres (migration 011). Event publisher in-memory; no consumers
  // yet. Provider gated by NODE_ENV — same instance covers both ports
  // (PagamentoProvider + CheckoutSessionProvider).
  const pagamentoRepository = new PagamentoRepositoryPostgres(db);
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

  let pagamentoProvider: PagamentoProvider;
  let checkoutSessionProvider: CheckoutSessionProvider;
  if (env.NODE_ENV === 'production') {
    const stripeAdapter = new PagamentoProviderStripe({ stripe: getStripe() });
    pagamentoProvider = stripeAdapter;
    checkoutSessionProvider = stripeAdapter;
  } else {
    // Dev / test default: deterministic fake. No network calls, no Stripe
    // secret required. Set NODE_ENV=production locally to exercise the
    // real Stripe path (alongside `stripe listen --forward-to ...` for
    // the webhook half).
    const fakeAdapter = new PagamentoProviderFake();
    pagamentoProvider = fakeAdapter;
    checkoutSessionProvider = fakeAdapter;
  }

  // Taxas BC — in-memory seed (10% on eunenem presentes; see REGRAS_TAXA_SEED).
  // Default-construction is also seed-backed; passing explicitly for clarity.
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory(REGRAS_TAXA_SEED);
  // Silence the "unused import" complaint if we ever drop REGRAS_TAXA_SEED above.
  void REGRAS_TAXA_SEED;

  return {
    db,
    auth,
    authService,
    usuarioRepository,
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
    pagamentoRepository,
    pagamentoProvider,
    checkoutSessionProvider,
    pagamentoEventPublisher,
    provedorRegraTaxa,
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
