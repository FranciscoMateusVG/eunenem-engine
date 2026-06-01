import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadgeLegend } from "@/components/eunenem/admin/DddBadge";
import { UserPicker } from "@/components/eunenem/admin/UserPicker";
import { ADMIN_PLATAFORMA_ID } from "@/lib/adminTenant";

// /admin — operator's DDD-trace drill-down landing (aperture-rsidz.1).
//
// W0 of the rsidz epic: the bare shell. The user-search and the per-BC
// drills land in subsequent waves (rsidz.2 → rsidz.6). This page renders
// the engineering view's frame, a legend of the four bounded contexts
// the drills will surface, and a brief operator hint.
//
// v1 ships with NO auth gate (operator directive). The shell carries a
// visible "no auth" chip in the sidebar so the operator never wonders
// whether someone is logged in.
//
// Tenant scope is hardcoded to ID_PLATAFORMA_EUNENEM (single-tenant for
// v1; multi-tenancy deferred). The constant is re-exported from the
// engine package so the admin and the rest of the eunenem-server share
// one source of truth.
export function AdminPage() {
  const shortPlataforma = ADMIN_PLATAFORMA_ID.slice(0, 8);

  return (
    <AdminShell
      activeBc={null}
      activeNav="landing"
      breadcrumb={[{ label: "admin" }]}
      bcContext={
        <>
          plataforma{" "}
          <span className="text-ink">{shortPlataforma}…</span>
        </>
      }
    >
      <section className="space-y-12">
        <Header />
        <UserSearch />
        <Legend />
        <ComingSoon />
      </section>
    </AdminShell>
  );
}

function Header() {
  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        admin · landing
      </p>
      <h1 className="text-3xl font-semibold tracking-tight text-ink">
        DDD-trace drill-down
      </h1>
      <p className="max-w-2xl text-[15px] leading-relaxed text-ink-soft">
        Start from a user. Trace forward through the bounded contexts
        they touch — campanhas they administer, contribuições they made,
        pagamentos on their behalf, lançamentos financeiros that
        resulted. Every page carries the active BC badge so the model
        boundary stays visible.
      </p>
    </div>
  );
}

function UserSearch() {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          buscar usuário
        </label>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          email prefix · até 20 resultados
        </span>
      </div>
      <UserPicker />
      <p className="font-mono text-[10px] tracking-[0.04em] text-ink-mute">
        Selecting a result navigates to{" "}
        <code>/admin/usuario/[idConta]</code>.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <div className="space-y-3 rounded-md border border-line bg-cream-2/40 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          bounded contexts
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          reading order
        </span>
      </div>
      <DddBadgeLegend />
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Drill pages downstream of the user pick their own BC; the badge
        appears at the top of every page so you always know which model
        you&apos;re looking at.
      </p>
    </div>
  );
}

function ComingSoon() {
  return (
    <div className="rounded-md border border-dashed border-line bg-paper p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          próximas ondas
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          rsidz children
        </span>
      </div>
      <ul className="mt-3 grid gap-2 text-[13px] leading-relaxed text-ink-soft sm:grid-cols-2">
        <li className="flex items-start gap-2">
          <Step n={1} /> User picker — prefix autocomplete on email
        </li>
        <li className="flex items-start gap-2">
          <Step n={2} /> Campanhas — administra + contribuiu tabs
        </li>
        <li className="flex items-start gap-2">
          <Step n={3} /> Contribuições — filtros por status / data / opção
        </li>
        <li className="flex items-start gap-2">
          <Step n={4} /> Pagamentos + lançamentos — Triple-BC walkthrough
        </li>
      </ul>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-line bg-cream-2 font-mono text-[10px] font-semibold tabular-nums text-ink"
    >
      {n}
    </span>
  );
}
