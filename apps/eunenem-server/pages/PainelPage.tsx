import { useEffect, useState } from 'react';

import { PainelHeaderCard } from '@/components/eunenem/painel/PainelHeaderCard';
import { PainelLayout } from '@/components/eunenem/painel/PainelLayout';
import { useCampanhasList } from '@/lib/campanhas';
import { PainelMenu } from '@/components/eunenem/painel/PainelMenu';
import { PainelTutorialOverlay } from '@/components/eunenem/painel/PainelTutorialOverlay';
import { PainelTutorialTrigger } from '@/components/eunenem/painel/PainelTutorialTrigger';
import { useStubCampanhaIdForSlug, useStubExtratoSummary } from '@/components/eunenem/painel/ExtratoStubData';
import { OnboardingWizard } from '@/components/eunenem/auth/OnboardingWizard';
import { useContribuicaoList } from '@/lib/contribuicao';
import { buildPainelMenu, PAINEL_DEMO, type PainelEventSnapshot } from '@/lib/mocks/painelDemo';
import { needsOnboarding } from '@/lib/onboarding-gate';
import { trpc } from '@/lib/trpc';
import { sendPageView } from '@/lib/analytics';

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
export function PainelPage({
  slug,
  idCampanha: idCampanhaRota,
}: {
  slug: string;
  /** aperture-h0hom — specific campanha (from /painel/:slug/c/:id); undefined = oldest. */
  idCampanha?: string;
}) {
  // Real data sources. Each falls back to the PAINEL_DEMO snapshot when
  // the user isn't logged in, has no campanha yet, or the query is
  // still loading — the painel always renders SOMETHING.
  // aperture-h0hom — the ROUTE's campanha (from /c/:idCampanha) outranks the
  // slug-derived default: inside a specific campanha's painel, the data hops
  // below must read THAT campanha, not the oldest.
  const { idCampanha: idCampanhaPadrao } = useStubCampanhaIdForSlug(slug);
  const idCampanha = idCampanhaRota ?? idCampanhaPadrao;

  // aperture-snfin — the painel identity chip must name the DISPLAYED
  // campanha (clicked /c/:id, or the default/oldest on bare). campanhas.list
  // (mebax, deployed) carries every {id, titulo} the user owns — resolve the
  // displayed id against it. null = still resolving (placeholder chip, never
  // the wrong campanha's name); undefined = list unavailable (chip hidden).
  const campanhasQ = useCampanhasList();
  const campanhaTitulo = campanhasQ.data
    ? (campanhasQ.data.novas.find((c) => c.id === idCampanha)?.titulo ?? null)
    : campanhasQ.isLoading
      ? null
      : undefined;
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
  // aperture-ujvkp — this ACCOUNT-level query now feeds ONLY the greeting:
  // creatorName is per-conta (same on every campanha) so it's correct here.
  // The BABY-half (nomeBebe/genero/dataEvento) must NOT come from it — during
  // the transitional shim it resolves the OLDEST campanha's perfil, which put
  // "página do Teste" on Ameno's painel (operator's clean-slate walk).
  const perfilQ = trpc.perfil.getPerfil.useQuery(undefined, { staleTime: 30_000 });
  const greetingFirstName =
    (perfilQ.data?.creatorName ?? "").trim().split(/\s+/)[0] ?? "";

  // aperture-ujvkp — the DISPLAYED campanha's own perfil for the header's
  // baby-half. Owner-gated, REQUIRED uuid input → enabled-gate on shape
  // (idCampanhaPadrao can briefly be null/non-uuid while auth.me resolves).
  const idCampanhaValida =
    idCampanha && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idCampanha)
      ? idCampanha
      : null;
  const perfilCampanhaQ = trpc.perfilCampanha.get.useQuery(
    { idCampanha: idCampanhaValida ?? "" },
    { enabled: Boolean(idCampanhaValida), staleTime: 30_000 },
  );

  // aperture-8ysqu — onboarding gate. A freshly-provisioned account that never
  // ran the in-modal email wizard (every OAuth signup — Google now, Microsoft
  // y5ual next — plus any direct navigation to the painel) reaches here with an
  // empty profile. The backend flags it via auth.me.needsOnboarding; when set we
  // mount the SAME OnboardingWizard the email flow uses, as a blocking gate,
  // before the dashboard. This single painel-side gate is PROVIDER-AGNOSTIC —
  // combined with the #304 OAuth-return redirect (which lands every OAuth user
  // on /painel/<slug>), no per-callback patching is needed.
  const meQ = trpc.auth.me.useQuery(undefined, { staleTime: 0 });
  const mustOnboard = needsOnboarding(meQ.data);

  // aperture-3ic62 — the REAL baby name for the "página da <X>" header.
  // null (unset or still loading) → PainelLayout falls back to the neutral
  // "bebê", never the slug.
  // aperture-ujvkp — sourced from the DISPLAYED campanha's perfilCampanha,
  // NOT the account-level getPerfil (which resolves the oldest campanha):
  // /painel/:slug/c/<Ameno> must read Ameno's Dorimenos, never "Teste".
  const babyName = perfilCampanhaQ.data?.nomeBebe ?? null;
  // aperture-neiwx — gender article from the SAME per-campanha source, so
  // owner + guest never disagree on do/da/de.
  const genero = perfilCampanhaQ.data?.genero ?? null;

  // aperture-84a21 — the REAL event date for the painel countdown + date chip.
  // null (unset / fresh account / still loading) → PainelHeaderCard shows NO
  // date. Same per-campanha source (aperture-ujvkp).
  const eventDate = perfilCampanhaQ.data?.dataEvento
    ? String(perfilCampanhaQ.data.dataEvento).slice(0, 10)
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

  // aperture-q4r0f — gate the painel render on getPerfil so the TweaksProvider
  // (seeded ONCE at mount inside PainelLayout via its useState initializer)
  // receives the REAL nomeBebe + dataEvento as initial state. getPerfil is NOT
  // SSR-hydrated for the painel → at first mount perfilQ.data is undefined;
  // mounting PainelLayout then would seed the neutral "bebê"/"" tweaks that
  // never re-sync when getPerfil later resolves (the seed-once initializer is
  // the root cause). Holding a brief spinner until getPerfil settles makes the
  // seed correct on the FIRST PainelLayout mount → header reads the real
  // "página da <nomeBebe>" + real dataEvento countdown, neutral only when unset.
  //
  // CRITICAL: this branch must NOT render <PainelLayout> — it returns a DISTINCT
  // element so that when isLoading flips false React mounts a FRESH PainelLayout
  // (new TweaksProvider) seeded with the real values, instead of reconciling an
  // already-mounted-with-neutral-seed provider in place (which would re-trigger
  // the very bug). isLoading flips false on success OR error, so this never
  // hangs (a logged-out / errored getPerfil falls through to the loaded branch
  // with the honest neutral seed — still no mock date).
  // Hold the spinner until BOTH getPerfil and auth.me settle, so we never flash
  // the dashboard before deciding the onboarding gate below (and the
  // TweaksProvider seed-once invariant above is preserved — this branch still
  // returns a DISTINCT element, so a FRESH PainelLayout mounts when loading ends).
  // aperture-ujvkp — the per-campanha perfil (babyName/genero/eventDate source)
  // must ALSO settle before the seed-once mount: on bare URLs it only starts
  // fetching after auth.me resolves the default id, so without this clause the
  // layout would mount mid-fetch and seed the neutral "bebê" forever.
  if (
    perfilQ.isLoading ||
    meQ.isLoading ||
    (idCampanhaValida !== null && perfilCampanhaQ.isLoading)
  ) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '60vh',
        }}
        role="status"
        aria-live="polite"
        aria-label="carregando sua página"
      >
        <span className="perfil-spinner" aria-hidden="true" />
      </div>
    );
  }

  // aperture-8ysqu — block the dashboard behind the onboarding wizard for an
  // account the server flags as needing onboarding. onDone reloads to
  // /painel/<finalSlug> (mirrors the email flow's AuthModalProvider.onDone): the
  // full reload re-reads auth.me with needsOnboarding now false and renders the
  // real dashboard. The wizard persists the profile via its own
  // perfil.atualizar + usuario.atualizarSlug mutations.
  if (mustOnboard) {
    return (
      <OnboardingWizard
        onDone={(finalSlug) => {
          if (typeof window !== 'undefined') {
            window.location.assign(`/painel/${finalSlug}`);
          }
        }}
      />
    );
  }

  return (
    <PainelLayout
      slug={slug}
      idCampanha={idCampanhaRota}
      babyName={babyName}
      eventDate={eventDate}
      genero={genero}
    >
      <PainelPageView slug={slug} />
      <PainelHeaderCard snapshot={snapshot} slug={slug} campanhaTitulo={campanhaTitulo} />
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

// Renders nothing — fires the custom pageview exactly once per mount of the
// real dashboard (never during the loading/onboarding gates above, which
// return early before this component exists).
function PainelPageView({ slug }: { slug: string }) {
  useEffect(() => {
    sendPageView('Painel', { slug });
  }, [slug]);
  return null;
}
