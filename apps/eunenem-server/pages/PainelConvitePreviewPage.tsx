import { useEffect } from 'react';
import { ConvitePreviewBody } from '@/components/eunenem/painel/ConvitePreviewBody';
import { PainelLayout } from '@/components/eunenem/painel/PainelLayout';
import { sendPageView } from '@/lib/analytics';
import { pageViewProps } from '@/lib/rota-canonica';

export function PainelConvitePreviewPage({ slug }: { slug: string }) {
  // aperture-ai8vg — this route had no page view; rota/publico only.
  useEffect(() => {
    sendPageView('Convite Preview', pageViewProps(window.location.pathname));
  }, []);
  return (
    <PainelLayout slug={slug} activeSection="convite">
      <ConvitePreviewBody slug={slug} />
    </PainelLayout>
  );
}
