import './src/lib/glitchtip/instrument.js'; // MUST stay first — GlitchTip/Sentry init (aperture-sm4el)
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { StrictMode } from 'react';
import type { IdCampanha } from '../../src/index.js';
import {
  confirmarTransferenciaRepasse,
  executarTransferenciaRepasse,
  REPASSE_CONFIRMAR_QUEUE,
  REPASSE_EXECUTAR_QUEUE,
  REPASSE_SWEEP_VERIFICANDO_QUEUE,
  type RepasseConfirmarJobData,
  type RepasseExecutarJobData,
  varrerRepassesVerificandoOrfaos,
} from '../../src/index.js';
import { renderToString } from 'react-dom/server';
import { App, resolveRoute } from './pages/App.js';
import { buildServerDeps, ID_PLATAFORMA_EUNENEM, loadEnv } from './server/auth/setup.js';
import { installBlockedAuthHandlerGuard } from './server/blocked-auth-handler.js';
import { createLegacyBridgeHandler } from './server/legacy-bridge.js';
import { appRouter } from './server/trpc/router.js';
import { createStripeWebhookHandler } from './server/webhooks/stripe-webhook.js';

const PORT = Number(process.env.PORT ?? 3001);

// Boot-time gate (aperture-ht7sq) — fail fast if BETTER_AUTH_SECRET,
// BETTER_AUTH_URL, TRUSTED_ORIGINS, or DATABASE_URL is missing /
// malformed. Throwing here surfaces a readable error in the process
// log instead of a cryptic auth failure on the first request.
const env = loadEnv();
const deps = buildServerDeps(env);

// aperture-vvh2j — automated PIX repasse workers. Start the shared pg-boss
// instance, ensure both queues exist, and register the two workers BEFORE the
// HTTP server comes up. Wrapped so a boss failure logs clearly with full
// context instead of a bare unhandled rejection. pg-boss v12's work handler
// receives an ARRAY of jobs (`Job<Data>[]`); with `batchSize: 1` that array
// holds a single job, giving one-at-a-time processing on the executar queue.
try {
  await deps.boss.start();
  await deps.boss.createQueue(REPASSE_EXECUTAR_QUEUE);
  await deps.boss.createQueue(REPASSE_CONFIRMAR_QUEUE);

  // Executar worker — concurrency 1 (batchSize: 1). Each job drives the
  // transferencia FSM forward (solicitado/falhou → transferindo → aguardando).
  await deps.boss.work<RepasseExecutarJobData>(
    REPASSE_EXECUTAR_QUEUE,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await executarTransferenciaRepasse(deps, { idRepasse: job.data.idRepasse });
      }
    },
  );

  // Confirmar worker — reconcile/poll the provider for terminal status.
  await deps.boss.work<RepasseConfirmarJobData>(
    REPASSE_CONFIRMAR_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        await confirmarTransferenciaRepasse(deps, {
          idRepasse: job.data.idRepasse,
          tentativaConfirmacao: job.data.tentativaConfirmacao,
        });
      }
    },
  );

  // aperture-taacl — orphaned-verificando sweeper. A pg-boss cron schedule
  // lands one job on this queue every 5 minutes; the worker re-arms any
  // repasse stuck in verificando with no pending confirmar job (a confirmar
  // enqueue lost to a crash in the non-atomic window). Money-safe + idempotent
  // (confirmar never pays and no-ops on a non-verificando repasse).
  await deps.boss.createQueue(REPASSE_SWEEP_VERIFICANDO_QUEUE);
  await deps.boss.work(REPASSE_SWEEP_VERIFICANDO_QUEUE, async () => {
    await varrerRepassesVerificandoOrfaos(deps);
  });
  await deps.boss.schedule(REPASSE_SWEEP_VERIFICANDO_QUEUE, '*/5 * * * *');

  console.log(
    '✅ pg-boss repasse workers registered (executar + confirmar + verificando-sweeper)',
  );
} catch (err) {
  console.error('❌ Failed to start pg-boss repasse workers:', err);
  throw err;
}

const app = new Hono();

// CORS for the API surface (aperture-ht7sq). Explicit origin list — NO
// wildcards (T6 from recon §4). `credentials: true` is required for the
// session cookie to round-trip on cross-origin XHR (e.g. local-dev
// front-end on a different port hitting this server's /api/auth/*).
//
// CORS runs ONLY on /api/* — SSR catch-all serves first-party HTML where
// browser CORS doesn't apply.
const allowedOrigins = [env.BETTER_AUTH_URL, ...env.TRUSTED_ORIGINS.split(',').map((s) => s.trim())]
  .filter(Boolean);
app.use(
  '/api/*',
  cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
    exposeHeaders: ['Set-Cookie'],
    maxAge: 600,
  }),
);

// Static assets — esbuild output (client.js), tailwind output (styles.css),
// and any files copied into public/ (logo.png, svgs, etc.).
app.use('/public/*', serveStatic({ root: './' }));

// aperture-cdwdt: real product images + lista pronta covers live under
// public/products/ and public/listas-prontas/. The catalog JSON (and the
// derived contribuicao.imagemUrl values) reference them at URL-root paths
// without the `/public/` prefix so the deployed CDN swap is one config
// change instead of a bundle rebuild. These two mounts serve the same
// on-disk files at the prefix-less URLs the client expects.
app.use('/products/*', serveStatic({ root: './public' }));
app.use('/listas-prontas/*', serveStatic({ root: './public' }));

// Health check.
app.get('/healthz', (c) => c.text('ok'));

// Deny-by-default auth guard (aperture-9tca0, supersedes ln3de denylist) —
// install BEFORE the `auth.handler` catch-all so it wins the route match and
// runs first. Blocks ALL /api/auth/* with byte-identical 410 Gone EXCEPT the
// OAuth allowlist (sign-in/social + callback/*). Closes the cross-tenant
// escalation via /api/auth/update-user + the saga-bypass surface that the
// bq2c9 adapter-casing fix activated. See server/blocked-auth-handler.ts.
installBlockedAuthHandlerGuard(app);

// BetterAuth handler mount (aperture-ht7sq) — MUST come before any
// body-consuming middleware (T4 anti-trap §8 #6). BetterAuth reads
// `c.req.raw.body` directly via the Fetch Request and bypasses Hono's
// body cache; if a middleware upstream calls `c.req.json()` or
// `c.req.parseBody()`, BetterAuth's stream is already drained.
//
// We DON'T install any body-parsing middleware globally, so the order
// here is safe. The CORS middleware above only reads headers + sets
// response headers — never reads the body.
//
// Only the OAuth allowlist (sign-in/social + callback/*) reaches this
// catch-all; the deny-by-default guard above (aperture-9tca0) 410s every
// other /api/auth/* route before it gets here.
app.on(['POST', 'GET'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw));

// tRPC handler (aperture-kungg + aperture-ht7sq) — routes under
// /api/trpc/* dispatched to procedures on `appRouter`. The fetch
// adapter passes the raw Request to BetterAuth via the AuthService
// in `deps`; same body-cache discipline (T4) applies to procedures
// that read cookies.
app.all('/api/trpc/*', (c) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req: c.req.raw,
    router: appRouter,
    createContext: ({ req, resHeaders }) => ({
      deps,
      headers: req.headers,
      resHeaders,
    }),
  }),
);

// Stripe webhook (aperture-24n36) — signature-verified handler that
// dispatches verified events to finalizar* use-cases. MUST be mounted
// AFTER /api/auth/* + /api/trpc/* (those are body-cache sensitive too,
// see T4 anti-trap §8 #6) and BEFORE the SSR catch-all. The handler
// itself reads the raw body via c.req.text() — required so the bytes
// match the HMAC payload Stripe signed. See
// server/webhooks/stripe-webhook.ts for the full security rationale +
// the local `stripe listen` dev workflow.
app.post('/api/webhooks/stripe', createStripeWebhookHandler(deps));

// Legacy bridge (aperture-as0v3) — authed silent login handoff into the 1.0
// system. The /campanhas 1.0 card hits this; it mints a single-use Clerk
// sign-in token for the caller's VERIFIED email and 302s to eunenem.com/ponte.
// Mounted alongside the other /api/* handlers (before the SSR catch-all). All
// security rationale (verified-email trust anchor, sk_live server-only, mint
// rate-limit, fail-open-to-fallback) lives in server/legacy-bridge.ts.
app.get('/api/legacy-bridge', createLegacyBridgeHandler(deps));

// "/" SSRs the marketing landing page via the catch-all below —
// resolveRoute maps the exact "/" pathname to { kind: 'landing' }.
//
// SSR catch-all: every other route renders the React app. Status is
// decided from the resolved route (200 for known pages, 404 for
// anything else) BEFORE renderToString so the response code is honest.
//
// aperture-khbow: /painel/[slug] is now syntactically permissive — any
// well-shaped slug parses to { kind: 'painel', slug }. Existence is
// resolved at SSR time via `findUsuarioBySlug(idPlataforma, slug)`.
// Unknown slug → flip status to 404 BEFORE renderToString so the response
// is honest (matches the rest of the catch-all's discipline).
app.get('*', async (c) => {
  const url = new URL(c.req.url);
  const route = resolveRoute(url.pathname);

  let status = route.kind === 'not-found' ? 404 : 200;

  // Painel routes: confirm the slug's owner exists in the eunenem plataforma.
  // If not, the URL is structurally valid but unowned → 404. The React tree
  // still renders the painel chrome (helps debugging in dev — see the slug
  // we tried), but the HTTP status is honest.
  if (
    route.kind === 'painel' ||
    route.kind === 'painel-section' ||
    route.kind === 'painel-convite-preview'
  ) {
    const owner = await deps.usuarioRepository.findUsuarioBySlug(
      ID_PLATAFORMA_EUNENEM,
      route.slug,
    );
    if (!owner) {
      status = 404;
    } else {
      // aperture-yeauv: per-campanha routing. The painel URL may carry an
      // OPTIONAL campanha PATH segment — /painel/:slug/c/:idCampanha — per the
      // frozen URL contract (the 'c' marker dodges the :section namespace).
      // Extracted here with a self-contained regex so this gate needs no
      // coupling to resolveRoute's route-object shape: until the parser
      // recognizes the /c/ form those URLs are kind:'not-found' (404 above)
      // and this branch never runs; once it does, the id is gated here.
      // PRESENT → findById + confirm it belongs to the slug owner
      // (idsAdministradores includes owner.idConta) — 404 on not-found OR
      // not-owned (non-leaking, same posture as an unknown slug). ABSENT →
      // the painel resolves the owner's oldest campanha at runtime
      // (unchanged back-compat behavior for bare URLs).
      const campanhaSegment = url.pathname.match(/^\/painel\/[^/]+\/c\/([^/]+)/);
      const idCampanha = campanhaSegment?.[1];
      if (idCampanha) {
        const campanha = await deps.campanhaRepository.findById(idCampanha as IdCampanha);
        if (!campanha || !campanha.idsAdministradores.includes(owner.idConta)) {
          status = 404;
        }
      }
    }
  }

  const ssrHtml = renderToString(
    <StrictMode>
      <App pathname={url.pathname} />
    </StrictMode>,
  );
  c.status(status as 200 | 404);
  return c.html(envelope(ssrHtml, url.pathname));
});

// aperture-ga4gtm: GA4 measurement IDs are "G-XXXXXXXXXX", GTM container IDs
// are "GTM-XXXXXXX". Validated before interpolation into the HTML template
// (defense in depth — these come from trusted env vars, not user input, but
// a malformed value should fail closed rather than risk breaking out of the
// <script> tag).
const GA_ID_PATTERN = /^G-[A-Z0-9]+$/;
const GTM_ID_PATTERN = /^GTM-[A-Z0-9]+$/;

function googleAnalyticsSnippet(): string {
  const gaId = process.env.GOOGLE_ANALYTICS;
  if (!gaId || !GA_ID_PATTERN.test(gaId)) return '';
  return `
    <script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments)}
      gtag('js', new Date());
      gtag('config', '${gaId}');
    </script>`;
}

function googleTagManagerHeadSnippet(): string {
  const gtmId = process.env.GOOGLE_TAG_MANAGER;
  if (!gtmId || !GTM_ID_PATTERN.test(gtmId)) return '';
  return `
    <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
      new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
      j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
      'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
      })(window,document,'script','dataLayer','${gtmId}');</script>`;
}

function googleTagManagerBodySnippet(): string {
  const gtmId = process.env.GOOGLE_TAG_MANAGER;
  if (!gtmId || !GTM_ID_PATTERN.test(gtmId)) return '';
  return `
    <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${gtmId}"
      height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`;
}

function envelope(ssrHtml: string, pathname: string): string {
  return `<!doctype html>
<html lang="pt-BR" class="h-full antialiased">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <!-- aperture-q1j2 (Vance): mark JS-active before paint so the landing
         .fade-up reveal only hides content when JS can reveal it. No-JS /
         pre-hydration keeps all content visible. -->
    <script>document.documentElement.classList.add('js')</script>
    <!-- aperture-pjd74: per-request runtime config for the client bundle.
         LEGACY_MIGRACAO_URL lets each environment point the 1.0 card at its
         own old-site host (iw-m4 staging → staging.eunenem.com; prod →
         default) WITHOUT a client rebuild. Serialized with < escaped so an
         operator-set value can never break out of this script tag. -->
    <script>window.__EUNENEM_ENV__=${serializeRuntimeEnv()}</script>
    <title>eunenem · ${escapeHtml(pathname)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Dancing+Script:wght@400;500;600;700&family=Handlee&family=Patrick+Hand&family=Shadows+Into+Light&display=swap" rel="stylesheet" />
    <style>
      :root {
        --font-patrick-hand: 'Patrick Hand', cursive;
        --font-caveat: 'Caveat', cursive;
        --font-dancing-script: 'Dancing Script', cursive;
        --font-shadows-into-light: 'Shadows Into Light', cursive;
        --font-handlee: 'Handlee', cursive;
        --font-dm-sans: 'DM Sans', system-ui, sans-serif;
      }
    </style>
    <link rel="stylesheet" href="/public/styles.css" />${googleAnalyticsSnippet()}${googleTagManagerHeadSnippet()}
  </head>
  <body class="min-h-full flex flex-col bg-cream text-ink">${googleTagManagerBodySnippet()}
    <div id="root">${ssrHtml}</div>
    <script type="module" src="/public/client.js"></script>
  </body>
</html>`;
}

/**
 * aperture-pjd74 — runtime config → client. JSON with `<` escaped to \u003c
 * (script-tag breakout guard). Read per-request so a container env change +
 * restart is enough — no rebuild.
 */
function serializeRuntimeEnv(): string {
  const env: { legacyMigracaoUrl?: string } = {};
  if (process.env.LEGACY_MIGRACAO_URL) {
    env.legacyMigracaoUrl = process.env.LEGACY_MIGRACAO_URL;
  }
  return JSON.stringify(env).replaceAll('<', '\\u003c');
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log('');
  console.log('🌐 eunenem-server');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Listening on http://localhost:${info.port}`);
  console.log('');
  console.log('Routes:');
  console.log('  /                  → marketing landing page (SSR + hydration)');
  console.log('  /pagina/francisco           → contributor event page (SSR + hydration)');
  console.log('  /pagina/francisco/sucesso   → post-Stripe thank-you page (aperture-xh4jk)');
  console.log('  /painel/<slug>     → creator dashboard (SSR + hydration; aperture-khbow)');
  console.log('  /admin             → operator DDD-trace drill-down (aperture-rsidz.1; no auth in v1)');
  console.log('  /trpc-smoke        → tRPC smoke test (aperture-kungg)');
  console.log('  /api/trpc/*        → tRPC procedures (listFruits, auth.*)');
  console.log('  /api/auth/*        → BetterAuth handler (sign-in/sign-up/sign-out/...)');
  console.log('  /api/webhooks/stripe → Stripe webhook (sig-verified; aperture-24n36)');
  console.log('  /healthz           → plain text health check');
  console.log('');
});
