import type { inferRouterOutputs } from "@trpc/server";
import { useCallback, useMemo, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { trpc } from "@/lib/trpc.js";
import type { AppRouter } from "../server/trpc/router.js";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type PaymentEvidenceRow =
  RouterOutputs["admin"]["pagamentos"]["listEvidencePaginated"]["rows"][number];

const PAGE_SIZE = 50;

export function AdminPagamentosPage() {
  const [provider, setProvider] = useState<"stripe" | "inter" | null>(null);
  const [status, setStatus] = useState<
    "pendente" | "processing" | "aprovado" | "rejeitado" | "estornado" | null
  >(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);

  const resetCursor = useCallback(() => {
    setCursor(null);
    setCursorStack([]);
  }, []);

  const queryInput = useMemo(
    () => ({ cursor, limit: PAGE_SIZE, provider, status }),
    [cursor, provider, status],
  );
  const query = trpc.admin.pagamentos.listEvidencePaginated.useQuery(queryInput, {
    staleTime: 30_000,
  });

  const onNext = useCallback(() => {
    if (!query.data?.nextCursor) return;
    setCursorStack((stack) => [...stack, cursor]);
    setCursor(query.data.nextCursor);
  }, [cursor, query.data?.nextCursor]);

  const onPrev = useCallback(() => {
    setCursorStack((stack) => {
      if (stack.length === 0) return stack;
      setCursor(stack.at(-1) ?? null);
      return stack.slice(0, -1);
    });
  }, []);

  return (
    <AdminShell
      activeBc="pagamentos"
      activeNav="pagamentos"
      breadcrumb={[{ label: "admin", href: "/admin" }, { label: "pagamentos" }]}
      bcContext="evidência local de Stripe e Inter"
    >
      <section className="space-y-6">
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            <DddBadge bc="pagamentos" size="sm" />
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
              admin · pagamentos
            </p>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-ink">
            Evidências de pagamentos
          </h1>
          <p className="max-w-3xl text-[14px] leading-relaxed text-ink-soft">
            Dados já salvos pela plataforma. Ausência de referência aparece como ausência — esta
            tela não consulta nem corrige dados nos provedores.
          </p>
        </header>

        <PaymentEvidenceFilters
          provider={provider}
          status={status}
          onProviderChange={(next) => {
            setProvider(next);
            resetCursor();
          }}
          onStatusChange={(next) => {
            setStatus(next);
            resetCursor();
          }}
        />

        {query.error ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
            Não foi possível carregar as evidências locais. {query.error.message}
          </div>
        ) : (
          <PaymentEvidenceTable rows={query.data?.rows ?? []} loading={query.isLoading} />
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono text-[11px] text-ink-mute">
            {query.data ? `${query.data.totalCount} pagamento(s)` : "carregando…"}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={cursorStack.length === 0 || query.isFetching}
              onClick={onPrev}
              className="rounded border border-line px-3 py-2 font-mono text-[11px] uppercase disabled:opacity-40"
            >
              Anterior
            </button>
            <button
              type="button"
              disabled={!query.data?.nextCursor || query.isFetching}
              onClick={onNext}
              className="rounded border border-line px-3 py-2 font-mono text-[11px] uppercase disabled:opacity-40"
            >
              Próxima
            </button>
          </div>
        </div>
      </section>
    </AdminShell>
  );
}

function PaymentEvidenceFilters({
  provider,
  status,
  onProviderChange,
  onStatusChange,
}: {
  provider: "stripe" | "inter" | null;
  status: "pendente" | "processing" | "aprovado" | "rejeitado" | "estornado" | null;
  onProviderChange: (provider: "stripe" | "inter" | null) => void;
  onStatusChange: (
    status: "pendente" | "processing" | "aprovado" | "rejeitado" | "estornado" | null,
  ) => void;
}) {
  return (
    <div className="grid gap-3 rounded-md border border-line bg-cream-2/30 p-4 sm:grid-cols-2">
      <label className="space-y-1 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft">
        Provedor salvo
        <select
          aria-label="Filtrar pagamentos por provedor"
          value={provider ?? ""}
          onChange={(event) =>
            onProviderChange(
              event.target.value === "stripe" || event.target.value === "inter"
                ? event.target.value
                : null,
            )
          }
          className="block w-full rounded border border-line bg-paper px-3 py-2 text-[13px] normal-case tracking-normal text-ink"
        >
          <option value="">Todos</option>
          <option value="stripe">Stripe</option>
          <option value="inter">Inter</option>
        </select>
      </label>
      <label className="space-y-1 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft">
        Estado local
        <select
          aria-label="Filtrar pagamentos por estado local"
          value={status ?? ""}
          onChange={(event) => {
            const next = event.target.value;
            onStatusChange(
              next === "pendente" ||
                next === "processing" ||
                next === "aprovado" ||
                next === "rejeitado" ||
                next === "estornado"
                ? next
                : null,
            );
          }}
          className="block w-full rounded border border-line bg-paper px-3 py-2 text-[13px] normal-case tracking-normal text-ink"
        >
          <option value="">Todos</option>
          <option value="pendente">Pendente</option>
          <option value="processing">Processando</option>
          <option value="aprovado">Aprovado</option>
          <option value="rejeitado">Rejeitado</option>
          <option value="estornado">Estornado</option>
        </select>
      </label>
    </div>
  );
}

export function PaymentEvidenceTable({
  rows,
  loading = false,
}: {
  rows: readonly PaymentEvidenceRow[];
  loading?: boolean;
}) {
  if (loading && rows.length === 0) {
    return <p className="font-mono text-[12px] text-ink-mute">carregando…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-line bg-paper p-5 text-[14px] text-ink-soft">
        Nenhum pagamento corresponde aos filtros.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-line bg-paper">
      <table className="min-w-full divide-y divide-line text-left text-[12px]">
        <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.12em] text-ink-mute">
          <tr>
            <th className="px-3 py-2">Quando</th>
            <th className="px-3 py-2">Campanha</th>
            <th className="px-3 py-2">Meio / provedor</th>
            <th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2">Valores</th>
            <th className="px-3 py-2">Referências salvas</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.paymentId}>
              <td className="whitespace-nowrap px-3 py-3 font-mono text-ink-soft">
                {formatDate(row.createdAt)}
              </td>
              <td className="px-3 py-3">
                <a className="font-medium text-plum underline" href={`/admin/pagamento/${row.paymentId}`}>
                  {row.campaignTitle}
                </a>
                <div className="font-mono text-[10px] text-ink-mute">{row.paymentId}</div>
              </td>
              <td className="px-3 py-3">
                <div>{row.method === "credit_card" ? "Cartão" : "PIX"}</div>
                <div className="font-mono text-[10px] uppercase text-ink-mute">
                  {formatProvider(row.providerEvidence.provider)}
                </div>
              </td>
              <td className="px-3 py-3">
                <div>{formatPaymentStatus(row.status)}</div>
                <div className="text-[11px] text-ink-mute">
                  Provedor: {formatNormalizedStatus(row.providerEvidence.normalizedStatus)}
                </div>
                <div className="text-[11px] text-ink-mute">
                  Bruto: {row.providerEvidence.rawStatus ?? "sem estado salvo"}
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-3 font-mono">
                <div>Total previsto {formatBRL(row.amounts.paidCents)}</div>
                <div className="text-[10px] text-ink-mute">
                  contribuição {formatBRL(row.amounts.contributionCents)}
                </div>
                <div className="text-[10px] text-ink-mute">
                  taxa plataforma {formatBRL(row.amounts.feeCents)}
                </div>
                <div className="text-[10px] text-ink-mute">
                  adicional cartão {formatBRL(row.amounts.surchargeCents)}
                </div>
                <div className="text-[10px] text-ink-mute">
                  recebedor {formatBRL(row.amounts.receiverCents)}
                </div>
                <div className="mt-1 border-t border-line pt-1 text-[10px] text-ink-mute">
                  Valor registrado pelo provedor:{" "}
                  {row.providerEvidence.providerAmountCents === null
                    ? "ausente"
                    : formatBRL(row.providerEvidence.providerAmountCents)}
                </div>
                <div className="text-[10px] text-ink-mute">
                  Momento registrado pelo provedor:{" "}
                  {row.providerEvidence.providerRecordedAt === null
                    ? "ausente"
                    : formatDate(row.providerEvidence.providerRecordedAt)}
                </div>
              </td>
              <td className="px-3 py-3">
                <EvidenceReferences evidence={row.providerEvidence} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidenceReferences({ evidence }: { evidence: PaymentEvidenceRow["providerEvidence"] }) {
  const references = [
    ["checkout", evidence.checkoutSessionRef],
    ["payment intent", evidence.paymentIntentRef],
    ["charge", evidence.chargeRef],
    ["Inter e2e", evidence.interE2eRef],
    ["transação", evidence.externalTransactionRef],
  ].filter((entry): entry is [string, string] => entry[1] !== null);

  if (references.length === 0) {
    return <span className="italic text-ink-mute">sem referência salva</span>;
  }

  return (
    <dl className="space-y-1">
      {references.map(([label, value]) => (
        <div key={label}>
          <dt className="inline text-[10px] uppercase text-ink-mute">{label}: </dt>
          <dd className="inline break-all font-mono text-[10px] text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function formatProvider(provider: string | null): string {
  if (provider === "stripe") return "Stripe";
  if (provider === "inter") return "Inter";
  return "provedor não registrado";
}

function formatNormalizedStatus(status: "aprovado" | "rejeitado" | null): string {
  if (status === "aprovado") return "Aprovado";
  if (status === "rejeitado") return "Rejeitado";
  return "sem estado normalizado";
}

function formatPaymentStatus(status: PaymentEvidenceRow["status"]): string {
  const labels: Record<PaymentEvidenceRow["status"], string> = {
    pendente: "Pendente",
    processing: "Processando",
    aprovado: "Aprovado",
    rejeitado: "Rejeitado",
    estornado: "Estornado",
  };
  return labels[status];
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(iso));
}
