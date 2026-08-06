// aperture-4uvgf — the admin refund surface (UI half of B6's estorno
// machinery; spec §10.6 requires this walkable for BOTH provenances).
//
// Renders inside PagamentoCard, after the Financeiro block: the money data
// reads first, the money ACTION sits under it. Three faces:
//
//   aprovado   → "estornar pagamento" trigger (red admin idiom) opening a
//                confirm modal — irreversibility acknowledgment checkbox
//                gates the confirm (mirrors the repasse falhou modal's
//                double-pay guard), Stripe-only reason select, inline
//                error mapping for every code the wrapper mutation emits.
//   just fired → result strip showing the ACTUAL refund status returned by
//                estornarPagamento: 'aceito' (Stripe, sync) lands emerald;
//                'em_processamento' (Inter, async) lands amber and the
//                devolução poll takes over until the webhook finalizes.
//   estornado  → compact confirmation strip; Inter payments also surface
//                the persisted devolução record (status/rtrId).
//
// Money-safety note: this component holds ZERO refund rules. The 409
// lançamento gate, status guard, provenance routing and replay semantics
// all live in the estornarPagamento use-case; the mutation is a thin
// adminProcedure wrapper (Cipher checklist #5 — no new money-out
// semantics, only the allowlist gate in front of the existing one).

import { useState } from "react";
import {
  useDevolucaoStatus,
  useEstornarPagamento,
  type EstornoReason,
} from "./pagamentosActions.js";
import type { PagamentoDTO } from "./PagamentosList.js";
import { formatBRL } from "@/lib/formatBRL.js";

const REASON_LABELS: Record<EstornoReason, string> = {
  requested_by_customer: "solicitado pelo contribuinte",
  duplicate: "pagamento duplicado",
  fraudulent: "fraude",
};

function errorCopy(message: string): string {
  switch (message) {
    case "pagamento_nao_encontrado":
      return "pagamento não encontrado.";
    case "pagamento_status_invalido":
      return "só pagamentos aprovados podem ser estornados.";
    case "lancamento_ja_transferido":
      return "estorno bloqueado: o repasse deste pagamento já foi transferido ao recebedor.";
    case "estorno_recusado_pelo_provedor":
      return "o provedor recusou o estorno — verifique no painel do provedor antes de tentar de novo.";
    case "devolucao_nao_realizada":
    case "devolucao_rejeitada":
      return "a devolução PIX não foi realizada pelo banco (terminal). Investigue o registro antes de qualquer nova tentativa.";
    case "devolucao_vinculo_invalido":
      return "inconsistência no vínculo da devolução — investigue antes de tentar de novo.";
    default:
      return message;
  }
}

const DEVOLUCAO_BADGE: Record<
  "em_processamento" | "devolvida" | "nao_realizada" | "rejeitada",
  { label: string; classes: string }
> = {
  em_processamento: {
    label: "devolução em processamento",
    classes: "border-amber-300 bg-amber-50 text-amber-800",
  },
  devolvida: {
    label: "devolução concluída",
    classes: "border-emerald-300 bg-emerald-50 text-emerald-800",
  },
  nao_realizada: {
    label: "devolução não realizada",
    classes: "border-red-300 bg-red-50 text-red-800",
  },
  rejeitada: {
    label: "devolução rejeitada",
    classes: "border-red-300 bg-red-50 text-red-800",
  },
};

export function EstornoBlock({ pagamento }: { pagamento: PagamentoDTO }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState<EstornoReason>("requested_by_customer");

  const estornar = useEstornarPagamento();
  const provedor = pagamento.transacaoExterna?.provedor ?? "stripe";
  const isInter = provedor === "inter";

  // Inter devoluções are async — watch the persisted record. Self-limiting:
  // the poll only continues while em_processamento (see the hook).
  const devolucao = useDevolucaoStatus(pagamento.id, {
    enabled: isInter && (pagamento.status === "aprovado" || pagamento.status === "estornado"),
  });
  const devolucaoRecord = devolucao.data?.devolucao ?? null;

  const refundable = pagamento.status === "aprovado";
  const estornado = pagamento.status === "estornado";

  if (!refundable && !estornado) return null;

  const onConfirm = () => {
    estornar.mutate(
      {
        idPagamento: pagamento.id,
        ...(isInter ? {} : { reason }),
      },
      {
        onSuccess: () => {
          setModalOpen(false);
          setAck(false);
        },
      },
    );
  };

  const errorMessage = estornar.error ? errorCopy(estornar.error.message) : null;

  return (
    <div className="space-y-2 border-t border-line pt-4" data-testid="estorno-block">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
          estorno
        </span>

        {estornado || estornar.data ? (
          <EstornoResultStrip
            refundStatus={estornar.data?.refundStatus ?? null}
            estornado={estornado}
            devolucaoStatus={devolucaoRecord?.status ?? null}
          />
        ) : (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-red-800 transition-colors hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:opacity-50"
          >
            estornar pagamento
          </button>
        )}
      </div>

      {/* Persisted devolução detail (Inter) — the async trail the webhook
          finalizes. Rendered whenever a record exists, terminal or not. */}
      {devolucaoRecord && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-soft">
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 uppercase tracking-[0.1em] ${DEVOLUCAO_BADGE[devolucaoRecord.status].classes}`}
          >
            {DEVOLUCAO_BADGE[devolucaoRecord.status].label}
          </span>
          {devolucaoRecord.rtrId && <span>rtrId {devolucaoRecord.rtrId}</span>}
        </div>
      )}

      {/* Post-fire error surface (also shown when the modal closed). */}
      {errorMessage && !modalOpen && (
        <p role="alert" className="font-mono text-[11px] text-red-700">
          {errorMessage}
        </p>
      )}

      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar estorno de pagamento"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
            onClick={() => !estornar.isPending && setModalOpen(false)}
          />
          <div className="relative w-full max-w-md space-y-4 rounded-lg border border-line bg-paper p-6 shadow-lg">
            <h4 className="font-mono text-[13px] uppercase tracking-[0.14em] text-ink">
              confirmar estorno
            </h4>
            <p className="text-[13px] leading-relaxed text-ink-soft">
              Devolver{" "}
              <strong className="font-mono tabular-nums text-ink">
                {formatBRL(pagamento.intencao.amountCents)}
              </strong>{" "}
              ao contribuinte via{" "}
              <strong className="uppercase">{isInter ? "devolução PIX (Inter)" : "Stripe"}</strong>
              .{" "}
              {isInter
                ? "A devolução é assíncrona: entra em processamento agora e o banco confirma em seguida."
                : "O reembolso é enviado ao Stripe imediatamente."}
            </p>

            {!isInter && (
              <label className="block space-y-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
                  motivo (stripe)
                </span>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as EstornoReason)}
                  className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink"
                >
                  {(Object.keys(REASON_LABELS) as EstornoReason[]).map((r) => (
                    <option key={r} value={r}>
                      {REASON_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Irreversibility acknowledgment — gates the confirm (mirrors
                the repasse falhou modal's double-pay guard). */}
            <label className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-soft">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Entendo que o estorno devolve o dinheiro ao contribuinte e{" "}
                <strong className="text-ink">não pode ser desfeito</strong>.
              </span>
            </label>

            {errorMessage && (
              <p
                role="alert"
                className="rounded-md border border-red-300 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-800"
              >
                {errorMessage}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                disabled={estornar.isPending}
                className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-stone-50 px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-stone-700 transition-colors hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-300 disabled:opacity-50"
              >
                cancelar
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={!ack || estornar.isPending}
                className="inline-flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-red-800 transition-colors hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:opacity-50"
              >
                {estornar.isPending ? "estornando…" : "confirmar estorno"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The truth strip: what the refund ACTUALLY did. 'aceito' is Stripe's
 * synchronous done; 'em_processamento' is Inter's honest async pending
 * (the devolução badge above tracks it to terminal); 'devolvida' is
 * Inter's verified completion. An already-estornado card with no fresh
 * mutation shows the settled state.
 */
function EstornoResultStrip({
  refundStatus,
  estornado,
  devolucaoStatus,
}: {
  refundStatus: "aceito" | "em_processamento" | "devolvida" | null;
  estornado: boolean;
  devolucaoStatus: "em_processamento" | "devolvida" | "nao_realizada" | "rejeitada" | null;
}) {
  const pendingInter = refundStatus === "em_processamento" && devolucaoStatus !== "devolvida";
  const label = pendingInter
    ? "estorno solicitado — aguardando o banco"
    : "pagamento estornado";
  const classes = pendingInter
    ? "border-amber-300 bg-amber-50 text-amber-800"
    : "border-emerald-300 bg-emerald-50 text-emerald-800";
  // estornado-without-fresh-mutation: settled long ago, render settled.
  const settled = estornado && refundStatus === null;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] ${settled ? "border-emerald-300 bg-emerald-50 text-emerald-800" : classes}`}
      data-testid="estorno-result"
    >
      {settled ? "pagamento estornado" : label}
    </span>
  );
}
