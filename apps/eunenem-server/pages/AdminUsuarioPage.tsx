import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { trpc } from "@/lib/trpc.js";

/**
 * /admin/usuario/:idConta — user detail page (aperture-rsidz.2, W1).
 *
 * Fetches the usuario via `trpc.admin.findUsuarioByConta` (cascades
 * through findContaById → findUsuarioById server-side; the client just
 * sees the projected `{ idConta, email, nomeExibicao }` shape).
 *
 * Layout: AdminShell with `activeBc="usuario"`, breadcrumb back to
 * /admin, BC strap context shows the conta id. Body section is the
 * usuario header (badge + name H1 + email mono) + a fact grid + a
 * future-wave placeholder for the Campanhas drill (W2).
 *
 * Structure is deliberately section-per-BC so downstream waves are
 * pure appends — no restructuring at W2/W3/W4 time. See the comments
 * on the campanhas placeholder.
 *
 * SSR-time status: the server.tsx catch-all leaves status=200 because
 * the URL is structurally valid; we render the React tree, which
 * shows a "loading" → "not found" / "loaded" state via the tRPC hook.
 * For unknown idConta the page renders a clear 404-style message —
 * the HTTP status stays 200 (it's a valid route, just an empty
 * lookup). This matches the painel pattern's tolerance of in-tree
 * not-found state for client-fetched data.
 */

export function AdminUsuarioPage({ idConta }: { idConta: string }) {
  const { data, isLoading, error } =
    trpc.admin.findUsuarioByConta.useQuery({ idConta });

  const shortId = `${idConta.slice(0, 8)}…`;

  return (
    <AdminShell
      activeBc="usuario"
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "usuario" },
        { label: shortId },
      ]}
      bcContext={
        <>
          conta <span className="text-ink">{shortId}</span>
        </>
      }
    >
      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message} />}
      {!isLoading && !error && data === null && (
        <NotFoundState idConta={idConta} />
      )}
      {!isLoading && !error && data && (
        <section className="space-y-10">
          <UsuarioHeader usuario={data} />
          <FactsGrid usuario={data} idConta={idConta} />
          <CampanhasPlaceholder />
          <RawRecord usuario={data} idConta={idConta} />
        </section>
      )}
    </AdminShell>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <DddBadge bc="usuario" size="sm" />
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

function NotFoundState({ idConta }: { idConta: string }) {
  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        usuário não encontrado
      </p>
      <h1 className="text-3xl font-semibold tracking-tight text-ink">
        Nenhum usuário com essa conta
      </h1>
      <p className="max-w-2xl text-[15px] leading-relaxed text-ink-soft">
        A conta{" "}
        <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[12px]">
          {idConta}
        </code>{" "}
        não corresponde a nenhum usuário desta plataforma. Volte para{" "}
        <a href="/admin" className="text-plum underline">
          /admin
        </a>{" "}
        e busque outro.
      </p>
    </div>
  );
}

function UsuarioHeader({
  usuario,
}: {
  usuario: { email: string; nomeExibicao: string };
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <DddBadge bc="usuario" size="sm" />
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
          drill · usuário
        </p>
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-ink">
        {usuario.nomeExibicao}
      </h1>
      <p className="font-mono text-[13px] text-ink-soft">{usuario.email}</p>
    </div>
  );
}

function FactsGrid({
  usuario,
  idConta,
}: {
  usuario: { email: string; nomeExibicao: string };
  idConta: string;
}) {
  const facts: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "nome",
      value: <span className="text-[13px] text-ink">{usuario.nomeExibicao}</span>,
    },
    {
      label: "email",
      value: (
        <span className="font-mono text-[13px] text-ink">{usuario.email}</span>
      ),
    },
    {
      label: "id da conta",
      value: (
        <code className="block break-all rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink">
          {idConta}
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

function CampanhasPlaceholder() {
  /*
   * Section-per-BC scaffold (Wheatley directive, banked 2026-06-01).
   * Future waves append IN PLACE — no restructure. When W2 (rsidz.3)
   * lands, it fills this section with `<CampanhasTabs>` and a real
   * Arrecadação fetch. The DddBadge marks the BC boundary so the
   * operator's wayfinding stays consistent.
   */
  return (
    <div
      data-bc="arrecadacao"
      className="rounded-md border border-line bg-cream-2/30 p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-3">
          <DddBadge bc="arrecadacao" size="sm" />
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
            campanhas
          </h2>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          W2 (rsidz.3) — coming soon
        </span>
      </div>
      <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-ink-soft">
        Two tabs will live here: <span className="text-ink">administra</span>{" "}
        (campanhas owned by this usuário) and{" "}
        <span className="text-ink">contribuiu</span> (campanhas this usuário
        contributed to). Both lists hit the Arrecadação BC.
      </p>
    </div>
  );
}

function RawRecord({
  usuario,
  idConta,
}: {
  usuario: { email: string; nomeExibicao: string };
  idConta: string;
}) {
  const record = {
    idConta,
    email: usuario.email,
    nomeExibicao: usuario.nomeExibicao,
  };
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
