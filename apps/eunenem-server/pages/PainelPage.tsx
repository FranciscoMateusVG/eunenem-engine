import { PainelHeaderCard } from '@/components/eunenem/painel/PainelHeaderCard';
import { PainelLayout } from '@/components/eunenem/painel/PainelLayout';
import { PainelMenu } from '@/components/eunenem/painel/PainelMenu';
import { useStubCampanhaIdForSlug, useStubExtratoSummary } from '@/components/eunenem/painel/ExtratoStubData';
import { useContribuicaoList } from '@/lib/contribuicao';
import { buildPainelMenu, PAINEL_DEMO, type PainelEventSnapshot } from '@/lib/mocks/painelDemo';

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

  return (
    <PainelLayout slug={slug}>
      <PainelHeaderCard snapshot={snapshot} slug={slug} />
      <PainelMenu groups={groups} slug={slug} />
    </PainelLayout>
  );
}
