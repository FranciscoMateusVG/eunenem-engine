import { z } from 'zod';
import {
  AuthServiceBetterAuth,
  type AuthService,
  type Auth,
  type CampanhaRepository,
  CampanhaRepositoryPostgres,
  type ConviteRepository,
  ConviteRepositoryPostgres,
  type CheckoutSessionProvider,
  ConsoleLogger,
  type ContribuicaoRepository,
  ContribuicaoRepositoryPostgres,
  type CriarAuthConfig,
  createDatabase,
  criarAuth,
  type Database,
  ID_PLATAFORMA_EUNENEM,
  type EventoRepository,
  EventoRepositoryPostgres,
  type LivroFinanceiroRepository,
  LivroFinanceiroRepositoryPostgres,
  type EmailTransport,
  EmailTransportNodemailer,
  EmailTransportNoop,
  type EmitirUrlUploadInput,
  type EmitirUrlUploadItemInput,
  type ObjectStorage,
  ObjectStorageMinio,
  type UrlUploadPresignada,
  type WebhookEventArchive,
  WebhookEventArchivePostgres,
  type Observability,
  type PagamentoEventPublisher,
  PagamentoEventPublisherMemory,
  type PagamentoProvider,
  PagamentoProviderFake,
  PagamentoProviderStripe,
  type PagamentoRepository,
  PagamentoRepositoryPostgres,
  type DadosRecebimentoRepository,
  DadosRecebimentoRepositoryPostgres,
  type PerfilCriadorRepository,
  PerfilCriadorRepositoryPostgres,
  type ResgatePendenteRepository,
  ResgatePendenteRepositoryPostgres,
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
import { renderMagicLinkEmail } from './magic-link-email.js';
import { parseAdminAllowedEmails } from './admin-allowlist.js';
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
  /**
   * PerfilCriador BC adapter (aperture-cdo69). Backs the `perfil.*` tRPC
   * procedures — authed read/write of the creator profile + the public
   * `getPerfilPublicoBySlug` projection. Postgres-backed (migration 026),
   * sharing the same Kysely instance as the other domain repos.
   */
  readonly perfilCriadorRepository: PerfilCriadorRepository;
  /**
   * DadosRecebimentoUsuario BC adapter (aperture-mcvyw). Backs the
   * `dadosRecebimento.*` tRPC procedures — authed read/write of the user-level
   * receiving data (pix | conta). Postgres-backed (migration 028), sharing
   * the same Kysely instance as the other domain repos.
   */
  readonly dadosRecebimentoRepository: DadosRecebimentoRepository;
  /**
   * Resgate-pendente marker store (aperture-kj9el #4b). Backs the
   * `dadosRecebimento.marcarResgatePendente` mutation + the pending field on
   * `dadosRecebimento.get`. Postgres-backed (migration 030), sharing the same
   * Kysely instance as the other domain repos.
   */
  readonly resgatePendenteRepository: ResgatePendenteRepository;
  readonly plataformaRepository: PlataformaRepository;
  /**
   * Arrecadação adapters (aperture-d6atj). Needed by `contribuicao.*` tRPC
   * procedures + the eventual `pagina.*` SSR loader. Repository ports are
   * shared single instances built at boot — they hold no per-request state.
   */
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly recebedorRepository: RecebedorRepository;
  /** Evento BC — event metadata + invite content for the painel convite flow. */
  readonly eventoRepository: EventoRepository;
  readonly conviteRepository: ConviteRepository;
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
   * Financeiro BC — livro de lançamentos. Required by the
   * `finalizarPagamentoAprovado` use-case dispatched by the Stripe
   * webhook handler (aperture-24n36). In-memory for now: no Postgres
   * adapter exists yet for this BC (same trade-off as
   * `pagamentoEventPublisher` above). Swap when the Postgres adapter
   * lands.
   */
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  /**
   * Taxas BC — provider of fee rules per plataforma+tipo. v1 uses the
   * in-memory seed (eunenem: 10% on presentes). When operators need
   * dynamic per-plataforma fees, swap for a Postgres-backed provider.
   */
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly observability: Observability;
  /**
   * Normalized allowlist of operator emails permitted into the `/admin` surface
   * (aperture-4n222). Parsed once at boot from `ADMIN_ALLOWED_EMAILS`. Read by
   * the server-side `adminProcedure` gate (the security boundary) AND `auth.me`'s
   * `isAdmin` flag — single source so enforcement + UI signal never drift.
   * Empty = nobody is admin = fail-closed.
   */
  readonly adminAllowedEmails: ReadonlySet<string>;
  readonly clock: () => Date;
  /** Cookie name shared by the engine's BetterAuth sessions table + our tRPC procedures. */
  readonly sessionCookieName: string;
  /**
   * Public origin of the eunenem-server (= `env.BETTER_AUTH_URL`), passed
   * through so the visitor-checkout tRPC procedures can build a
   * `returnUrl` for Stripe's embedded checkout without reading
   * `process.env` at call time (aperture-vkrkm). Same value the BetterAuth
   * runtime uses for its `baseURL`; centralised here so a single env
   * change moves both surfaces in lockstep.
   */
  readonly publicOrigin: string;
  /**
   * Number of trusted reverse-proxy hops between the origin process and
   * the public internet (aperture-uc2ix + aperture-3pqt7). Used by
   * `trustedClientIp` to read the rightmost-N entries of `X-Forwarded-For`.
   * Dev (no proxy): 0. Single-proxy prod (Dokploy/Nginx): 1.
   * Cloudflare → Nginx → app: 2. Pick wrong = security failure; see
   * `trusted-client-ip.ts` for rationale.
   */
  readonly trustedHopCount: number;
  /**
   * Per-deployment salt for hashing client PII (email, IP) in structured
   * logs + sessions.ip_address (aperture-3pqt7 / T9). REQUIRED in production
   * (≥32 chars). Rotating breaks log correlation across rotations —
   * intentional; treat as tier-1 secret alongside session signing keys.
   */
  readonly logPiiHashSalt: string;
  /**
   * Webhook event archive (aperture-1n6u8). Stripe webhook handler
   * writes raw events here BEFORE signature verification for forensic
   * audit + retry idempotency + provider-migration survival. NOT a
   * domain concept — lives at the infrastructure boundary.
   */
  readonly webhookEventArchive: WebhookEventArchive;
  /**
   * Object storage (aperture-kcasm). Emits presigned PUT URLs so the client
   * uploads profile photos directly to the MinIO bucket. Gated on
   * MINIO_ENDPOINT: configured → ObjectStorageMinio; otherwise a fallback
   * that throws on use (so a fresh-clone dev boot doesn't crash but photo
   * upload fails loudly). NOT a domain concept — infrastructure boundary.
   */
  readonly objectStorage: ObjectStorage;
}

/**
 * Fallback ObjectStorage for unconfigured (MINIO_* absent) boots. Lets a
 * fresh-clone `pnpm dev` start; any photo-upload attempt fails loudly
 * instead of silently 500ing on a half-wired adapter.
 */
class ObjectStorageNaoConfigurado implements ObjectStorage {
  async emitirUrlUploadPresignada(_input: EmitirUrlUploadInput): Promise<UrlUploadPresignada> {
    throw new Error('storage não configurado (MINIO_* ausente)');
  }

  async emitirUrlUploadPresignadaItem(
    _input: EmitirUrlUploadItemInput,
  ): Promise<UrlUploadPresignada> {
    throw new Error('storage não configurado (MINIO_* ausente)');
  }

  urlPublica(_objectKey: string): string {
    // Only reached if a profile already has a stored photo key, which can't
    // happen without MINIO configured (upload requires it). Fail loudly.
    throw new Error('storage não configurado (MINIO_* ausente)');
  }

  extrairKey(urlOuKey: string): string {
    // Pure normalization — no base to strip without an endpoint. A bare key
    // passes through unchanged; safe to call even unconfigured.
    return urlOuKey;
  }
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
     * Comma-separated allowlist of operator emails permitted into the `/admin`
     * surface (aperture-4n222). Parsed into a normalized Set on ServerDeps and
     * read by BOTH the server-side `adminProcedure` gate and the `auth.me`
     * `isAdmin` flag. OPTIONAL with a default of '' — unset/empty = nobody is
     * admin = fail-closed (the admin area locks down rather than opening up).
     * Seeded in prod (Dokploy env) with franciscomateusvg@gmail.com; extending
     * the admin set is an env edit, no code migration/deploy.
     */
    ADMIN_ALLOWED_EMAILS: z.string().default(''),
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
    /**
     * Trusted reverse-proxy hop count (aperture-uc2ix). Default 0 for
     * dev (no proxy in front of localhost:3001). Prod MUST set this
     * to 1+ matching deploy topology — see ServerDeps.trustedHopCount.
     */
    TRUSTED_HOP_COUNT: z.coerce.number().int().nonnegative().default(0),
    /**
     * Per-deployment salt for client-PII hashing (aperture-3pqt7).
     * REQUIRED in production (≥32 chars). Generate via
     * `openssl rand -hex 32`.
     */
    LOG_PII_HASH_SALT: z.string().default(''),
    /**
     * MinIO / S3-compatible object storage (aperture-kcasm). Powers
     * presigned-PUT profile-photo uploads. All optional with '' defaults so
     * a fresh-clone dev boot doesn't crash; when MINIO_ENDPOINT is present
     * the real adapter is wired, otherwise photo upload fails loudly at use.
     *
     * MINIO_REGION is a placeholder (MinIO ignores it but aws-sdk requires a
     * value) — defaults to us-east-1.
     */
    MINIO_ENDPOINT: z.string().default(''),
    MINIO_REGION: z.string().default('us-east-1'),
    MINIO_ACCESS_KEY: z.string().default(''),
    MINIO_SECRET_KEY: z.string().default(''),
    MINIO_BUCKET: z.string().default('eunenem-perfil-fotos'),
    /**
     * Google OAuth credentials (aperture-8655f). Both OPTIONAL so the server
     * still boots in environments without them — when EITHER is absent the
     * google social provider is NOT registered (email+password still works).
     * Set in the deploy env (Dokploy) by the infra owner; the SECRET is never
     * committed. The OAuth callback lands at the BetterAuth-standard
     * `<BETTER_AUTH_URL>/api/auth/callback/google` path (auth.handler is
     * mounted at /api/auth/* in server.tsx).
     */
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    /**
     * aperture-y5ual — Microsoft (Entra) OAuth, mirrors GOOGLE_*. Same
     * conditional-registration posture: when CLIENT_ID/SECRET are absent the
     * microsoft provider is NOT registered (email+password still works). The
     * SECRET is set in the deploy env (Dokploy), never committed. Callback
     * lands at `<BETTER_AUTH_URL>/api/auth/callback/microsoft`.
     * TENANT_ID defaults to 'common' (multi-tenant work/school + personal
     * accounts); the operator can pin a single tenant later via env without a
     * code change — the provider itself also falls back to 'common'.
     */
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_TENANT_ID: z.string().optional().default('common'),
    /**
     * aperture-lwx2k (Camada C) — SMTP transport for magic-link + future
     * transactional email. Same conditional-registration posture as the OAuth
     * providers: when HOST/USER/PASS are absent the transport is a boot-safe
     * no-op and the magicLink plugin is NOT registered (passwordless off). Set
     * in the deploy env (Dokploy); the PASS is never committed. SECURE=false +
     * PORT 587 → STARTTLS; SECURE=true + PORT 465 → implicit TLS.
     */
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional().default('EuNenem <oi@eunenem.com>'),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .default('false')
      .transform((v) => v === 'true'),
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
      if (env.LOG_PII_HASH_SALT.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['LOG_PII_HASH_SALT'],
          message:
            'LOG_PII_HASH_SALT required in production (≥32 chars; client-PII hashing salt).',
        });
      }
      if (env.TRUSTED_HOP_COUNT < 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['TRUSTED_HOP_COUNT'],
          message:
            'TRUSTED_HOP_COUNT must be ≥1 in production (set to the number of trusted reverse-proxy hops; rate-limit + audit log accuracy depends on it).',
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

  // Google OAuth (aperture-8655f) — CONDITIONAL on BOTH env vars being
  // present. When either is missing, `socialProviders` stays undefined and
  // criarAuth omits the key entirely → email+password-only BetterAuth that
  // boots cleanly in envs without Google credentials (the critical safety
  // property). The real CLIENT_SECRET is set in the deploy env (Dokploy),
  // never committed.
  const googleConfigured =
    !!env.GOOGLE_CLIENT_ID?.length && !!env.GOOGLE_CLIENT_SECRET?.length;
  // aperture-y5ual — Microsoft (Entra) mirrors Google: registered ONLY when
  // BOTH env vars are present; otherwise omitted so BetterAuth boots without
  // Microsoft creds.
  const microsoftConfigured =
    !!env.MICROSOFT_CLIENT_ID?.length && !!env.MICROSOFT_CLIENT_SECRET?.length;

  // Build ONE socialProviders object so providers coexist. Two separate
  // conditional `...(x ? { socialProviders: {...} } : {})` spreads would
  // clobber each other (last-write-wins drops the first provider). We spread
  // the whole key in only when at least one provider is configured, preserving
  // the "undefined → email+password-only, boots cleanly" safety property.
  const socialProviders = {
    ...(googleConfigured
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID as string,
            clientSecret: env.GOOGLE_CLIENT_SECRET as string,
          },
        }
      : {}),
    ...(microsoftConfigured
      ? {
          microsoft: {
            clientId: env.MICROSOFT_CLIENT_ID as string,
            clientSecret: env.MICROSOFT_CLIENT_SECRET as string,
            // 'common' = multi-tenant + personal MSAs. From env so the operator
            // can pin a single tenant later without a code change; the provider
            // also defaults to 'common' when this is omitted.
            tenantId: env.MICROSOFT_TENANT_ID,
          },
        }
      : {}),
  };

  // aperture-lwx2k (Camada C) — SMTP transport, CONDITIONAL like the OAuth
  // providers: a real nodemailer transport only when HOST+USER+PASS are all
  // present; otherwise a boot-safe no-op (and magic-link stays OFF — we only
  // pass sendMagicLink to criarAuth when configured, so the plugin isn't
  // registered without a real sender). The transport is SHARED — magic-link
  // now; the c0a5s thank-you + future reset/verify reuse the same seam.
  const smtpConfigured =
    !!env.SMTP_HOST?.length && !!env.SMTP_USER?.length && !!env.SMTP_PASS?.length;
  const emailTransport: EmailTransport = smtpConfigured
    ? new EmailTransportNodemailer({
        host: env.SMTP_HOST as string,
        port: env.SMTP_PORT,
        user: env.SMTP_USER as string,
        pass: env.SMTP_PASS as string,
        from: env.SMTP_FROM,
        secure: env.SMTP_SECURE,
      })
    : new EmailTransportNoop(observability.logger);

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
    // aperture-lwx2k (Camada C) — enable magic-link ONLY when SMTP is
    // configured (passing sendMagicLink is what makes criarAuth spread the
    // plugin). The keystone password-invalidation hook (session.create.before)
    // ships in criar-auth.ts regardless; the plugin is what activates the
    // verify path it protects.
    ...(smtpConfigured
      ? {
          sendMagicLink: async ({ email, url }: { email: string; url: string }) => {
            await emailTransport.enviar(renderMagicLinkEmail(email, url));
          },
        }
      : {}),
    // aperture-dm7s3 — default platform id for adapter-created users (OAuth
    // signup). The Google profile carries no idPlataforma + the column is
    // notNull, so a new-user Google signup needs this injected. eunenem-server
    // is single-tenant for OAuth signup → the seeded ID_PLATAFORMA_EUNENEM.
    idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
    // Spread the social providers in ONLY when at least one is configured;
    // otherwise the key is absent and no social provider is registered.
    ...(Object.keys(socialProviders).length > 0 ? { socialProviders } : {}),
  };

  const auth = criarAuth(db, authConfig);

  const authService: AuthService = new AuthServiceBetterAuth(db, {
    clock: () => new Date(),
  });

  const usuarioRepository = new UsuarioRepositoryPostgres(db);
  const perfilCriadorRepository = new PerfilCriadorRepositoryPostgres(db);
  const dadosRecebimentoRepository = new DadosRecebimentoRepositoryPostgres(db);
  const resgatePendenteRepository = new ResgatePendenteRepositoryPostgres(db);

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
  const eventoRepository = new EventoRepositoryPostgres(db);
  const conviteRepository = new ConviteRepositoryPostgres(db);

  // Pagamentos BC — first wiring (aperture-xaha2). Repository persisted
  // to Postgres (migration 011). Event publisher in-memory; no consumers
  // yet. Provider gated by NODE_ENV — same instance covers both ports
  // (PagamentoProvider + CheckoutSessionProvider).
  const pagamentoRepository = new PagamentoRepositoryPostgres(db);
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

  // Financeiro BC — postgres-backed livro (aperture-id3ay, migration
  // 012). Before this swap, the memory adapter was losing every
  // saga's lancamentos on tsx-watch reload / production deploy. The
  // recebedorRepository is passed so the adapter can delegate
  // `findRecebedorAtivoPorIdCampanha` to Arrecadação (cross-BC read;
  // Financeiro doesn't own recebedor data — same pattern as the
  // memory adapter).
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryPostgres(
    db,
    recebedorRepository,
  );

  // Payment webhook archive (aperture-1n6u8) — postgres-backed by
  // migration 016. The Stripe webhook handler writes to this BEFORE
  // signature verification (write-before-verify discipline; see
  // src/adapters/webhook-archive/stripe-webhook-pipeline.ts).
  const webhookEventArchive = new WebhookEventArchivePostgres(db);

  // Object storage (aperture-kcasm) — gate on MINIO_ENDPOINT presence,
  // mirroring the Stripe-key gate above. Configured → real MinIO adapter
  // (presigned PUT). Otherwise a fallback that throws on use, so a
  // fresh-clone `pnpm dev` boots but photo upload fails loudly instead of
  // half-wiring a broken adapter.
  let objectStorage: ObjectStorage;
  if (env.MINIO_ENDPOINT.length > 0) {
    objectStorage = new ObjectStorageMinio({
      endpoint: env.MINIO_ENDPOINT,
      region: env.MINIO_REGION,
      accessKeyId: env.MINIO_ACCESS_KEY,
      secretAccessKey: env.MINIO_SECRET_KEY,
      bucket: env.MINIO_BUCKET,
    });
  } else {
    objectStorage = new ObjectStorageNaoConfigurado();
  }

  let pagamentoProvider: PagamentoProvider;
  let checkoutSessionProvider: CheckoutSessionProvider;
  // aperture-ozlcr: gate on STRIPE_SECRET_KEY presence, NOT NODE_ENV.
  //
  // Originally this gated on `NODE_ENV === 'production'`. That broke
  // operator's daily dev workflow: to exercise the real Stripe integration
  // locally (test-mode keys + `stripe listen --forward-to ...`), the
  // operator would have to flip NODE_ENV=production, which has side
  // effects (Secure cookie flag rejects HTTP cookies on localhost, log
  // verbosity drops, etc). Stripe.js then rejects the fake adapter's
  // `cs_fake_xxx` clientSecrets with:
  //   IntegrationError: Unable to parse client secret. Please ensure you
  //   are using a valid embedded Checkout client secret.
  //
  // Better gate: bind the real Stripe adapter whenever STRIPE_SECRET_KEY
  // is configured (test-mode in dev, live in prod). Fall back to the fake
  // adapter only for fresh-clone configurations where no Stripe secret is
  // present — a brand-new repo clone can still `pnpm dev` without
  // crashing on missing-key boot validation.
  //
  // Production safety is preserved by the env-schema superRefine above:
  // NODE_ENV=production STILL requires STRIPE_SECRET_KEY (and prevents
  // the empty-string branch from firing in prod).
  if (env.STRIPE_SECRET_KEY.length > 0) {
    const stripeAdapter = new PagamentoProviderStripe({ stripe: getStripe() });
    pagamentoProvider = stripeAdapter;
    checkoutSessionProvider = stripeAdapter;
  } else {
    // Fresh-clone / unconfigured-dev fallback: deterministic fake. No
    // network, no real Stripe account needed. Drop test-mode keys into
    // .env to flip to the real adapter automatically on next boot.
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
    perfilCriadorRepository,
    dadosRecebimentoRepository,
    resgatePendenteRepository,
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
    eventoRepository,
    conviteRepository,
    pagamentoRepository,
    pagamentoProvider,
    checkoutSessionProvider,
    pagamentoEventPublisher,
    livroFinanceiroRepository,
    provedorRegraTaxa,
    observability,
    adminAllowedEmails: parseAdminAllowedEmails(env.ADMIN_ALLOWED_EMAILS),
    clock: () => new Date(),
    // BetterAuth's default cookie name — keep parity with `auth.handler`
    // mounted at /api/auth/* so the same session cookie is recognized
    // whether the request hits the BetterAuth runtime OR the engine's
    // AuthService through our tRPC procedures.
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: env.BETTER_AUTH_URL,
    trustedHopCount: env.TRUSTED_HOP_COUNT,
    logPiiHashSalt: env.LOG_PII_HASH_SALT,
    webhookEventArchive,
    objectStorage,
  };
}

export { ID_PLATAFORMA_EUNENEM };
