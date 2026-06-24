import { useEffect, useState } from 'react';

import { PainelHeaderCard } from '@/components/eunenem/painel/PainelHeaderCard';
import { PainelLayout } from '@/components/eunenem/painel/PainelLayout';
import { PainelMenu } from '@/components/eunenem/painel/PainelMenu';
import { PainelTutorialOverlay } from '@/components/eunenem/painel/PainelTutorialOverlay';
import { PainelTutorialTrigger } from '@/components/eunenem/painel/PainelTutorialTrigger';
import { useStubCampanhaIdForSlug, useStubExtratoSummary } from '@/components/eunenem/painel/ExtratoStubData';
import { useContribuicaoList } from '@/lib/contribuicao';
import { buildPainelMenu, PAINEL_DEMO, type PainelEventSnapshot } from '@/lib/mocks/painelDemo';
import { trpc } from '@/lib/trpc';

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
//     after completion (locked decision #5). NOTE: aperture-0mplv removed
//     the top-nav TUTORIAL chip; the floating CTA is now the sole
//     re-trigger surface (openOverlay still wires it below).
//   • Backend integration via `trpc.usuario.tutorialStatus.useQuery()`
//     + `.completarTutorial.useMutation()` (Rex's Phase A landed in #192).
//     Pre-swap mock scaffolding deleted in aperture-4my2a.
//
// aperture-4my2a — P0 dismiss-loop fix. Operator: "im stuck on encerrar
// tutorial no matter how many times i click i cant get away of it". Root
// cause: the auto-open useEffect depends on `tutorialStatus.data`. Even
// after dismiss (which sets `overlayOpen=false`), the next React Query
// settle/refetch would surface the SAME data reference (or, with the
// pre-persistence mock, the same `{completado: false}` payload), so the
// useEffect would re-fire and slam the overlay back open. Operator
// trapped.
//
// Fix: introduce a session-scoped `dismissedThisSession` boolean. Once
// the user dismisses (ENCERRAR / CONCLUIR / Esc), we set this to true
// and the auto-open effect honours it — even if the wire later says
// `completado: false` (rare; mutation just round-tripped) the overlay
// stays closed for the rest of this session. The floating TUTORIAL CTA
// (and the topbar chip) explicitly reset `dismissedThisSession=false`
// before opening, so re-triggering still works.
export function PainelPage({ slug }: { slug: string }) {
  // Real data sources. Each falls back to the PAINEL_DEMO snapshot when
  // the user isn't logged in, has no campanha yet, or the query is
  // still loading — the painel always renders SOMETHING.
  const { idCampanha } = useStubCampanhaIdForSlug(slug);
  const summary = useStubExtratoSummary(idCampanha ?? '');
  const listaQuery = useContribuicaoList();

  const liveReceivedCents = summary.data?.totalRecebidoCents;
  const livePresentes = summary.data?.totalPresentes;
  // aperture-kvpvf — finishes the B1 audit. Wire the strip-only
  // PRESENTES + RECADOS counters from the same summary proc. Optional
  // reads keep the swap safe across the trpc cache-rotation window.
  const livePresentesStrip = summary.data?.totalPresentesItensCount;
  const liveRecadosStrip = summary.data?.totalRecadosCount;

  const liveItems = listaQuery.data ?? null;
  const liveListaTotal = liveItems?.length;
  const liveListaClaimed = liveItems
    ? liveItems.filter((c) => c.indisponivel).length
    : undefined;

  // aperture-77512 — the creator's REAL first name for the "olá, {name}"
  // greeting (was the demo "Mari"). First word of nomeExibicao.
  const perfilQ = trpc.perfil.getPerfil.useQuery(undefined, { staleTime: 30_000 });
  const greetingFirstName =
    (perfilQ.data?.creatorName ?? "").trim().split(/\s+/)[0] ?? "";

  // aperture-3ic62 — the REAL baby name for the "página da <X>" header.
  // Was seeded from the slug inside PainelLayout, which is the creator's
  // OWN name → the header repeated the greeting ("olá, Teste" / "página da
  // Teste"). Thread nomeBebe from the same getPerfil query; null (unset or
  // still loading) → PainelLayout falls back to the neutral "bebê", never
  // the slug.
  const babyName = perfilQ.data?.nomeBebe ?? null;

  // aperture-84a21 — the REAL event date for the painel countdown + date chip.
  // null (unset / fresh account / still loading) → PainelHeaderCard shows NO
  // date (the old mock "15 jun 2026" / "0 dias" gap is closed). Mirrors the
  // guest Hero (3ic62), which already gates its countdown on the real date.
  const eventDate = perfilQ.data?.dataEvento
    ? String(perfilQ.data.dataEvento).slice(0, 10)
    : null;

  // aperture-77512 — Merge REAL values over the demo snapshot, falling back to
  // ZERO (never the PAINEL_DEMO numbers) so a brand-new creator never sees a
  // stranger's fabricated stats (Mari / helena / 28 confirmados / 12 recados).
  // greetingTo + shareSlug come from the real account; counters use live data
  // when present else 0; unwired metrics (guest RSVP) are honestly 0 until
  // those features ship.
  const snapshot: PainelEventSnapshot = {
    ...PAINEL_DEMO,
    greetingTo: greetingFirstName,
    shareSlug: slug,
    receivedCents: liveReceivedCents ?? 0,
    giftsClaimed: livePresentes ?? 0,
    guestsConfirmed: 0,
    guestsTotal: 0,
    messagesTotal: liveRecadosStrip ?? 0,
    messagesNew: 0,
    presentesStripCount: livePresentesStrip ?? 0,
    recadosStripCount: liveRecadosStrip ?? 0,
  };

  const groups = buildPainelMenu(snapshot, {
    listaTotal: liveListaTotal,
    listaClaimed: liveListaClaimed,
  });

  // aperture-7nius / aperture-4my2a — tutorial state (Plan 0018 Phase B,
  // real-tRPC swap).
  const tutorialStatus = trpc.usuario.tutorialStatus.useQuery();
  const completarTutorial = trpc.usuario.completarTutorial.useMutation({
    onSuccess: () => {
      // Invalidate the status query so `completado: true` reaches the
      // PainelPage on the next mount (refresh, navigation back, etc).
      // This isn't what gates the current-session loop — `dismissedThisSession`
      // does — but it keeps the cached state honest for the re-trigger path.
      tutorialStatus.refetch();
    },
  });

  const [overlayOpen, setOverlayOpen] = useState(false);
  // aperture-4my2a — session-scoped dismissal latch. Auto-open useEffect
  // honours this regardless of what the wire says. Re-trigger via the
  // floating CTA / topbar chip resets it.
  const [dismissedThisSession, setDismissedThisSession] = useState(false);

  // Auto-open on first paint for users who haven't completed the tutorial.
  // Also handles the `?tutorial=open` deep-link from sub-pages (TUTORIAL chip
  // clicks on a sub-page navigate to the root with this query so the root can
  // pop the overlay on land).
  //
  // Dismissal latch: once the user has dismissed in this session, the effect
  // refuses to re-open even if the query re-settles. Without this, every
  // refetch / cache mutation would slam the overlay back over the user.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (dismissedThisSession) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('tutorial') === 'open') {
      setOverlayOpen(true);
      return;
    }
    if (tutorialStatus.data && !tutorialStatus.data.completado) {
      setOverlayOpen(true);
    }
  }, [tutorialStatus.data, dismissedThisSession]);

  // CONCLUIR (step 9 PRÓXIMO → CONCLUIR variant) — auto-fires the mutation
  // AND latches the dismissal so the user lands on the painel clean.
  const handleComplete = () => {
    completarTutorial.mutate();
    setDismissedThisSession(true);
    setOverlayOpen(false);
  };

  // ENCERRAR (or Esc) — same persistence + latch. Plan 0018 §"Dismissal
  // path": ENCERRAR ≡ CONCLUIR for state. Both fire the mutation; the
  // user has been shown the entry-point and that's what the flag tracks.
  const handleDismiss = () => {
    completarTutorial.mutate();
    setDismissedThisSession(true);
    setOverlayOpen(false);
  };

  // Re-trigger path (floating CTA). Resets the session latch so the
  // auto-open useEffect can fire again on next visit if the user dismisses
  // without completing the tour.
  const openOverlay = () => {
    setDismissedThisSession(false);
    setOverlayOpen(true);
  };

  return (
    <PainelLayout slug={slug} babyName={babyName} eventDate={eventDate}>
      <PainelHeaderCard snapshot={snapshot} slug={slug} />
      <PainelMenu groups={groups} slug={slug} />
      <PainelTutorialTrigger
        visible={!overlayOpen}
        onOpen={openOverlay}
      />
      <PainelTutorialOverlay
        open={overlayOpen}
        onComplete={handleComplete}
        onDismiss={handleDismiss}
      />
    </PainelLayout>
  );
}
