import { PainelHeaderCard } from '@/components/eunenem/painel/PainelHeaderCard';
import { PainelMenu } from '@/components/eunenem/painel/PainelMenu';
import { PainelTopbar } from '@/components/eunenem/painel/PainelTopbar';
import { TweaksPanel } from '@/components/eunenem/TweaksPanel';
import { TweaksProvider } from '@/components/eunenem/TweaksContext';
import { buildPainelMenu, PAINEL_DEMO } from '@/lib/mocks/painelDemo';

// /painel/:slug — creator dashboard (was /painel/[slug]/page.tsx in
// eunenem-v2). v1 only recognises the "helena" slug; the App.tsx router
// already 404s unknown slugs. PainelMenuClient is gone because we don't
// have RSC/server-component boundaries — PainelMenu can be rendered
// directly.
export function PainelPage({ slug }: { slug: string }) {
  const groups = buildPainelMenu(PAINEL_DEMO);
  const initialBabyName = slug.charAt(0).toUpperCase() + slug.slice(1);

  return (
    <TweaksProvider initialState={{ babyName: initialBabyName }}>
      <div className="painel-app">
        <PainelTopbar />
        <PainelHeaderCard snapshot={PAINEL_DEMO} />
        <PainelMenu groups={groups} />
      </div>
      <TweaksPanel />
    </TweaksProvider>
  );
}
