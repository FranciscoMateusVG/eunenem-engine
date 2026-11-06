import type { resolveRoute } from '../pages/App.js';

// Render metadata in the initial HTML; list names come only from the existing
// anonymous public-profile boundary, never a private owner/admin projection.

type Route = ReturnType<typeof resolveRoute>;

export const SITE_NAME = 'EuNeném';

const HOME_TITLE = `${SITE_NAME} · Lista de chá de bebê online`;
const HOME_DESCRIPTION =
  'Crie grátis sua lista de chá de bebê online. Os convidados presenteiam e você recebe o valor em dinheiro via Pix para o enxoval.';

export interface SeoMeta {
  title: string;
  description: string;
  noindex: boolean;
}

function page(label: string, description = HOME_DESCRIPTION, noindex = false): SeoMeta {
  return { title: `${label} · ${SITE_NAME}`, description, noindex };
}

export interface PublicListSeoProfile {
  nomeBebe: string | null;
  creatorName: string;
}

export function seoMetaForRoute(route: Route, profile?: PublicListSeoProfile): SeoMeta {
  switch (route.kind) {
    case 'landing':
      return { title: HOME_TITLE, description: HOME_DESCRIPTION, noindex: false };
    case 'faq':
      return page(
        'Perguntas frequentes',
        'Tire suas dúvidas sobre a lista de chá de bebê do EuNeném: como funciona, taxas, Pix, cartão e saque.',
      );
    case 'taxas-e-prazos':
      return page(
        'Taxas e prazos',
        'Taxas e prazos do EuNeném: quanto você recebe, quando o dinheiro cai e como funciona o saque.',
      );
    case 'termos-de-uso':
      return page('Termos de uso', 'Termos de uso do EuNeném, a lista de chá de bebê online.');
    case 'pagina': {
      const name = (profile?.nomeBebe?.trim() || profile?.creatorName.trim() || '')
        .replace(/\s+/g, ' ')
        .slice(0, 100);
      if (name) {
        return page(
          `Lista de presentes de ${name}`,
          `Presenteie ${name} pela lista de chá de bebê no EuNeném. Escolha um mimo e pague com Pix ou cartão.`,
        );
      }
      return page(
        'Lista de presentes',
        'Escolha um mimo da lista de chá de bebê e presenteie com Pix ou cartão pelo EuNeném.',
      );
    }
    case 'pagina-sucesso':
      return page('Obrigado pelo mimo', HOME_DESCRIPTION, true);
    case 'confirmar-presenca':
      return page('Confirmar presença', HOME_DESCRIPTION, true);
    case 'login':
      return page('Entrar', HOME_DESCRIPTION, true);
    case 'campanhas':
    case 'painel':
    case 'painel-convite-preview':
    case 'painel-section':
      return page('Minha lista', HOME_DESCRIPTION, true);
    case 'not-found':
      return page('Página não encontrada', HOME_DESCRIPTION, true);
    default:
      // Admin and dev-only surfaces.
      return page('Painel interno', HOME_DESCRIPTION, true);
  }
}

function escapeAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The <head> fragment for one request. `siteUrl` is the canonical public origin. */
export function seoHead(
  route: Route,
  pathname: string,
  siteUrl: string,
  profile?: PublicListSeoProfile,
): string {
  const meta = seoMetaForRoute(route, profile);
  const origin = siteUrl.replace(/\/+$/, '');
  const url = escapeAttr(`${origin}${pathname}`);
  const title = escapeAttr(meta.title);
  const description = escapeAttr(meta.description);
  const lines = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    meta.noindex
      ? '<meta name="robots" content="noindex, nofollow" />'
      : `<link rel="canonical" href="${url}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:locale" content="pt_BR" />',
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${escapeAttr(`${origin}/icon-512.png`)}" />`,
    '<meta name="twitter:card" content="summary" />',
    '<meta name="theme-color" content="#a769a8" />',
    '<link rel="icon" href="/favicon.ico" sizes="32x32" />',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    ...[48, 96, 192].map(
      (size) => `<link rel="icon" href="/favicon-${size}.png" type="image/png" sizes="${size}x${size}" />`,
    ),
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
    '<link rel="manifest" href="/site.webmanifest" />',
  ];
  if (route.kind === 'landing') {
    // Google's site-name source: WebSite structured data on the home page.
    const website = {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      alternateName: ['Eu Neném', 'eunenem'],
      url: `${origin}/`,
    };
    lines.push(
      `<script type="application/ld+json">${JSON.stringify(website).replaceAll('<', '\\u003c')}</script>`,
    );
  }
  return lines.join('\n    ');
}

/** Web app manifest served at /site.webmanifest. */
export const WEB_MANIFEST = {
  name: SITE_NAME,
  short_name: SITE_NAME,
  description: HOME_DESCRIPTION,
  lang: 'pt-BR',
  start_url: '/',
  display: 'standalone',
  background_color: '#f8f7f6',
  theme_color: '#a769a8',
  icons: [
    ...[48, 96, 192].map((size) => ({
      src: `/favicon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png',
    })),
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
} as const;
