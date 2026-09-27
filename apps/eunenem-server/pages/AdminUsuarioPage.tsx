import { useId, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { CampanhasAdministradasTable } from "@/components/eunenem/admin/CampanhasAdministradasTable";
import { CampanhasTabs } from "@/components/eunenem/admin/CampanhasTabs";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import type { BucketAdmin } from "@/components/eunenem/admin/financeiro-labels";
import { LancamentosAdminTable } from "@/components/eunenem/admin/LancamentosAdminTable";
import { ResumoFinanceiroCard } from "@/components/eunenem/admin/ResumoFinanceiroCard";
import { TransferenciasAdminTable } from "@/components/eunenem/admin/TransferenciasAdminTable";
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
          <FinanceiroSection idConta={idConta} />
          <CampanhasSection idConta={idConta} email={data.email} />
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

/**
 * FinanceiroSection (aperture-5jk8y) — leitura pura do detalhe financeiro das
 * campanhas ADMINISTRADAS por esta conta. Três consultas independentes com
 * seus próprios estados de loading/erro/vazio; nenhuma delas bloqueia o resto
 * da página. Paginação por cursor com pilha (anterior/próxima), como em
 * AdminPagamentosPage. Sem botões de ação financeira.
 */
function FinanceiroSection({ idConta }: { idConta: string }) {
  const filterIdPrefix = useId();
  const summary = trpc.admin.usuarios.financeiro.summary.useQuery({ idConta });

  const [estado, setEstado] = useState<BucketAdmin | null>(null);
  const [idCampanha, setIdCampanha] = useState<string | null>(null);
  const [lancCursor, setLancCursor] = useState<string | null>(null);
  const [lancStack, setLancStack] = useState<Array<string | null>>([]);
  const lancamentos = trpc.admin.usuarios.financeiro.lancamentos.listPaginated.useQuery({
    idConta,
    cursor: lancCursor,
    limit: 25,
    estado,
    idCampanha,
  });

  const [repCursor, setRepCursor] = useState<string | null>(null);
  const [repStack, setRepStack] = useState<Array<string | null>>([]);
  const repasses = trpc.admin.usuarios.financeiro.repasses.listPaginated.useQuery({
    idConta,
    cursor: repCursor,
    limit: 20,
  });

  const resetLanc = () => {
    setLancCursor(null);
    setLancStack([]);
  };

  return (
    <section data-bc="financeiro" className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-3">
          <DddBadge bc="pagamentos" size="sm" />
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
            financeiro · campanhas administradas
          </h2>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          somente leitura · celular do titular mascarado
        </span>
      </div>

      {summary.isLoading && (
        <div className="space-y-2" aria-busy="true">
          <div className="h-24 animate-pulse rounded-md bg-cream-2" />
          <div className="h-10 animate-pulse rounded-md bg-cream-2" />
        </div>
      )}
      {summary.error && <ErrorState message={summary.error.message} />}
      {!summary.isLoading && !summary.error && summary.data === null && (
        <p className="text-[13px] italic text-ink-mute">
          Resumo financeiro indisponível para esta conta.
        </p>
      )}
      {summary.data && (
        <>
          <ResumoFinanceiroCard
            totais={summary.data.totais}
            ledgerAprovadoSemCancelCents={summary.data.ledgerAprovadoSemCancelCents}
            diferencaNaoConciliadaCents={summary.data.diferencaNaoConciliadaCents}
            campanhasTotal={summary.data.campanhasTotal}
          />
          <CampanhasAdministradasTable
            idConta={idConta}
            campanhas={summary.data.campanhas}
            campanhasTotal={summary.data.campanhasTotal}
            truncated={summary.data.truncated}
          />
        </>
      )}

      <LancamentosAdminTable
        rows={lancamentos.data?.rows ?? []}
        totalCount={lancamentos.data?.totalCount ?? 0}
        isLoading={lancamentos.isLoading}
        isFetching={lancamentos.isFetching}
        errorMessage={lancamentos.error?.message ?? null}
        estado={estado}
        onEstadoChange={(next) => {
          setEstado(next);
          resetLanc();
        }}
        idCampanha={idCampanha}
        onCampanhaChange={(next) => {
          setIdCampanha(next);
          resetLanc();
        }}
        campanhas={summary.data?.campanhas ?? []}
        hasNext={Boolean(lancamentos.data?.nextCursor)}
        onNext={() => {
          const next = lancamentos.data?.nextCursor ?? null;
          if (!next) return;
          setLancStack((s) => [...s, lancCursor]);
          setLancCursor(next);
        }}
        hasPrev={lancStack.length > 0}
        onPrev={() => {
          const prev = lancStack[lancStack.length - 1] ?? null;
          setLancStack((s) => s.slice(0, -1));
          setLancCursor(prev);
        }}
        pageIndex={lancStack.length}
        filterIdPrefix={filterIdPrefix}
      />

      <TransferenciasAdminTable
        rows={repasses.data?.rows ?? []}
        totalCount={repasses.data?.totalCount ?? 0}
        isLoading={repasses.isLoading}
        isFetching={repasses.isFetching}
        errorMessage={repasses.error?.message ?? null}
        hasNext={Boolean(repasses.data?.nextCursor)}
        onNext={() => {
          const next = repasses.data?.nextCursor ?? null;
          if (!next) return;
          setRepStack((s) => [...s, repCursor]);
          setRepCursor(next);
        }}
        hasPrev={repStack.length > 0}
        onPrev={() => {
          const prev = repStack[repStack.length - 1] ?? null;
          setRepStack((s) => s.slice(0, -1));
          setRepCursor(prev);
        }}
        pageIndex={repStack.length}
      />
    </section>
  );
}

function CampanhasSection({
  idConta,
  email,
}: {
  idConta: string;
  email: string;
}) {
  /*
   * Section-per-BC scaffold (Wheatley directive, banked 2026-06-01).
   * W2 (rsidz.3) lands the real Arrecadação fetch — two tabs
   * (Administra / Contribuiu) inside the BC-bounded section. The
   * DddBadge marks the BC boundary so the operator's wayfinding stays
   * consistent. The wrapper keeps `data-bc="arrecadacao"` for downstream
   * BC-aware tooling (E2E selectors, CSS scoping if needed).
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
          arrecadação · drill
        </span>
      </div>
      <div className="mt-4">
        <CampanhasTabs idConta={idConta} email={email} />
      </div>
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
