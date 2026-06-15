import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { CampanhaPagamentosList } from "@/components/eunenem/admin/CampanhaPagamentosList";
import { ContribuicoesList } from "@/components/eunenem/admin/ContribuicoesList";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { trpc } from "@/lib/trpc.js";
import { useState } from "react";

/**
 * /admin/campanha/:idCampanha — campanha detail page (aperture-rsidz.3, W2,
 * reshaped Plan 0017 / aperture-gf2t5).
 *
 * PAGAMENTO-FIRST RESHAPE (gf2t5):
 *   The page used to lead with the Contribuições list (slot catalog), which
 *   inverted the new domain ontology: post-Plan-0016 a Contribuição is a
 *   slot DEFINITION (admin-owned catalog), and a Pagamento is the
 *   transaction aggregate root. Operator's pain: clicking a contribuição
 *   row drilled into ONE slot's pagamentos (typically one), losing the
 *   aggregate "5 of 6 sold to different people" context. Reshape:
 *
 *     1. PAGAMENTOS — primary section. Lists every pagamento against this
 *        campanha (across all contribuições), with status + total +
 *        contribuinte + criado em + item count. Click → /admin/pagamento/:id.
 *
 *     2. CATÁLOGO (Contribuições) — secondary section, framed as the slot
 *        catalog. Still reachable via the same grouped-card affordance —
 *        clicking a row drills into /admin/contribuicao/:id (which itself
 *        is reframed to surface aggregate item-rows across pagamentos, see
 *        AdminContribuicaoPage).
 *
 *   The BC shifts: previously `activeBc="arrecadacao"` (emerald — Catálogo's
 *   identity), now `activeBc={null}` because the page touches BOTH
 *   Pagamentos (amber) AND Arrecadação (emerald) — let the per-section
 *   DddBadges carry the BC identity instead.
 *
 * SSR-time status unchanged: 200 for structurally-valid URLs; the page
 * body renders loading → not-found / loaded off the tRPC hook.
 */
export function AdminCampanhaPage({ idCampanha }: { idCampanha: string }) {
  const { data, isLoading, error } = trpc.admin.campanhas.findById.useQuery({
    idCampanha,
  });

  const shortId = `${idCampanha.slice(0, 8)}…`;

  return (
    <AdminShell
      activeBc={null}
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "campanha" },
        { label: shortId },
      ]}
      bcContext={
        <>
          campanha <span className="text-ink">{shortId}</span>
        </>
      }
    >
      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message} />}
      {!isLoading && !error && data === null && (
        <NotFoundState idCampanha={idCampanha} />
      )}
      {!isLoading && !error && data && (
        <section className="space-y-10">
          <CampanhaHeader campanha={data} />
          <FactsGrid campanha={data} idCampanha={idCampanha} />
          {/* PRIMARY — Pagamentos. The transaction aggregate root, where the
              "who paid me what?" question lives. New under Plan 0017. */}
          <PagamentosSection idCampanha={idCampanha} />
          {/* SECONDARY — Catálogo (contribuições as slot definitions).
              Collapsed by default; still expandable for slot management. */}
          <CatalogoSection idCampanha={idCampanha} />
          <RawRecord campanha={data} idCampanha={idCampanha} />
        </section>
      )}
    </AdminShell>
  );
}

type CampanhaDetail = {
  id: string;
  titulo: string;
  status: "com-recebedor" | "sem-recebedor";
  criadaEm: string;
  recebedor: { nome: string } | null;
  idPlataforma: string;
  qtdOpcoes: number;
};

function LoadingState() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <DddBadge bc="arrecadacao" size="sm" />
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
          carregando…
        </p>
      </div>
      <div className="h-7 w-72 animate-pulse rounded bg-cream-2" />
      <div className="h-5 w-56 animate-pulse rounded bg-cream-2" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em]">
        erro
      </p>
      <p className="mt-1">{message}</p>
    </div>
  );
}

function NotFoundState({ idCampanha }: { idCampanha: string }) {
  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        campanha não encontrada
      </p>
      <h1 className="text-3xl font-semibold tracking-tight text-ink">
        Nenhuma campanha com esse id
      </h1>
      <p className="max-w-2xl text-[15px] leading-relaxed text-ink-soft">
        A campanha{" "}
        <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[12px]">
          {idCampanha}
        </code>{" "}
        não foi encontrada ou pertence a outra plataforma. Volte para{" "}
        <a href="/admin" className="text-plum underline">
          /admin
        </a>{" "}
        e busque um usuário.
      </p>
    </div>
  );
}

function CampanhaHeader({ campanha }: { campanha: CampanhaDetail }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <DddBadge bc="arrecadacao" size="sm" />
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
          drill · campanha
        </p>
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-ink">
        {campanha.titulo}
      </h1>
      <p className="font-mono text-[12px] text-ink-soft">
        {campanha.recebedor ? (
          <>recebedor · {campanha.recebedor.nome}</>
        ) : (
          <span className="italic">(sem recebedor)</span>
        )}
      </p>
    </div>
  );
}

function FactsGrid({
  campanha,
  idCampanha,
}: {
  campanha: CampanhaDetail;
  idCampanha: string;
}) {
  const criada = formatCriadaEm(campanha.criadaEm);
  const facts: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "título",
      value: <span className="text-[13px] text-ink">{campanha.titulo}</span>,
    },
    {
      label: "status",
      value: (
        <span className="font-mono text-[12px] text-ink">
          {campanha.status === "com-recebedor"
            ? "com recebedor"
            : "sem recebedor"}
        </span>
      ),
    },
    {
      label: "opções",
      value: (
        <span className="font-mono text-[12px] tabular-nums text-ink">
          {campanha.qtdOpcoes}
        </span>
      ),
    },
    {
      label: "criada em",
      value: (
        <span className="font-mono text-[12px] tabular-nums text-ink">
          {criada}
        </span>
      ),
    },
    {
      label: "id da campanha",
      value: (
        <code className="block break-all rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink">
          {idCampanha}
        </code>
      ),
    },
  ];
  return (
    <dl className="grid gap-x-6 gap-y-3 rounded-md border border-line bg-paper p-5 sm:grid-cols-[max-content_1fr]">
      {facts.map(({ label, value }) => (
        <div
          key={label}
          className="contents [&>dt]:font-mono [&>dt]:text-[11px] [&>dt]:uppercase [&>dt]:tracking-[0.12em] [&>dt]:text-ink-mute"
        >
          <dt className="pt-1">{label}</dt>
          <dd className="pb-2 sm:pb-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * PRIMARY section under the Plan 0017 reshape (aperture-gf2t5). Lists every
 * pagamento against this campanha — the "who paid me what" view that
 * answers the operator's day-to-day question without having to drill into
 * individual contribuição slots. Click a row → /admin/pagamento/:id.
 *
 * Delegates rendering + filtering + sort to <CampanhaPagamentosList />.
 */
function PagamentosSection({ idCampanha }: { idCampanha: string }) {
  return (
    <section data-bc="pagamentos" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-3">
          <DddBadge bc="pagamentos" size="sm" />
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
            pagamentos
          </h2>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          transações · ordem cronológica
        </span>
      </div>
      <CampanhaPagamentosList idCampanha={idCampanha} />
    </section>
  );
}

/**
 * SECONDARY section under the Plan 0017 reshape (aperture-gf2t5). Surfaces
 * the catálogo (contribuições as slot definitions) — what's on the menu,
 * not what sold. Collapsed by default; operator can open to manage the
 * slot list. Rows still drill to /admin/contribuicao/:id (which under the
 * reshape becomes the slot-definition view with aggregate item stats).
 */
function CatalogoSection({ idCampanha }: { idCampanha: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section data-bc="arrecadacao" className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-line bg-paper px-4 py-3 text-left hover:bg-cream-2/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-plum"
        aria-expanded={open}
        aria-controls="catalogo-content"
      >
        <div className="flex items-center gap-3">
          <DddBadge bc="arrecadacao" size="sm" />
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
            catálogo
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
            slots da campanha
          </span>
        </div>
        <span
          aria-hidden
          className="font-mono text-[11px] text-ink-mute transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▸
        </span>
      </button>
      {open && (
        <div id="catalogo-content" className="pt-2">
          <ContribuicoesList idCampanha={idCampanha} />
        </div>
      )}
    </section>
  );
}

function RawRecord({
  campanha,
  idCampanha,
}: {
  campanha: CampanhaDetail;
  idCampanha: string;
}) {
  const record = { idCampanha, ...campanha };
  return (
    <details className="rounded-md border border-line bg-paper">
      <summary className="cursor-pointer select-none px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft hover:text-plum">
        raw record
      </summary>
      <pre className="overflow-x-auto border-t border-line bg-cream-2/40 px-4 py-3 font-mono text-[12px] text-ink">
        {JSON.stringify(record, null, 2)}
      </pre>
    </details>
  );
}

function formatCriadaEm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
