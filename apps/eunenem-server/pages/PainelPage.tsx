import { PainelHeaderCard } from '@/components/eunenem/painel/PainelHeaderCard';
import { PainelLayout } from '@/components/eunenem/painel/PainelLayout';
import { PainelMenu } from '@/components/eunenem/painel/PainelMenu';
import { buildPainelMenu, PAINEL_DEMO } from '@/lib/mocks/painelDemo';

// /painel/:slug — creator dashboard (was /painel/[slug]/page.tsx in
// eunenem-v2). v1 only recognises the "helena" slug; the App.tsx router
// already 404s unknown slugs.
//
// aperture-vv3i — now built on the shared PainelLayout (topbar + .painel-app
// shell + TweaksProvider/Panel), the same chrome every /painel sub-page uses.
// The dashboard body is just the header card + menu; the menu rows resolve
// their hrefs from the slug via the painelRoutes convention.
export function PainelPage({ slug }: { slug: string }) {
  const groups = buildPainelMenu(PAINEL_DEMO);

  return (
    <PainelLayout slug={slug}>
      <PainelHeaderCard snapshot={PAINEL_DEMO} />
      <PainelMenu groups={groups} slug={slug} />
    </PainelLayout>
  );
}
