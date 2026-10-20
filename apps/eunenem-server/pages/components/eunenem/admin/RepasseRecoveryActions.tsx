import { useState } from "react";
import { trpc } from "@/lib/trpc.js";
import type { RepasseDetail } from "./RepassesStubData.js";

export function ManualResolutionActions({ repasse }: { repasse: RepasseDetail }) {
  const [mode, setMode] = useState<"paid" | "retry" | null>(null);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [evidence, setEvidence] = useState("");
  const [amount, setAmount] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const utils = trpc.useUtils();
  const refresh = async () => {
    await Promise.all([utils.admin.repasses.show.invalidate(), utils.admin.repasses.list.invalidate()]);
  };
  const preview = trpc.admin.repasses.consultarRecuperacao.useMutation({
    onSuccess: (data) => { setPeriodStart(data.period.dataInicio); setPeriodEnd(data.period.dataFim); setConfirmed(false); },
  });
  const paid = trpc.admin.repasses.resolverManualPago.useMutation({ onSuccess: refresh });
  const retry = trpc.admin.repasses.recuperar.useMutation({ onSuccess: refresh });
  const busy = preview.isPending || paid.isPending || retry.isPending;
  const data = preview.data;
  const error = paid.error ?? retry.error ?? preview.error;
  const inputClass = "block w-full rounded border border-line bg-paper p-2";
  return <section className="space-y-3 rounded border border-rose-200 p-5" aria-label="Resolver repasse em verificação">
    <h2>Resolver repasse em verificação</h2>
    <p>Nenhuma consulta envia dinheiro. Confira o extrato antes de confirmar.</p>
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={busy} onClick={() => { setMode("paid"); setConfirmed(false); }}>Confirmei que saiu</button>
      <button type="button" disabled={busy} onClick={() => {
        setMode("retry"); setDismissed([]); setConfirmed(false);
        preview.mutate({ idRepasse: repasse.idRepasse });
      }}>Confirmei que NÃO saiu</button>
    </div>
    {mode && <>
      <label>Motivo obrigatório<textarea className={inputClass} value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} /></label>
      {mode === "paid" ? <label>Referência bancária<input className={inputClass} value={reference} onChange={e => setReference(e.target.value)} maxLength={255} /></label> : <>
        {preview.isPending && <p role="status">Consultando o Inter…</p>}
        {data && <div className="space-y-2">
          <p>Consulta: {data.lookup}. Extrato: {data.statementAvailable ? "consultado" : "indisponível; confira externamente"}.
            Período: {data.period.dataInicio} a {data.period.dataFim}.</p>
          {data.candidates.map((candidate, index) => <label className="block" key={candidate.e2eId ?? index}>
            {candidate.e2eId ?? "Sem E2E"} — {candidate.destination === "matches" ? "destino compatível" : candidate.destination === "unknown" ? "destino não identificado" : "outro destinatário"}
            {candidate.destination === "different" && candidate.e2eId && <input type="checkbox"
              aria-label={`Descartar ${candidate.e2eId}`} checked={dismissed.includes(candidate.e2eId)}
              onChange={e => setDismissed(e.target.checked ? [...dismissed, candidate.e2eId!] : dismissed.filter(id => id !== candidate.e2eId))} />}
          </label>)}
          {data.decision === "blocked" ? <p role="alert">Reenvio bloqueado: pagamento existente ou débito sem destino verificável. Não há exceção manual.</p> :
            data.decision === "manual_attestation" ? <>
              <p>A consulta é inconclusiva. Atesto que conferi o extrato e que nenhum pagamento deste repasse saiu.</p>
              <label>Evidência do extrato<textarea className={inputClass} value={evidence} onChange={e => setEvidence(e.target.value)} maxLength={2000} /></label>
              <label>Período conferido — início<input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} /></label>
              <label>Fim<input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} /></label>
              <label>Digite o valor em reais ({(data.amountCents / 100).toFixed(2)})<input className={inputClass} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label>
            </> : <p>Inter retornou negativa definitiva; nenhuma saída compatível no extrato.</p>}
        </div>}
      </>}
      <label className="block"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Confirmo esta ação e seu registro no histórico.</label>
      <button type="button" disabled={busy || !confirmed || reason.trim().length < 10 ||
        (mode === "paid" ? !reference.trim() : !data || data.decision === "blocked")}
        onClick={() => {
          if (mode === "paid") paid.mutate({ idRepasse: repasse.idRepasse, codigoSolicitacao: reference, motivo: reason });
          else if (data) retry.mutate({
            idRepasse: repasse.idRepasse, motivo: reason, evidenceDigest: data.evidenceDigest,
            expectedTransferAttempts: data.expectedTransferAttempts,
            ...(data.decision === "manual_attestation" ? { attestation: {
              evidence, periodStart, periodEnd, confirmedAmountCents: Math.round(Number(amount.replace(",", ".")) * 100),
              dismissedE2Es: dismissed,
            } } : {}),
          });
        }}>{busy ? "Aguarde…" : mode === "paid" ? "Confirmar como pago" : "Autorizar uma nova tentativa"}</button>
    </>}
    {error && <p role="alert" className="text-red-700">{error.message}</p>}
    {(paid.isSuccess || retry.isSuccess) && <p role="status">Resolução registrada; estado atualizado.</p>}
  </section>;
}
