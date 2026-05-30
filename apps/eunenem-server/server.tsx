import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { Hono } from 'hono';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { App, resolveRoute } from './pages/App.js';
import { appRouter } from './server/trpc/router.js';

const PORT = Number(process.env.PORT ?? 3001);

const app = new Hono();

// Static assets — esbuild output (client.js), tailwind output (styles.css),
// and any files copied into public/ (logo.png, svgs, etc.).
app.use('/public/*', serveStatic({ root: './' }));

// Health check.
app.get('/healthz', (c) => c.text('ok'));

// tRPC handler (aperture-kungg) — vanilla @trpc/server v11 over Hono via the
// fetch adapter. Routes under /api/trpc/* are dispatched to procedures on
// `appRouter`. Client side uses @trpc/client with the AppRouter *type* only
// (zero runtime coupling).
app.all('/api/trpc/*', (c) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req: c.req.raw,
    router: appRouter,
    createContext: () => ({}),
  }),
);

// "/" now SSRs the marketing landing page (aperture-q1j2) via the catch-all
// below — resolveRoute maps the exact "/" pathname to { kind: 'landing' }.
// (Previously redirected to /pagina/francisco.)

// SSR catch-all: every other route renders the React app. Status is decided
// from the resolved route (200 for known pages, 404 for anything else) BEFORE
// renderToString so the response code is honest.
app.get('*', (c) => {
  const url = new URL(c.req.url);
  const route = resolveRoute(url.pathname);
  const status = route.kind === 'not-found' ? 404 : 200;
  const ssrHtml = renderToString(
    <StrictMode>
      <App pathname={url.pathname} />
    </StrictMode>,
  );
  c.status(status);
  return c.html(envelope(ssrHtml, url.pathname));
});

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
    <title>eunenem · ${escapeHtml(pathname)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Patrick+Hand&display=swap" rel="stylesheet" />
    <style>
      :root {
        --font-patrick-hand: 'Patrick Hand', cursive;
        --font-caveat: 'Caveat', cursive;
        --font-dm-sans: 'DM Sans', system-ui, sans-serif;
      }
    </style>
    <link rel="stylesheet" href="/public/styles.css" />
  </head>
  <body class="min-h-full flex flex-col bg-cream text-ink">
    <div id="root">${ssrHtml}</div>
    <script type="module" src="/public/client.js"></script>
  </body>
</html>`;
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
  console.log('  /pagina/francisco  → contributor event page (SSR + hydration)');
  console.log('  /painel/helena     → creator dashboard (SSR + hydration)');
  console.log('  /trpc-smoke        → tRPC smoke test (aperture-kungg)');
  console.log('  /api/trpc/*        → tRPC procedures (listFruits, ...)');
  console.log('  /healthz           → plain text health check');
  console.log('');
});
