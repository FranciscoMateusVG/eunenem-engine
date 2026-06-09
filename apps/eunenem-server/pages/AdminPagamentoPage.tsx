import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import {
  PagamentoCard,
  type PagamentoDTO,
} from "@/components/eunenem/admin/PagamentosList";
import { trpc } from "@/lib/trpc.js";

/**
 * /admin/pagamento/:idPagamento — single-pagamento detail page
 * (Plan 0017 / aperture-gf2t5 admin reshape).
 *
 * Lifted out of the /admin/contribuicao detail's Pagamentos card so the
 * pagamento becomes the transaction aggregate root the operator can drill
 * into directly. Reads `admin.pagamentos.findById` (new in this bead) and
 * renders the same PagamentoCard component the list contexts use — single
 * source of truth for the visual identity of a pagamento.
 *
 * Layout:
 *   - AdminShell with `activeBc="pagamentos"` (amber) — the BC strap signals
 *     we're inside the Pagamentos bounded context, not the Arrecadação one
 *     the campanha/contribuicao pages use.
 *   - Breadcrumb: [admin, pagamento, shortId]
 *   - PagamentoCard (lifted from PagamentosList) — header, items, composição,
 *     financeiro, raw JSON drawer, webhook trail.
 *
 * Errors:
 *   - 404 `pagamento_nao_encontrado` → NotFoundState
 *   - 403 `tenant_mismatch` → ErrorState (operator-readable)
 *   - 500 / anything else → ErrorState
 *
 * SSR-time status: the server.tsx catch-all leaves status=200 because the
 * URL is structurally valid; the loading/error states render off the tRPC
 * hook. Matches the /admin/campanha pattern (W2 ship).
 */
export function AdminPagamentoPage({ idPagamento }: { idPagamento: string }) {
  const { data, isLoading, error } = trpc.admin.pagamentos.findById.useQuery({
    idPagamento,
  });

  const shortId = `${idPagamento.slice(0, 8)}…`;

  return (
    <AdminShell
      activeBc="pagamentos"
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "pagamento" },
        { label: shortId },
      ]}
      bcContext={
        <>
          pagamento <span className="text-ink">{shortId}</span>
        </>
      }
    >
      {isLoading && <LoadingState />}
      {error && error.data?.code === "NOT_FOUND" && (
        <NotFoundState idPagamento={idPagamento} />
      )}
      {error && error.data?.code !== "NOT_FOUND" && (
        <ErrorState message={error.message} />
      )}
      {!isLoading && !error && data && (
        <section className="space-y-6">
          <PageHeader idPagamento={idPagamento} />
          {/* Render the exact same PagamentoCard the list context uses —
              the wire shape is identical so no projection happens here. */}
          <PagamentoCard
            pagamento={data.pagamento as unknown as PagamentoDTO}
          />
        </section>
      )}
    </AdminShell>
  );
}

function PageHeader({ idPagamento }: { idPagamento: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <DddBadge bc="pagamentos" size="sm" />
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
          drill · pagamento
        </p>
      </div>
      <p className="font-mono text-[12px] text-ink-soft">
        id ·{" "}
        <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink">
          {idPagamento}
        </code>
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <DddBadge bc="pagamentos" size="sm" />
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
      <p className="font-mono text-[10px] uppercase tracking-[0.18em]">erro</p>
      <p className="mt-1">{message}</p>
    </div>
  );
}

function NotFoundState({ idPagamento }: { idPagamento: string }) {
  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        pagamento não encontrado
      </p>
      <h1 className="text-3xl font-semibold tracking-tight text-ink">
        Nenhum pagamento com esse id
      </h1>
      <p className="max-w-2xl text-[15px] leading-relaxed text-ink-soft">
        O pagamento{" "}
        <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[12px]">
          {idPagamento}
        </code>{" "}
        não foi encontrado ou pertence a outra plataforma. Volte para{" "}
        <a href="/admin" className="text-plum underline">
          /admin
        </a>{" "}
        e busque um usuário ou campanha.
      </p>
    </div>
  );
}
