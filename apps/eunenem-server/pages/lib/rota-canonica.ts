/**
 * aperture-ai8vg — canonical route templates for analytics.
 *
 * Page views must be countable per PAGE, not per person: the slug in
 * /pagina/:slug is the owner's first name (PII) and /:slug/confirmar-presenca/
 * :idConvidado addresses one guest. Every page view therefore carries `rota`,
 * a fixed template with all dynamic segments replaced, and `publico`, the
 * audience the template serves. No query string, hash, token or id ever
 * reaches the template. Pure, mirrors App.tsx `resolveRoute` (keep in sync —
 * unit-tested against every route family).
 *
 * `/admin/*` is deliberately NOT instrumented while the telemetry privacy
 * HOLD (aperture-bdd59) is open; the template exists only so a stray call
 * classifies correctly.
 */
export type PublicoRota = 'visitante' | 'convidado' | 'criador' | 'admin';

const ROTAS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/$/, '/'],
  [/^\/termos-de-uso\/?$/, '/termos-de-uso'],
  [/^\/trpc-smoke\/?$/, '/trpc-smoke'],
  [/^\/auth-demo\/?$/, '/auth-demo'],
  [/^\/faq\/?$/, '/faq'],
  [/^\/campanhas\/?$/, '/campanhas'],
  [/^\/admin(?:\/.*)?$/, '/admin/*'],
  [/^\/pagina\/[^/]+\/sucesso\/?$/, '/pagina/:slug/sucesso'],
  [/^\/pagina\/[^/]+\/c\/[^/]+\/?$/, '/pagina/:slug/c/:idCampanha'],
  [/^\/pagina\/[^/]+\/[^/]+\/?$/, '/pagina/:slug/:campanhaSlug'],
  [/^\/pagina\/[^/]+\/?$/, '/pagina/:slug'],
  [/^\/[^/]+\/confirmar-presenca\/[^/]+\/?$/, '/:slug/confirmar-presenca/:idConvidado'],
  [/^\/painel\/[^/]+\/convite\/preview\/?$/, '/painel/:slug/convite/preview'],
  [/^\/painel\/[^/]+\/c\/[^/]+\/convite\/preview\/?$/, '/painel/:slug/c/:idCampanha/convite/preview'],
  [/^\/painel\/[^/]+\/c\/[^/]+\/[^/]+\/?$/, '/painel/:slug/c/:idCampanha/:section'],
  [/^\/painel\/[^/]+\/c\/[^/]+\/?$/, '/painel/:slug/c/:idCampanha'],
  [/^\/painel\/[^/]+\/[^/]+\/?$/, '/painel/:slug/:section'],
  [/^\/painel\/[^/]+\/?$/, '/painel/:slug'],
];

export const ROTA_NAO_ENCONTRADA = '404';

/** Strip query/hash defensively, then match the first template. */
export function rotaCanonica(pathname: string): string {
  const path = pathname.split('?')[0]?.split('#')[0] ?? '';
  for (const [re, rota] of ROTAS) {
    if (re.test(path)) return rota;
  }
  return ROTA_NAO_ENCONTRADA;
}

export function publicoDaRota(rota: string): PublicoRota {
  if (rota === '/admin/*') return 'admin';
  // /campanhas is the post-login creator hub (anonymous visitors are
  // redirected away before any view is emitted — see CampanhasPage).
  if (rota === '/campanhas' || rota.startsWith('/painel/')) return 'criador';
  if (rota === '/:slug/confirmar-presenca/:idConvidado') return 'convidado';
  return 'visitante';
}

/**
 * The campanha id a public gift-page view should carry: the SERVER-resolved
 * projection id (perfil.getPerfilPublicoBySlug resolves the bare /pagina/:slug
 * to the owner's oldest campanha), cross-checked against the route's explicit
 * id when /c/:idCampanha is present. A mismatch — which the server should make
 * impossible — yields undefined rather than a wrong attribution.
 */
export function idCampanhaParaPageView(
  idRota: string | undefined,
  idResolvido: string | null | undefined,
): string | undefined {
  if (!idResolvido) return undefined;
  if (idRota !== undefined && idRota !== idResolvido) return undefined;
  return idResolvido;
}

/**
 * Props for `sendPageView`: the canonical template + audience, plus caller
 * extras (only opaque ids — never slug, never names). Callers pass
 * `window.location.pathname` from inside a client effect.
 */
export function pageViewProps(
  pathname: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const rota = rotaCanonica(pathname);
  return { rota, publico: publicoDaRota(rota), ...extra };
}
