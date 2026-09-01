import type { MiddlewareHandler } from 'hono';
import { resolveRoute } from '../pages/App.js';

export interface PainelAccessDependencies {
  findOwnerAccountId(slug: string): Promise<string | null>;
  resolveSessionAccountId(headers: Headers): Promise<string | null>;
  campaignBelongsToOwner(campaignId: string, ownerAccountId: string): Promise<boolean>;
}

/** SSR gate: convite previews are public; dashboard routes remain owner-only. */
export function createPainelAccessMiddleware(
  deps: PainelAccessDependencies,
): MiddlewareHandler {
  return async (c, next) => {
    // Set before every early return; retained by the downstream owner response.
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Cookie');

    const route = resolveRoute(new URL(c.req.url).pathname);
    if (
      route.kind !== 'painel' &&
      route.kind !== 'painel-section' &&
      route.kind !== 'painel-convite-preview'
    ) {
      return c.text('Not found', 404);
    }

    const ownerAccountId = await deps.findOwnerAccountId(route.slug);
    if (!ownerAccountId) return c.text('Not found', 404);

    // Invite previews are deliberately shareable. Validate the slug/campaign
    // relationship, but do not require the viewer to own the dashboard.
    if (route.kind === 'painel-convite-preview') {
      if (
        route.idCampanha &&
        !(await deps.campaignBelongsToOwner(route.idCampanha, ownerAccountId))
      ) {
        return c.text('Not found', 404);
      }
      await next();
      return;
    }

    let sessionAccountId: string | null;
    try {
      sessionAccountId = await deps.resolveSessionAccountId(c.req.raw.headers);
    } catch {
      return c.text('Unable to authenticate', 503);
    }
    if (!sessionAccountId || sessionAccountId !== ownerAccountId) {
      return c.redirect(`/pagina/${route.slug}`, 302);
    }

    if (
      route.idCampanha &&
      !(await deps.campaignBelongsToOwner(route.idCampanha, ownerAccountId))
    ) {
      return c.text('Not found', 404);
    }

    await next();
  };
}
