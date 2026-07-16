import { useEffect, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import {
  ManualResolutionPill,
  REPASSE_STATUS_GLOSS,
  RepasseStatusPill,
} from "@/components/eunenem/admin/repasse-status";
import {
  type AprovarMutationResult,
  type CancelarMutationResult,
  type RepasseDetail,
  type RepasseDetailLancamento,
  type RepasseSearchCandidate,
  type RepasseStatus,
  type RepasseTransferAttempt,
  type ResolverManualFalhouResult,
  type ResolverManualPagoResult,
  type RetryMutationResult,
  useStubRepasseAprovar,
  useStubRepasseCancelar,
  useStubRepasseDetail,
  useStubRepasseResolverManualFalhou,
  useStubRepasseResolverManualPago,
  useStubRepasseRetry,
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
      {repasse.attempts.length > 0 && (
        <AttemptHistory attempts={repasse.attempts} />
      )}
      <LancamentosList lancamentos={repasse.lancamentos} />

      {/* Actions + status context are state-driven. `solicitado` (aprovar),
          `falhou` (retry / cancelar) and a needs-manual-resolution
          `verificando` (spec §5.4: marcar pago / marcar falhou) carry
          actions; the remaining in-flight and terminal states render an
          explainer instead. */}
      {repasse.status === "solicitado" && aprovalResult === null && (
        <ApproveAction onOpen={() => setModalOpen(true)} />
      )}
      {repasse.status === "falhou" && <FailedActions repasse={repasse} />}
      {repasse.status === "verificando" && repasse.needsManualResolution && (
        <ManualResolutionActions repasse={repasse} />
      )}
      {(repasse.status === "aprovado" ||
        repasse.status === "transferindo" ||
        (repasse.status === "verificando" &&
          !repasse.needsManualResolution)) && (
        <InFlightNote status={repasse.status} />
      )}
      {repasse.status === "pago" && <TerminalNote status="pago" />}
      {repasse.status === "cancelado" && <TerminalNote status="cancelado" />}

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

/* -----------------------------------------------------------------------
 * Transfer attempt history (repasse_transfer_attempts, spec §4.2)
 * --------------------------------------------------------------------- */

const ATTEMPT_OUTCOME_TINT: Record<string, { dot: string; text: string }> = {
  pago: { dot: "bg-emerald-500", text: "text-emerald-800" },
  agendado_aprovacao: { dot: "bg-blue-500", text: "text-blue-800" },
  rejeitado: { dot: "bg-red-500", text: "text-red-800" },
  ambiguo: { dot: "bg-amber-500", text: "text-amber-800" },
  transitorio: { dot: "bg-amber-500", text: "text-amber-800" },
};

function AttemptHistory({
  attempts,
}: {
  attempts: readonly RepasseTransferAttempt[];
}) {
  // Newest first for scan-ability; the wire order is attemptNo ascending.
  const ordered = [...attempts].sort((a, b) => b.attemptNo - a.attemptNo);
  return (
    <div className="rounded-md border border-line bg-paper">
      <div className="flex items-center gap-2 border-b border-line bg-cream-2/40 px-5 py-2">
        <DddBadge bc="financeiro" size="sm" />
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft">
          tentativas de transferência · {attempts.length}
        </p>
      </div>
      <ul className="divide-y divide-line">
        {ordered.map((a) => (
          <AttemptRow key={a.id} attempt={a} />
        ))}
      </ul>
    </div>
  );
}

function AttemptRow({ attempt }: { attempt: RepasseTransferAttempt }) {
  const tint =
    attempt.outcome !== null
      ? (ATTEMPT_OUTCOME_TINT[attempt.outcome] ?? {
          dot: "bg-stone-400",
          text: "text-stone-600",
        })
      : { dot: "bg-purple-500", text: "text-purple-800" };
  const inFlight = attempt.finishedAt === null;
  return (
    <li className="space-y-1.5 px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] tabular-nums text-ink-mute">
          #{attempt.attemptNo}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] ${tint.text}`}
        >
          <span
            aria-hidden
            className={`inline-block size-[6px] rounded-full ${tint.dot}`}
          />
          {inFlight ? "em andamento" : (attempt.outcome ?? "—")}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-ink-soft">
          {formatLongDate(attempt.startedAt)}
          {attempt.finishedAt !== null && (
            <>
              <span className="mx-1 text-ink-mute">→</span>
              {formatLongDate(attempt.finishedAt)}
            </>
          )}
        </span>
      </div>
      {(attempt.codigoSolicitacao !== null ||
        attempt.error !== null ||
        attempt.requestSummary !== null) && (
        <dl className="grid gap-x-4 gap-y-0.5 pl-6 sm:grid-cols-[max-content_1fr]">
          {attempt.codigoSolicitacao !== null && (
            <AttemptMeta label="cód. inter" value={attempt.codigoSolicitacao} />
          )}
          {attempt.requestSummary !== null && (
            <AttemptMeta label="requisição" value={attempt.requestSummary} />
          )}
          {attempt.error !== null && (
            <AttemptMeta label="erro" value={attempt.error} tone="error" />
          )}
        </dl>
      )}
    </li>
  );
}

function AttemptMeta({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "error";
}) {
  return (
    <div className="contents [&>dt]:font-mono [&>dt]:text-[9px] [&>dt]:uppercase [&>dt]:tracking-[0.14em] [&>dt]:text-ink-mute">
      <dt className="pt-0.5">{label}</dt>
      <dd
        className={[
          "pb-0.5 font-mono text-[11px]",
          tone === "error" ? "text-red-700" : "text-ink-soft",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * State-driven action + note blocks
 * --------------------------------------------------------------------- */

/**
 * `falhou` is the only state with post-approval actions (spec §4.1/§5.5):
 * Retry re-fires the transfer, Cancelar is the irreversible claim-release
 * (confirm modal). Both disappear once the operator acts.
 */
function FailedActions({ repasse }: { repasse: RepasseDetail }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [retryResult, setRetryResult] = useState<RetryMutationResult | null>(
    null,
  );
  const [cancelResult, setCancelResult] =
    useState<CancelarMutationResult | null>(null);
  const retry = useStubRepasseRetry(setRetryResult);

  if (cancelResult !== null) {
    return <TerminalNote status="cancelado" />;
  }
  if (retryResult !== null) {
    return (
      <div className="rounded-md border border-purple-200 bg-purple-50 px-5 py-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-purple-800">
          transferência reprocessada
        </p>
        <p className="mt-1.5 text-[13px] text-purple-900">
          A transferência voltou para a fila e está sendo reprocessada no Inter.
          Atualize a página em instantes para acompanhar o novo resultado.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-red-200 bg-red-50 p-5">
      <div className="space-y-1">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-red-800">
          transferência falhou
        </p>
        <p className="text-[13px] text-red-900">
          Nenhum valor foi movido. Reprocesse para tentar novamente, ou cancele
          o repasse para devolver os valores ao saldo do recebedor.
        </p>
        {repasse.lastTransferError !== null && (
          <p className="mt-1 font-mono text-[12px] text-red-700">
            detalhe: {repasse.lastTransferError}
          </p>
        )}
        {retry.error && (
          <p className="mt-1 rounded-md border border-red-200 bg-paper px-3 py-2 text-[12px] text-red-800">
            Não foi possível reprocessar: {retry.error.message}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => retry.mutate({ idRepasse: repasse.idRepasse })}
          disabled={retry.isPending}
          className="inline-flex items-center gap-2 rounded-md border border-purple-300 bg-purple-50 px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-purple-800 transition-colors hover:bg-purple-100 focus:outline-none focus:ring-2 focus:ring-purple-300 disabled:opacity-50"
        >
          <span aria-hidden>↻</span>
          {retry.isPending ? "Reprocessando…" : "Reprocessar transferência"}
        </button>
        <button
          type="button"
          onClick={() => setCancelOpen(true)}
          className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-paper px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-stone-600 transition-colors hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-300"
        >
          Cancelar repasse
        </button>
      </div>
      {cancelOpen && (
        <ConfirmCancelarModal
          repasse={repasse}
          onClose={() => setCancelOpen(false)}
          onSuccess={(result) => {
            setCancelResult(result);
            setCancelOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Manual resolution — spec §5.4 (amended): Inter cannot echo our
 * referencia, so a search-fallback `verificando` repasse parks with its
 * candidate payments persisted and waits for an operator. Two positive
 * assertions resolve it:
 *   - Marcar como pago   → the operator matched a candidate; requires the
 *     matched codigoSolicitacao (confirm modal).
 *   - Marcar como falhou → the operator asserts NO payment exists on the
 *     Inter side (confirm modal). Retry/cancelar take over from `falhou`.
 * --------------------------------------------------------------------- */

function ManualResolutionActions({ repasse }: { repasse: RepasseDetail }) {
  const [pagoOpen, setPagoOpen] = useState(false);
  const [falhouOpen, setFalhouOpen] = useState(false);
  const [pagoResult, setPagoResult] =
    useState<ResolverManualPagoResult | null>(null);
  const [falhouResult, setFalhouResult] =
    useState<ResolverManualFalhouResult | null>(null);

  if (pagoResult !== null) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-5 py-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-800">
          repasse marcado como pago
        </p>
        <p className="mt-1.5 text-[13px] text-emerald-900">
          O pagamento{" "}
          <span className="font-mono">{pagoResult.codigoSolicitacao}</span> foi
          registrado como a transferência deste repasse. O extrato do recebedor
          passa a mostrar o valor como transferido.
        </p>
      </div>
    );
  }
  if (falhouResult !== null) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-5 py-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-red-800">
          repasse marcado como falhou
        </p>
        <p className="mt-1.5 text-[13px] text-red-900">
          Registrado que nenhum pagamento existe no Inter para esta
          transferência. Atualize a página para reprocessar ou cancelar o
          repasse.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-rose-200 bg-rose-50 p-5">
      <div className="space-y-1">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-rose-800">
          resolução manual necessária
        </p>
        <p className="text-[13px] text-rose-900">
          O Inter não confirma qual pagamento corresponde a esta transferência,
          e a busca encontrou{" "}
          <span className="font-semibold">
            {repasse.searchCandidates.length} pagamento
            {repasse.searchCandidates.length === 1 ? "" : "s"} candidato
            {repasse.searchCandidates.length === 1 ? "" : "s"}
          </span>
          . Compare com o extrato do Inter e resolva: marque como pago
          (informando o pagamento correspondente) ou como falhou (afirmando que
          nenhum pagamento existe).
        </p>
      </div>

      {repasse.searchCandidates.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-rose-200 bg-paper">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-rose-100 bg-rose-50/60">
                <CandidateHeader>código</CandidateHeader>
                <CandidateHeader align="right">valor</CandidateHeader>
                <CandidateHeader>data</CandidateHeader>
                <CandidateHeader>chave</CandidateHeader>
                <CandidateHeader>descrição</CandidateHeader>
              </tr>
            </thead>
            <tbody>
              {repasse.searchCandidates.map((c) => (
                <CandidateRow key={c.codigoSolicitacao} candidate={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setPagoOpen(true)}
          className="inline-flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-emerald-800 transition-colors hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
        >
          <span aria-hidden>✓</span>
          Marcar como pago
        </button>
        <button
          type="button"
          onClick={() => setFalhouOpen(true)}
          className="inline-flex items-center gap-2 rounded-md border border-red-300 bg-paper px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-red-700 transition-colors hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-300"
        >
          Marcar como falhou
        </button>
      </div>

      {pagoOpen && (
        <ConfirmMarcarPagoModal
          repasse={repasse}
          onClose={() => setPagoOpen(false)}
          onSuccess={(result) => {
            setPagoResult(result);
            setPagoOpen(false);
          }}
        />
      )}
      {falhouOpen && (
        <ConfirmMarcarFalhouModal
          repasse={repasse}
          onClose={() => setFalhouOpen(false)}
          onSuccess={(result) => {
            setFalhouResult(result);
            setFalhouOpen(false);
          }}
        />
      )}
    </div>
  );
}

function CandidateHeader({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-3 py-2 font-mono text-[10px] font-normal uppercase tracking-[0.16em] text-rose-700 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function CandidateRow({ candidate }: { candidate: RepasseSearchCandidate }) {
  return (
    <tr className="border-b border-rose-100 last:border-b-0">
      <td className="px-3 py-2 font-mono text-[12px] text-ink">
        {candidate.codigoSolicitacao}
      </td>
      <td className="px-3 py-2 text-right font-mono text-[12px] tabular-nums text-ink">
        {formatBRL(candidate.valorCents)}
      </td>
      <td className="px-3 py-2 font-mono text-[12px] tabular-nums text-ink-soft">
        {formatShortDate(candidate.data)}
      </td>
      <td className="px-3 py-2 font-mono text-[12px] text-ink-soft">
        {candidate.chaveMascarada ?? "—"}
      </td>
      <td className="px-3 py-2 text-[12px] text-ink-soft">
        {candidate.descricaoPix ?? "—"}
      </td>
    </tr>
  );
}

function ConfirmMarcarPagoModal({
  repasse,
  onClose,
  onSuccess,
}: {
  repasse: RepasseDetail;
  onClose: () => void;
  onSuccess: (result: ResolverManualPagoResult) => void;
}) {
  const resolver = useStubRepasseResolverManualPago(onSuccess);
  // A candidate selection OR a hand-typed codigoSolicitacao — the confirm
  // is disabled until one of the two yields a non-empty codigo.
  const [selected, setSelected] = useState<string | null>(
    repasse.searchCandidates.length === 1
      ? (repasse.searchCandidates[0]?.codigoSolicitacao ?? null)
      : null,
  );
  const [manual, setManual] = useState("");
  const codigo = selected ?? (manual.trim() === "" ? null : manual.trim());

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirmar pagamento manual"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
        tabIndex={-1}
      />
      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-emerald-200 bg-paper shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-emerald-200 bg-emerald-50 px-5 py-3">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-700">
              marcar como pago
            </p>
            <p className="font-mono text-[13px] text-emerald-900">
              Confirme o pagamento correspondente
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar modal"
            className="-mr-2 -mt-1 rounded-md px-2 py-1 font-mono text-[16px] leading-none text-emerald-700 transition-colors hover:bg-paper"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-[13px] text-ink-soft">
            O repasse de{" "}
            <span className="font-semibold text-ink">
              {formatBRL(repasse.amountCents)}
            </span>{" "}
            será marcado como <span className="font-mono">pago</span>, com o
            pagamento selecionado registrado como a transferência
            correspondente. Esta ação afirma que o dinheiro chegou ao
            recebedor.
          </p>

          {repasse.searchCandidates.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
                pagamento correspondente
              </legend>
              {repasse.searchCandidates.map((c) => (
                <label
                  key={c.codigoSolicitacao}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors ${
                    selected === c.codigoSolicitacao
                      ? "border-emerald-300 bg-emerald-50"
                      : "border-line bg-paper hover:bg-cream-2/40"
                  }`}
                >
                  <input
                    type="radio"
                    name="candidato"
                    checked={selected === c.codigoSolicitacao}
                    onChange={() => {
                      setSelected(c.codigoSolicitacao);
                      setManual("");
                    }}
                    className="mt-1 accent-emerald-600"
                  />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block font-mono text-[12px] text-ink">
                      {c.codigoSolicitacao}
                    </span>
                    <span className="block text-[12px] text-ink-soft">
                      {formatBRL(c.valorCents)} · {formatShortDate(c.data)}
                      {c.chaveMascarada !== null && ` · ${c.chaveMascarada}`}
                      {c.descricaoPix !== null && ` · ${c.descricaoPix}`}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <div className="space-y-1">
            <label
              htmlFor="codigo-manual"
              className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute"
            >
              ou informe o codigoSolicitacao
            </label>
            <input
              id="codigo-manual"
              type="text"
              value={manual}
              onChange={(e) => {
                setManual(e.target.value);
                if (e.target.value.trim() !== "") setSelected(null);
              }}
              placeholder="ex.: a1b2c3d4-…"
              className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-mute focus:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            />
          </div>

          {resolver.error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              {resolver.error.message}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-cream-2/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={resolver.isPending}
            className="rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft hover:text-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft disabled:opacity-50"
          >
            Voltar
          </button>
          <button
            type="button"
            onClick={() => {
              if (codigo !== null) {
                resolver.mutate({
                  idRepasse: repasse.idRepasse,
                  codigoSolicitacao: codigo,
                });
              }
            }}
            disabled={resolver.isPending || codigo === null}
            className="inline-flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-800 transition-colors hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:opacity-50"
          >
            {resolver.isPending ? "Confirmando…" : "Confirmar pagamento"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmMarcarFalhouModal({
  repasse,
  onClose,
  onSuccess,
}: {
  repasse: RepasseDetail;
  onClose: () => void;
  onSuccess: (result: ResolverManualFalhouResult) => void;
}) {
  const resolver = useStubRepasseResolverManualFalhou(onSuccess);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirmar falha da transferência"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
        tabIndex={-1}
      />
      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-red-200 bg-paper shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-red-200 bg-red-50 px-5 py-3">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-700">
              marcar como falhou
            </p>
            <p className="font-mono text-[13px] text-red-900">
              Afirmação de que nenhum pagamento existe
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar modal"
            className="-mr-2 -mt-1 rounded-md px-2 py-1 font-mono text-[16px] leading-none text-red-700 transition-colors hover:bg-paper"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-[13px] text-ink-soft">
            Marcar como falhou afirma que{" "}
            <span className="font-semibold text-ink">
              nenhum dos pagamentos candidatos corresponde
            </span>{" "}
            a esta transferência — confira o extrato do Inter antes de
            confirmar. O repasse vai para{" "}
            <span className="font-mono">falhou</span>, de onde pode ser
            reprocessado ou cancelado. Se o pagamento na verdade existir,
            reprocessar pode gerar um pagamento duplicado.
          </p>
          {resolver.error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              {resolver.error.message}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-cream-2/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={resolver.isPending}
            className="rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft hover:text-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft disabled:opacity-50"
          >
            Voltar
          </button>
          <button
            type="button"
            onClick={() => resolver.mutate({ idRepasse: repasse.idRepasse })}
            disabled={resolver.isPending}
            className="inline-flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-red-800 transition-colors hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:opacity-50"
          >
            {resolver.isPending ? "Confirmando…" : "Confirmar falha"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Non-actionable in-flight states — the operator waits; the worker drives. */
function InFlightNote({
  status,
}: {
  status: Extract<RepasseStatus, "aprovado" | "transferindo" | "verificando">;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-paper px-5 py-4">
      <RepasseStatusPill status={status} />
      <p className="text-[13px] text-ink-soft">
        {REPASSE_STATUS_GLOSS[status]}. Nenhuma ação manual é necessária — o
        repasse avança automaticamente. Esta página reflete o novo estado ao ser
        atualizada.
      </p>
    </div>
  );
}

/** Terminal states — settled (`pago`) or released (`cancelado`). No actions. */
function TerminalNote({ status }: { status: "pago" | "cancelado" }) {
  const isPaid = status === "pago";
  return (
    <div
      className={[
        "flex items-start gap-3 rounded-md border px-5 py-4",
        isPaid
          ? "border-emerald-200 bg-emerald-50"
          : "border-stone-300 bg-stone-100",
      ].join(" ")}
    >
      <RepasseStatusPill status={status} />
      <p
        className={[
          "text-[13px]",
          isPaid ? "text-emerald-900" : "text-stone-600",
        ].join(" ")}
      >
        {isPaid
          ? "Transferência concluída — o valor foi enviado ao recebedor."
          : "Repasse cancelado — os valores retornaram ao saldo do recebedor, que pode solicitar um novo resgate."}
      </p>
    </div>
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
      <RepasseStatusPill status={repasse.status} size="md" />
      {repasse.status === "verificando" && repasse.needsManualResolution && (
        <ManualResolutionPill size="md" />
      )}
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
    // ── Inter transfer facts — shown only once the payout lifecycle has data
    //    to show (spec §4.2). Absent for pre-transfer + manual `conta` rows. ──
    ...(repasse.transferReferencia !== null
      ? [
          {
            label: "referência transf.",
            value: (
              <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[12px] text-ink">
                {repasse.transferReferencia}
              </code>
            ),
          },
        ]
      : []),
    ...(repasse.interCodigoSolicitacao !== null
      ? [
          {
            label: "cód. inter",
            value: (
              <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[12px] text-ink">
                {repasse.interCodigoSolicitacao}
              </code>
            ),
          },
        ]
      : []),
    ...(repasse.transferAttempts > 0
      ? [
          {
            label: "tentativas",
            value: (
              <span className="font-mono text-[12px] tabular-nums text-ink-soft">
                {repasse.transferAttempts}
              </span>
            ),
          },
        ]
      : []),
    ...(repasse.lastTransferError !== null
      ? [
          {
            label: "último erro",
            value: (
              <span className="font-mono text-[12px] text-red-700">
                {repasse.lastTransferError}
              </span>
            ),
          },
        ]
      : []),
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
 * Cancelar modal — irreversible claim-release (spec §4.1)
 * --------------------------------------------------------------------- */

function ConfirmCancelarModal({
  repasse,
  onClose,
  onSuccess,
}: {
  repasse: RepasseDetail;
  onClose: () => void;
  onSuccess: (result: CancelarMutationResult) => void;
}) {
  const cancelar = useStubRepasseCancelar(onSuccess);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirmar cancelamento de repasse"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
        tabIndex={-1}
      />
      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-red-200 bg-paper shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-red-200 bg-red-50 px-5 py-3">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-700">
              cancelar repasse
            </p>
            <p className="font-mono text-[13px] text-red-900">
              Esta ação é irreversível
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar modal"
            className="-mr-2 -mt-1 rounded-md px-2 py-1 font-mono text-[16px] leading-none text-red-700 transition-colors hover:bg-paper"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-[13px] text-ink-soft">
            Cancelar este repasse devolve{" "}
            <span className="font-semibold text-ink">
              {repasse.numLancamentos} lançamento
              {repasse.numLancamentos === 1 ? "" : "s"}
            </span>{" "}
            ({formatBRL(repasse.amountCents)}) ao saldo do recebedor. O repasse
            fica marcado como <span className="font-mono">cancelado</span> em
            definitivo e{" "}
            <span className="font-semibold text-ink">não pode ser retomado</span>
            . O recebedor precisará solicitar um novo resgate.
          </p>
          <SummaryFacts repasse={repasse} />
          {cancelar.error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              {cancelar.error.message}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-cream-2/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={cancelar.isPending}
            className="rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft hover:text-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft disabled:opacity-50"
          >
            Voltar
          </button>
          <button
            type="button"
            onClick={() => cancelar.mutate({ idRepasse: repasse.idRepasse })}
            disabled={cancelar.isPending}
            className="inline-flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-red-800 transition-colors hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:opacity-50"
          >
            {cancelar.isPending ? "Cancelando…" : "Confirmar cancelamento"}
          </button>
        </div>
      </div>
    </div>
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
