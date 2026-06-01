import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { ContribuicoesList } from "@/components/eunenem/admin/ContribuicoesList";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { trpc } from "@/lib/trpc.js";

/**
 * /admin/campanha/:idCampanha — campanha detail page (aperture-rsidz.3, W2).
 *
 * Reached from the CampanhasTabs rows on /admin/usuario/:idConta. Layout
 * follows the W1 pattern: AdminShell with `activeBc="arrecadacao"`,
 * breadcrumb back to /admin, BC strap context shows the campanha id.
 * Body is the campanha header (badge + titulo H1 + meta row) + a facts
 * grid + a placeholder contribuicoes drill section. W2 owns the seam +
 * embed point; W3 (aperture-rsidz.4) file-swaps the placeholder body
 * with the real ContribuicoesList without touching this page.
 *
 * SSR-time status: the server.tsx catch-all leaves status=200 because
 * the URL is structurally valid; React renders loading → not-found /
 * loaded states off the tRPC hook. Unknown idCampanha → tenant-guarded
 * null → 404-styled body, HTTP stays 200 (matches the /admin/usuario
 * pattern).
 */
export function AdminCampanhaPage({ idCampanha }: { idCampanha: string }) {
  const { data, isLoading, error } = trpc.admin.campanhas.findById.useQuery({
    idCampanha,
  });

  const shortId = `${idCampanha.slice(0, 8)}…`;

  return (
    <AdminShell
      activeBc="arrecadacao"
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
          <ContribuicoesSection idCampanha={idCampanha} />
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
 * Contribuições drill embedded in the campanha detail page (aperture-rsidz.4,
 * W3). W2 shipped the seam (the section shell + data-bc wrapper + heading);
 * W3 fills the body with the real ContribuicoesList — a filterable list of
 * every contribuicao for this campanha, with status/opção/período chips,
 * a counter, and a clear-link. Rows navigate to
 * /admin/contribuicao/:idContribuicao (the W3 detail route).
 *
 * The data-bc="arrecadacao" wrapper + the heading are preserved verbatim
 * from W2 — the embed contract held across the W2 → W3 boundary exactly as
 * designed.
 */
function ContribuicoesSection({ idCampanha }: { idCampanha: string }) {
  return (
    <section data-bc="arrecadacao" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          contribuições
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          arrecadação · drill
        </span>
      </div>
      <ContribuicoesList idCampanha={idCampanha} />
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
