import { ConvitePreviewBody } from '@/components/eunenem/painel/ConvitePreviewBody';
import { PainelLayout } from '@/components/eunenem/painel/PainelLayout';

export function PainelConvitePreviewPage({ slug }: { slug: string }) {
  return (
    <PainelLayout slug={slug} activeSection="convite">
      <ConvitePreviewBody slug={slug} />
    </PainelLayout>
  );
}
