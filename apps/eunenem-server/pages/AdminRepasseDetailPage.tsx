import { useEffect, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import {
  type AprovarMutationResult,
  type RepasseDetail,
  type RepasseDetailLancamento,
  type RepasseStatus,
  useStubRepasseAprovar,
  useStubRepasseDetail,
} from "@/components/eunenem/admin/RepassesStubData";

/**
 * /admin/repasses/:idRepasse — single-repasse detail view + approval flow
 * (plan q2d4b Track 3, aperture-vi0hy parallel-prep against aperture-riywh).
 *
 * Three sections in the body:
 *   1. Summary card — campanha title + recebedor + amount + status chip +
 *      solicitadoEm + aprovadoEm (when present) + bankTransferRef (when set)
 *   2. Lançamentos list — every lancamento sweep-claimed into this repasse,
 *      with gift name + contribuinte name + amount + metodo
 *   3. APPROVE button (only when status='solicitado') — opens confirmation
 *      modal with optional bankTransferRef input
 *
 * APPROVAL FLOW:
 *   - Operator clicks "Aprovar repasse"
 *   - Modal opens: read-only summary of what's being approved + optional
 *     text input for bankTransferRef ("TED-xxx / PIX-yyy / opcional")
 *   - "Confirmar" → trpc.admin.repasses.aprovar (or stub today)
 *   - On success: modal closes, status chip flips to aprovado, aprovadoEm
 *     populates. Operator can navigate back to /admin/repasses list.
 *   - On error: 404 NOT_FOUND or 409 CONFLICT surfaced inline below the
 *     bankTransferRef input. Modal stays open so operator can re-read +
 *     dismiss / retry.
 *
 * MODAL A11Y (pf348 pattern):
 *   - role="dialog" + aria-modal="true" + aria-label
 *   - Backdrop button (tabIndex=-1) for click-outside-to-close
 *   - Escape key listener with addEventListener cleanup
 *   - Focus management: bankTransferRef input auto-focuses on open
 *
 * VISUAL IDENTITY: financeiro DddBadge purple, matching the list page +
 * the LancamentosBlock sub-header pattern. The detail page is the
 * Financeiro module's deepest operator surface.
 */
export function AdminRepasseDetailPage({
  idRepasse,
}: {
  idRepasse: string;
}) {
  const { data, isLoading, error } = useStubRepasseDetail(idRepasse);
  const shortId = `${idRepasse.slice(-8)}`;

  return (
    <AdminShell
      activeNav="repasses"
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "repasses", href: "/admin/repasses" },
        { label: shortId },
      ]}
      bcContext={
        <>
          repasse <span className="text-ink">{shortId}</span>
        </>
      }
    >
      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message} />}
      {!isLoading && !error && data === null && (
        <NotFoundState idRepasse={idRepasse} />
      )}
      {!isLoading && !error && data && <Body repasse={data} />}
    </AdminShell>
  );
}

/* -----------------------------------------------------------------------
 * Body
 * --------------------------------------------------------------------- */

function Body({ repasse }: { repasse: RepasseDetail }) {
  const [modalOpen, setModalOpen] = useState(false);
  // Post-approval success state — when the mutation resolves, we render a
  // success card with the freshly-known aprovadoEm + numLancamentosTransferidos
  // instead of waiting for a tRPC invalidation roundtrip. Real impl will
  // also call utils.admin.repasses.show.invalidate() to refresh the cached
  // detail; this local state is the immediate operator feedback layer.
  const [aprovalResult, setAprovalResult] =
    useState<AprovarMutationResult | null>(null);

  return (
    <section className="space-y-6">
      <SectionHeader />
      <SummaryCard repasse={repasse} />
      {aprovalResult !== null && (
        <ApprovalSuccessCard result={aprovalResult} />
      )}
      <LancamentosList lancamentos={repasse.lancamentos} />
      {repasse.status === "solicitado" && aprovalResult === null && (
        <ApproveAction onOpen={() => setModalOpen(true)} />
      )}
      {modalOpen && (
        <ConfirmAprovarModal
          repasse={repasse}
          onClose={() => setModalOpen(false)}
          onSuccess={(result) => {
            setAprovalResult(result);
            setModalOpen(false);
          }}
        />
      )}
    </section>
  );
}

/**
 * Post-approval acknowledgement card. Rendered inline above the lancamentos
 * list after the mutate resolves. Operator sees the freshly-known aprovadoEm,
 * the count of lancamentos that flipped to transferred, the total cents, and
 * a back-link to the queue.
 */
function ApprovalSuccessCard({ result }: { result: AprovarMutationResult }) {
  return (
    <div className="space-y-3 rounded-md border border-emerald-200 bg-emerald-50 p-5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-flex size-5 items-center justify-center rounded-full bg-emerald-200 text-[12px] text-emerald-800"
        >
          ✓
        </span>
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-800">
          repasse aprovado
        </p>
      </div>
      <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[max-content_1fr]">
        <SuccessRow
          label="aprovado em"
          value={
            <span className="font-mono tabular-nums">
              {formatLongDate(result.aprovadoEm)}
            </span>
          }
        />
        <SuccessRow
          label="lançamentos transferidos"
          value={
            <span className="font-mono tabular-nums">
              {result.numLancamentosTransferidos}
            </span>
          }
        />
        <SuccessRow
          label="valor total"
          value={
            <span className="font-mono tabular-nums">
              {formatBRL(result.totalCents)}
            </span>
          }
        />
      </dl>
      <a
        href="/admin/repasses"
        className="inline-block font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-800 underline decoration-dotted underline-offset-4 hover:text-emerald-700"
      >
        ← voltar à fila
      </a>
    </div>
  );
}

function SuccessRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="contents [&>dt]:font-mono [&>dt]:text-[10px] [&>dt]:uppercase [&>dt]:tracking-[0.14em] [&>dt]:text-emerald-800">
      <dt className="pt-0.5">{label}</dt>
      <dd className="pb-0.5 text-[13px] text-emerald-900">{value}</dd>
    </div>
  );
}

function SectionHeader() {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-3">
        <DddBadge bc="financeiro" size="sm" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          repasse · detalhe
        </h2>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
        aprovar ou consultar histórico
      </span>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Summary card
 * --------------------------------------------------------------------- */

function SummaryCard({ repasse }: { repasse: RepasseDetail }) {
  return (
    <div className="space-y-5 rounded-md border border-line bg-paper p-5">
      <Headline repasse={repasse} />
      <FactsGrid repasse={repasse} />
    </div>
  );
}

function Headline({ repasse }: { repasse: RepasseDetail }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="text-xl font-semibold tracking-tight text-ink">
        {repasse.campanhaTitulo}
      </h3>
      <StatusPill status={repasse.status} />
    </div>
  );
}

function FactsGrid({ repasse }: { repasse: RepasseDetail }) {
  const facts: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "recebedor",
      value:
        repasse.recebedorNome === null ? (
          <span className="text-[13px] italic text-ink-mute">
            (sem recebedor)
          </span>
        ) : (
          <span className="text-[13px] text-ink">{repasse.recebedorNome}</span>
        ),
    },
    {
      label: "valor",
      value: (
        <span className="font-mono text-[14px] tabular-nums text-ink">
          {formatBRL(repasse.amountCents)}
        </span>
      ),
    },
    {
      label: "lançamentos",
      value: (
        <span className="font-mono text-[13px] tabular-nums text-ink-soft">
          {repasse.numLancamentos}
        </span>
      ),
    },
    {
      label: "solicitado em",
      value: (
        <span className="font-mono text-[12px] tabular-nums text-ink-soft">
          {formatLongDate(repasse.solicitadoEm)}
        </span>
      ),
    },
    {
      label: "aprovado em",
      value:
        repasse.aprovadoEm === null ? (
          <span className="font-mono text-[12px] text-ink-mute">—</span>
        ) : (
          <span className="font-mono text-[12px] tabular-nums text-emerald-700">
            {formatLongDate(repasse.aprovadoEm)}
          </span>
        ),
    },
    {
      label: "referência bancária",
      value:
        repasse.bankTransferRef === null ? (
          <span className="font-mono text-[12px] italic text-ink-mute">
            (sem referência)
          </span>
        ) : (
          <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[12px] text-ink">
            {repasse.bankTransferRef}
          </code>
        ),
    },
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
      {facts.map(({ label, value }) => (
        <div
          key={label}
          className="contents [&>dt]:font-mono [&>dt]:text-[11px] [&>dt]:uppercase [&>dt]:tracking-[0.12em] [&>dt]:text-ink-mute"
        >
          <dt className="pt-1">{label}</dt>
          <dd className="pb-1 sm:pb-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* -----------------------------------------------------------------------
 * Lançamentos list
 * --------------------------------------------------------------------- */

/**
 * Lançamentos breakdown for the detail page. Rex's locked RepasseLancamentoDetail
 * is lean — contribuinte snapshot + amount + parent refs + pagamento date.
 * Gift name + metodo are NOT on this projection (reachable via drill if the
 * operator clicks through to /admin/contribuicao/:id, but inline display
 * would require composing across 3 BCs at list time).
 *
 * Each row surfaces:
 *   - Contribuinte name (or "(anônimo)" affordance when null)
 *   - Pagamento criadoEm short date (when the source event landed)
 *   - Idempotency-friendly id tags (idLancamento short + idPagamento drill link)
 *   - Right-aligned BRL amount
 */
function LancamentosList({
  lancamentos,
}: {
  lancamentos: readonly RepasseDetailLancamento[];
}) {
  return (
    <div className="rounded-md border border-line bg-paper">
      <div className="flex items-center gap-2 border-b border-line bg-cream-2/40 px-5 py-2">
        <DddBadge bc="financeiro" size="sm" />
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft">
          lançamentos compostos · {lancamentos.length}
        </p>
      </div>
      <ul className="divide-y divide-line">
        {lancamentos.map((l) => (
          <LancamentoRow key={l.idLancamento} lancamento={l} />
        ))}
      </ul>
    </div>
  );
}

function LancamentoRow({
  lancamento,
}: {
  lancamento: RepasseDetailLancamento;
}) {
  const contribuicaoHref = `/admin/contribuicao/${lancamento.idContribuicao}`;
  return (
    <li className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 px-5 py-3">
      <div className="space-y-1">
        <p className="text-[13px] text-ink">
          {lancamento.contribuinteNome === null ? (
            <span className="italic text-ink-mute">(anônimo)</span>
          ) : (
            lancamento.contribuinteNome
          )}
        </p>
        <p className="font-mono text-[11px] text-ink-soft">
          <span>pagamento de</span>{" "}
          <span className="tabular-nums">
            {formatShortDate(lancamento.pagamentoCriadoEm)}
          </span>
          <span className="mx-1.5 text-ink-mute">·</span>
          <a
            href={contribuicaoHref}
            className="text-ink-soft underline decoration-dotted underline-offset-2 hover:text-plum"
            title={`Drill em contribuição ${lancamento.idContribuicao}`}
          >
            contribuição {lancamento.idContribuicao.slice(0, 8)}…
          </a>
        </p>
      </div>
      <span className="font-mono text-[13px] tabular-nums text-ink">
        {formatBRL(lancamento.amountCents)}
      </span>
    </li>
  );
}

/* -----------------------------------------------------------------------
 * Approve action + modal
 * --------------------------------------------------------------------- */

function ApproveAction({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-line bg-paper p-5">
      <p className="text-[13px] text-ink-soft">
        Pronto para registrar este repasse como aprovado? A aprovação é a
        entrada no diário — a transferência bancária acontece fora desta
        plataforma.
      </p>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex shrink-0 items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-emerald-800 transition-colors hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
      >
        <span aria-hidden>✓</span>
        Aprovar repasse
      </button>
    </div>
  );
}

function ConfirmAprovarModal({
  repasse,
  onClose,
  onSuccess,
}: {
  repasse: RepasseDetail;
  onClose: () => void;
  onSuccess: (result: AprovarMutationResult) => void;
}) {
  const [bankTransferRef, setBankTransferRef] = useState("");

  // The hook's onSuccess fires AFTER the mutation resolves with the result
  // shape. We bubble it up to the parent which renders the success card.
  // Real impl: this same callback lives on
  // `trpc.admin.repasses.aprovar.useMutation({ onSuccess })` — no consumer
  // change at swap time.
  const aprovar = useStubRepasseAprovar(onSuccess);

  // Escape-to-close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    aprovar.mutate({
      idRepasse: repasse.idRepasse,
      bankTransferRef: bankTransferRef.trim() === "" ? null : bankTransferRef.trim(),
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirmar aprovação de repasse"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
        tabIndex={-1}
      />
      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-lg">
        <ModalHeader onClose={onClose} />
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <SummaryFacts repasse={repasse} />
          <BankTransferRefInput
            value={bankTransferRef}
            onChange={setBankTransferRef}
            disabled={aprovar.isPending}
          />
          {aprovar.error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              {aprovar.error.message}
            </div>
          )}
        </div>
        <ModalFooter
          onCancel={onClose}
          onConfirm={submit}
          isPending={aprovar.isPending}
        />
      </div>
    </div>
  );
}

function ModalHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line bg-cream-2/40 px-5 py-3">
      <div className="min-w-0 space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
          aprovar repasse
        </p>
        <p className="font-mono text-[13px] text-ink">
          Confirme o registro no diário
        </p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Fechar modal"
        className="-mr-2 -mt-1 rounded-md px-2 py-1 font-mono text-[16px] leading-none text-ink-soft transition-colors hover:bg-paper hover:text-plum"
      >
        ✕
      </button>
    </div>
  );
}

function SummaryFacts({ repasse }: { repasse: RepasseDetail }) {
  return (
    <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[max-content_1fr]">
      <SummaryRow label="campanha" value={repasse.campanhaTitulo} />
      <SummaryRow
        label="recebedor"
        value={
          repasse.recebedorNome === null ? (
            <span className="italic text-ink-mute">(sem recebedor)</span>
          ) : (
            repasse.recebedorNome
          )
        }
      />
      <SummaryRow
        label="valor"
        value={
          <span className="font-mono tabular-nums">
            {formatBRL(repasse.amountCents)}
          </span>
        }
      />
      <SummaryRow
        label="lançamentos"
        value={
          <span className="font-mono tabular-nums">{repasse.numLancamentos}</span>
        }
      />
    </dl>
  );
}

function SummaryRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="contents [&>dt]:font-mono [&>dt]:text-[10px] [&>dt]:uppercase [&>dt]:tracking-[0.14em] [&>dt]:text-ink-mute">
      <dt className="pt-0.5">{label}</dt>
      <dd className="pb-0.5 text-[13px] text-ink">{value}</dd>
    </div>
  );
}

function BankTransferRefInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor="bankTransferRef"
        className="block font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute"
      >
        referência bancária (opcional)
      </label>
      <input
        id="bankTransferRef"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus
        placeholder="TED-xxx / PIX-yyy / opcional"
        className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-mute focus:border-plum focus:outline-none focus:ring-1 focus:ring-plum disabled:opacity-50"
      />
      <p className="font-mono text-[10px] italic text-ink-mute">
        Pode preencher depois — o registro é gravado mesmo sem referência.
      </p>
    </div>
  );
}

function ModalFooter({
  onCancel,
  onConfirm,
  isPending,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-line bg-cream-2/30 px-5 py-3">
      <button
        type="button"
        onClick={onCancel}
        disabled={isPending}
        className="rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft hover:text-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft disabled:opacity-50"
      >
        Cancelar
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={isPending}
        className="inline-flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-800 transition-colors hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:opacity-50"
      >
        {isPending ? "Aprovando…" : "Confirmar aprovação"}
      </button>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Status pill
 * --------------------------------------------------------------------- */

function StatusPill({ status }: { status: RepasseStatus }) {
  const palette =
    status === "aprovado"
      ? {
          border: "border-emerald-200",
          bg: "bg-emerald-50",
          text: "text-emerald-800",
          dot: "bg-emerald-500",
        }
      : {
          border: "border-amber-200",
          bg: "bg-amber-50",
          text: "text-amber-800",
          dot: "bg-amber-500",
        };
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em]",
        palette.border,
        palette.bg,
        palette.text,
      ].join(" ")}
    >
      <span
        aria-hidden
        className={`inline-block size-[6px] rounded-full ${palette.dot}`}
      />
      {status}
    </span>
  );
}

/* -----------------------------------------------------------------------
 * States
 * --------------------------------------------------------------------- */

function LoadingState() {
  return (
    <div className="space-y-3 rounded-md border border-line bg-paper p-5">
      <div className="h-4 w-64 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-48 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-56 animate-pulse rounded bg-cream-2" />
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

function NotFoundState({ idRepasse }: { idRepasse: string }) {
  return (
    <div className="rounded-md border border-line bg-paper p-5">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        repasse não encontrado
      </p>
      <p className="mt-2 text-[13px] text-ink-soft">
        O repasse{" "}
        <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[12px]">
          {idRepasse}
        </code>{" "}
        não foi encontrado.
      </p>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------- */

function formatBRL(centavos: number): string {
  const reais = centavos / 100;
  try {
    return reais.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  } catch {
    return `R$ ${reais.toFixed(2)}`;
  }
}

function formatLongDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  }
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
}
