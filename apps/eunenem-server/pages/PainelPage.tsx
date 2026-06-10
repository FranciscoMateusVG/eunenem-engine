import { useEffect, useState } from 'react';

import { PainelHeaderCard } from '@/components/eunenem/painel/PainelHeaderCard';
import { PainelLayout } from '@/components/eunenem/painel/PainelLayout';
import { PainelMenu } from '@/components/eunenem/painel/PainelMenu';
import { PainelTutorialOverlay } from '@/components/eunenem/painel/PainelTutorialOverlay';
import { PainelTutorialTrigger } from '@/components/eunenem/painel/PainelTutorialTrigger';
import { useStubCampanhaIdForSlug, useStubExtratoSummary } from '@/components/eunenem/painel/ExtratoStubData';
import { useContribuicaoList } from '@/lib/contribuicao';
import { buildPainelMenu, PAINEL_DEMO, type PainelEventSnapshot } from '@/lib/mocks/painelDemo';
import {
  useCompletarTutorialMock,
  useTutorialStatusMock,
} from '@/lib/painelTutorialMock';

// /painel/:slug — creator dashboard (was /painel/[slug]/page.tsx in
// eunenem-v2). v1 only recognises the "helena" slug; the App.tsx router
// already 404s unknown slugs.
//
// aperture-vv3i — now built on the shared PainelLayout (topbar + .painel-app
// shell + TweaksProvider/Panel), the same chrome every /painel sub-page uses.
// The dashboard body is just the header card + menu; the menu rows resolve
// their hrefs from the slug via the painelRoutes convention.
//
// aperture-cihww — mocks → real audit. Three swaps now flow through tRPC:
//   1. Presentes recebidos card  → `trpc.recebedor.extrato.summary`
//      (totalRecebidoCents + totalPresentes). Featured row's
//      "9 presentes · R$ 2.840,00 · ver extrato" now mirrors the
//      operator's real saldo.
//   2. Header "recebido até agora" amount + 3-col stats strip
//      (presentes/confirmados/recados) — the presentes column reads from
//      the same summary. Confirmados + recados stay mocked behind their
//      follow-up beads (aperture-7eamc, aperture-mztrb).
//   3. Minha lista de presentes counters → `trpc.contribuicao.list`
//      (total = items.length; claimed = items where `indisponivel`).
// Still mocked (no backend; follow-up beads filed):
//   - Convidados RSVPs              → aperture-7eamc
//   - Mensagens recebidas / X novas → aperture-mztrb
//   - Event countdown date           → aperture-uxv83
//   - Perfil edit affordance         → aperture-5q39i
//   - Bancários "verificado" chip    → aperture-aqiu7
//
// aperture-7nius — Phase B of plan 0018 lands here:
//   • Tutorial gating reads `tutorialStatus.completado === false` and
//     auto-opens the spotlight overlay on first paint for new users.
//   • Floating bottom-right `TUTORIAL` CTA re-triggers the overlay even
//     after completion (locked decision #5).
//   • Top-nav `TUTORIAL` chip wired via `onOpenTutorial` (PainelLayout
//     threads it through to PainelTopbar).
//   • Backend integration uses MOCK hooks today
//     (`useTutorialStatusMock` / `useCompletarTutorialMock`) — swap to
//     `trpc.usuario.tutorialStatus.useQuery()` + `.completarTutorial.
//     useMutation()` when Rex's PR lands. Same call shape, one-line swap.
export function PainelPage({ slug }: { slug: string }) {
  // Real data sources. Each falls back to the PAINEL_DEMO snapshot when
  // the user isn't logged in, has no campanha yet, or the query is
  // still loading — the painel always renders SOMETHING.
  const { idCampanha } = useStubCampanhaIdForSlug(slug);
  const summary = useStubExtratoSummary(idCampanha ?? '');
  const listaQuery = useContribuicaoList();

  const liveReceivedCents = summary.data?.totalRecebidoCents;
  const livePresentes = summary.data?.totalPresentes;

  const liveItems = listaQuery.data ?? null;
  const liveListaTotal = liveItems?.length;
  const liveListaClaimed = liveItems
    ? liveItems.filter((c) => c.indisponivel).length
    : undefined;

  // Merge real values over the demo snapshot. Header card reads
  // receivedCents + giftsClaimed; the menu builder reads receivedCents
  // for the featured row.
  const snapshot: PainelEventSnapshot = {
    ...PAINEL_DEMO,
    receivedCents: liveReceivedCents ?? PAINEL_DEMO.receivedCents,
    // `giftsClaimed` is the "presentes" stat in the header AND the
    // featured-row's "N presentes · R$ X" subtitle. Real source:
    // extrato.summary.totalPresentes (distinct pagamentos contributing
    // to the recebido total).
    giftsClaimed: livePresentes ?? PAINEL_DEMO.giftsClaimed,
  };

  const groups = buildPainelMenu(snapshot, {
    listaTotal: liveListaTotal,
    listaClaimed: liveListaClaimed,
  });

  // aperture-7nius — tutorial state (plan 0018 Phase B).
  // Mock hooks today; swap to trpc.usuario.* once Rex lands Phase A.
  const tutorialStatus = useTutorialStatusMock();
  const completarTutorial = useCompletarTutorialMock();
  const [overlayOpen, setOverlayOpen] = useState(false);

  // Auto-open on first paint for users who haven't completed the
  // tutorial. Also handles the `?tutorial=open` deep-link from sub-pages
  // (TUTORIAL chip clicks on a sub-page navigate to the root with this
  // query so the root can pop the overlay on land).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('tutorial') === 'open') {
      setOverlayOpen(true);
      return;
    }
    if (tutorialStatus.data && !tutorialStatus.data.completado) {
      setOverlayOpen(true);
    }
  }, [tutorialStatus.data]);

  const handleComplete = () => {
    completarTutorial.mutate();
    setOverlayOpen(false);
  };

  const handleDismiss = () => {
    // Plan 0018 §"Dismissal path": ENCERRAR == CONCLUIR for state. Both
    // fire the mutation; the user has been shown the entry-point and
    // that's what the flag tracks.
    completarTutorial.mutate();
    setOverlayOpen(false);
  };

  return (
    <PainelLayout slug={slug} onOpenTutorial={() => setOverlayOpen(true)}>
      <PainelHeaderCard snapshot={snapshot} slug={slug} />
      <PainelMenu groups={groups} slug={slug} />
      <PainelTutorialTrigger
        visible={!overlayOpen}
        onOpen={() => setOverlayOpen(true)}
      />
      <PainelTutorialOverlay
        open={overlayOpen}
        onComplete={handleComplete}
        onDismiss={handleDismiss}
      />
    </PainelLayout>
  );
}
