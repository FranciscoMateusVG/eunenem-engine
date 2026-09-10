import type { inferRouterOutputs } from "@trpc/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { trpc } from "@/lib/trpc.js";
import type { AppRouter } from "../server/trpc/router.js";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type PaymentEvidenceRow =
  RouterOutputs["admin"]["pagamentos"]["listEvidencePaginated"]["rows"][number];
export type UnmatchedPaymentEvidenceRow =
  RouterOutputs["admin"]["pagamentos"]["listEvidencePaginated"]["unmatchedEvidence"][number];

const PAGE_SIZE = 50;
const FILTER_DEBOUNCE_MS = 300;

export type PaymentSearchDraft = {
  payerQuery: string;
  campaignQuery: string;
  exactReference: string;
};

const EMPTY_PAYMENT_SEARCH: PaymentSearchDraft = {
  payerQuery: "",
  campaignQuery: "",
  exactReference: "",
};

type ReferenceResolution =
  | "not_requested"
  | "absent"
  | "unique"
  | "unmatched"
  | "mixed"
  | "ambiguous"
  | null;

export function paymentEvidenceSearchInput(search: PaymentSearchDraft) {
  return {
    payerQuery: search.payerQuery.trim() || undefined,
    campaignQuery: search.campaignQuery.trim() || undefined,
    exactReference: search.exactReference.trim() || undefined,
  };
}

export function AdminPagamentosPage() {
  const [provider, setProvider] = useState<"stripe" | "inter" | null>(null);
  const [status, setStatus] = useState<
    "pendente" | "processing" | "aprovado" | "rejeitado" | "estornado" | null
  >(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [searchDraft, setSearchDraft] = useState<PaymentSearchDraft>(
    EMPTY_PAYMENT_SEARCH,
  );
  const [searchQuery, setSearchQuery] = useState<PaymentSearchDraft>(
    EMPTY_PAYMENT_SEARCH,
  );
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetCursor = useCallback(() => {
    setCursor(null);
    setCursorStack([]);
  }, []);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      const normalized = paymentEvidenceSearchInput(searchDraft);
      setSearchQuery({
        payerQuery: normalized.payerQuery ?? "",
        campaignQuery: normalized.campaignQuery ?? "",
        exactReference: normalized.exactReference ?? "",
      });
    }, FILTER_DEBOUNCE_MS);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchDraft]);

  const onSearchChange = useCallback(
    (field: keyof PaymentSearchDraft, value: string) => {
      setSearchDraft((current) => ({ ...current, [field]: value }));
      resetCursor();
    },
    [resetCursor],
  );

  const clearSearch = useCallback(() => {
    setSearchDraft(EMPTY_PAYMENT_SEARCH);
    setSearchQuery(EMPTY_PAYMENT_SEARCH);
    resetCursor();
  }, [resetCursor]);

  const queryInput = useMemo(
    () => ({
      cursor,
      limit: PAGE_SIZE,
      provider,
      status,
      ...paymentEvidenceSearchInput(searchQuery),
    }),
    [cursor, provider, status, searchQuery],
  );
  const query = trpc.admin.pagamentos.listEvidencePaginated.useQuery(queryInput, {
    staleTime: 30_000,
  });
  const referenceResolution = referenceResolutionFrom(query.data);

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
          search={searchDraft}
          onProviderChange={(next) => {
            setProvider(next);
            resetCursor();
          }}
          onStatusChange={(next) => {
            setStatus(next);
            resetCursor();
          }}
          onSearchChange={onSearchChange}
          onClearSearch={clearSearch}
        />

        {query.error ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
            Não foi possível carregar as evidências locais. {query.error.message}
          </div>
        ) : (
          <ReferenceResolutionNotice
            exactReference={searchQuery.exactReference}
            resolution={referenceResolution}
          />
        )}

        {!query.error &&
        referenceResolution !== "absent" &&
        referenceResolution !== "ambiguous" ? (
          <PaymentEvidenceTable rows={query.data?.rows ?? []} loading={query.isLoading} />
        ) : null}

        {!query.error ? (
          <UnmatchedPaymentEvidenceTable
            rows={query.data?.unmatchedEvidence ?? []}
            truncated={query.data?.unmatchedEvidenceTruncated ?? false}
          />
        ) : null}

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

export function PaymentEvidenceFilters({
  provider,
  status,
  search,
  onProviderChange,
  onStatusChange,
  onSearchChange,
  onClearSearch,
}: {
  provider: "stripe" | "inter" | null;
  status: "pendente" | "processing" | "aprovado" | "rejeitado" | "estornado" | null;
  search: PaymentSearchDraft;
  onProviderChange: (provider: "stripe" | "inter" | null) => void;
  onStatusChange: (
    status: "pendente" | "processing" | "aprovado" | "rejeitado" | "estornado" | null,
  ) => void;
  onSearchChange: (field: keyof PaymentSearchDraft, value: string) => void;
  onClearSearch: () => void;
}) {
  const hasSearch = Object.values(search).some((value) => value.trim() !== "");
  return (
    <div className="grid min-w-0 gap-3 rounded-md border border-line bg-cream-2/30 p-4 sm:grid-cols-2 lg:grid-cols-3">
      <SearchField
        label="Pagador"
        ariaLabel="Filtrar por nome ou email do pagador"
        placeholder="Nome ou email do pagador"
        maxLength={160}
        value={search.payerQuery}
        onChange={(value) => onSearchChange("payerQuery", value)}
      />
      <SearchField
        label="Pessoa ou campanha"
        ariaLabel="Filtrar por pessoa, campanha ou link da campanha"
        placeholder="Nome, título, link ou slug da campanha"
        maxLength={1024}
        value={search.campaignQuery}
        onChange={(value) => onSearchChange("campaignQuery", value)}
      />
      <SearchField
        label="Referência de pagamento / Inter"
        ariaLabel="Localizar por referência exata de pagamento ou Inter"
        placeholder="UUID, txid, e2e, cs_, pi_, ch_ ou evt_"
        maxLength={255}
        value={search.exactReference}
        onChange={(value) => onSearchChange("exactReference", value)}
      />
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
          className="block min-h-11 w-full min-w-0 rounded border border-line bg-paper px-3 py-2 text-[13px] normal-case tracking-normal text-ink"
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
          className="block min-h-11 w-full min-w-0 rounded border border-line bg-paper px-3 py-2 text-[13px] normal-case tracking-normal text-ink"
        >
          <option value="">Todos</option>
          <option value="pendente">Pendente</option>
          <option value="processing">Processando</option>
          <option value="aprovado">Aprovado</option>
          <option value="rejeitado">Rejeitado</option>
          <option value="estornado">Estornado</option>
        </select>
      </label>
      <div className="flex items-end sm:justify-end lg:justify-start">
        <button
          type="button"
          disabled={!hasSearch}
          onClick={onClearSearch}
          className="min-h-11 rounded border border-line bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft transition-colors hover:border-plum hover:text-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          Limpar buscas
        </button>
      </div>
    </div>
  );
}

function SearchField({
  label,
  ariaLabel,
  placeholder,
  maxLength,
  value,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  placeholder: string;
  maxLength: number;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="min-w-0 space-y-1 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft">
      {label}
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={maxLength}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="block min-h-11 w-full min-w-0 rounded border border-line bg-paper px-3 py-2 text-[13px] normal-case tracking-normal text-ink placeholder:text-ink-mute focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
      />
    </label>
  );
}

function referenceResolutionFrom(data: unknown): ReferenceResolution {
  if (!data || typeof data !== "object" || !("referenceResolution" in data)) {
    return null;
  }
  const resolution = data.referenceResolution;
  return resolution === "not_requested" ||
    resolution === "absent" ||
    resolution === "unique" ||
    resolution === "unmatched" ||
    resolution === "mixed" ||
    resolution === "ambiguous"
    ? resolution
    : null;
}

export function ReferenceResolutionNotice({
  exactReference,
  resolution,
}: {
  exactReference: string;
  resolution: ReferenceResolution;
}) {
  if (
    exactReference === "" ||
    resolution === null ||
    resolution === "not_requested" ||
    resolution === "unique" ||
    resolution === "unmatched"
  ) {
    return null;
  }
  if (resolution === "absent") {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-4 text-[14px] text-amber-900">
        Nenhuma evidência local foi encontrada para esta referência. Isso não prova ausência no
        provedor.
      </p>
    );
  }
  if (resolution === "mixed") {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-4 text-[14px] text-amber-900">
        A referência aparece em um pagamento local e também em recebimentos sem vínculo. As
        evidências são mostradas separadamente; isso não confirma que pertencem ao mesmo pagamento.
      </p>
    );
  }
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-[14px] text-red-800">
      A referência corresponde a mais de um pagamento local. Nenhuma linha foi escolhida; confira
      a inconsistência antes de agir.
    </p>
  );
}

export function UnmatchedPaymentEvidenceTable({
  rows,
  truncated,
}: {
  rows: readonly UnmatchedPaymentEvidenceRow[];
  truncated: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="unmatched-evidence-title">
      <div>
        <h2 id="unmatched-evidence-title" className="text-lg font-semibold text-ink">
          Evidência recebida sem pagamento local vinculado
        </h2>
        <p className="text-[13px] text-ink-soft">
          Registro recebido no endpoint EuNeném. Não comprova que o pagamento pertence à plataforma
          nem que o dinheiro chegou.
        </p>
      </div>
      <div className="overflow-x-auto rounded-md border border-line bg-paper">
        <table className="min-w-full divide-y divide-line text-left text-[12px]">
          <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.12em] text-ink-mute">
            <tr>
              <th className="px-3 py-2">Recebido</th>
              <th className="px-3 py-2">Provedor / confiança</th>
              <th className="px-3 py-2">Processamento local</th>
              <th className="px-3 py-2">Referências</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.archiveId}>
                <td className="whitespace-nowrap px-3 py-3 font-mono text-ink-soft">
                  {formatDate(row.receivedAt)}
                </td>
                <td className="px-3 py-3">
                  <div>{row.provider === "stripe" ? "Stripe" : "Inter"}</div>
                  <div className="text-[11px] text-ink-mute">
                    {row.trust === "stripe_configured_secret_verified"
                      ? "Assinatura verificada pelo segredo configurado neste endpoint"
                      : "Aviso não assinado; não confirmado pelo Inter"}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div>{formatUnmatchedProcessingState(row.processingState)}</div>
                  <div className="text-[11px] text-ink-mute">
                    {row.failureCategory ?? "sem categoria de falha disponível"}
                  </div>
                  {row.processedAt ? (
                    <div className="text-[10px] text-ink-mute">
                      Concluído localmente em {formatDate(row.processedAt)}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3 font-mono text-[10px]">
                  <div className="break-all">{row.matchedReference}</div>
                  <div className="break-all text-ink-mute">evento {row.providerEventId}</div>
                  <div className="break-all text-ink-mute">tipo {row.eventType}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated ? (
        <p role="status" className="text-[12px] text-amber-900">
          Mostrando as 20 evidências mais recentes. Existem outros registros locais para esta
          referência.
        </p>
      ) : null}
    </section>
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

function formatUnmatchedProcessingState(
  state: UnmatchedPaymentEvidenceRow["processingState"],
): string {
  if (state === "processed") return "Processamento local concluído";
  if (state === "failed") return "Falha no processamento local";
  return "Processamento local pendente";
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(iso));
}
