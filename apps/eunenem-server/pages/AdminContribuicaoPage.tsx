import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { ItensDoSlotList } from "@/components/eunenem/admin/ItensDoSlotList";
import ArrecadacaoSection from "@/components/eunenem/admin/sections/ArrecadacaoSection";

/**
 * /admin/contribuicao/:idContribuicao — contribuição detail page.
 *
 * Reframed under Plan 0017 / aperture-gf2t5 as a SLOT-DEFINITION view.
 * The old shape (slot facts + every pagamento attempt rendered as a full
 * PagamentoCard) inverted the new domain ontology: under Plan 0016,
 * Contribuição is a slot DEFINITION and Pagamento is the transaction
 * aggregate root. A contribuição page that surfaces N inline PagamentoCards
 * obscures the aggregate "5 of 6 sold to different people" story.
 *
 * NEW SHAPE:
 *   - ArrecadacaoSection (unchanged) — emerald BC header, slot facts +
 *     N/M-or-ESGOTADA badge + campanha/recebedor block.
 *   - ItensDoSlotList — NEW. Every ItemDoPagamento across every pagamento
 *     that bought into this slot. Compact rows (status + contribuinte +
 *     quantidade + line total + criadoEm); clicks navigate to
 *     /admin/pagamento/:id rather than nesting the full card here.
 *
 * The "every pagamento as a full card" view moves to /admin/pagamento/:id
 * — operators reach a specific pagamento via the campanha-level Pagamentos
 * list (the primary view under the reshape).
 *
 * BC handling unchanged: `activeBc={null}` because the page bridges two
 * BCs (Arrecadação for the slot facts, Pagamentos for the item rows); the
 * per-section DddBadges carry identity.
 */
export function AdminContribuicaoPage({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  const shortId = `${idContribuicao.slice(0, 8)}…`;
  return (
    <AdminShell
      activeBc={null}
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "contribuição" },
        { label: shortId },
      ]}
      bcContext={
        <>
          contribuição <span className="text-ink">{shortId}</span>
        </>
      }
    >
      <section className="space-y-10">
        <ArrecadacaoSection idContribuicao={idContribuicao} />
        <ItensDoSlotList idContribuicao={idContribuicao} />
      </section>
    </AdminShell>
  );
}
