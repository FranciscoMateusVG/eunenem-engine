import { useState } from 'react';
import { trpc } from '@/lib/trpc.js';
import type { RepasseDetail } from './RepassesStubData.js';

export function ManualResolutionActions({ repasse }: { repasse: RepasseDetail }) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [resolvedElsewhere, setResolvedElsewhere] = useState<string | null>(null);
  const [mode, setMode] = useState<'paid' | 'retry' | null>(null);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [evidence, setEvidence] = useState('');
  const [amount, setAmount] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const utils = trpc.useUtils();
  const refresh = async () => {
    await Promise.all([
      utils.admin.repasses.show.invalidate(),
      utils.admin.repasses.list.invalidate(),
    ]);
  };
  const preview = trpc.admin.repasses.consultarRecuperacao.useMutation({
    onSuccess: (data) => {
      setPeriodStart(data.period.dataInicio);
      setPeriodEnd(data.period.dataFim);
      setConfirmed(false);
    },
  });
  const afterResolution = async (status: string, expected: string) => {
    setConfirmationOpen(false);
    if (status !== expected) setResolvedElsewhere(status);
    else await refresh();
  };
  const paid = trpc.admin.repasses.resolverManualPago.useMutation({
    onSuccess: (result) => afterResolution(result.status, 'pago'),
  });
  const retry = trpc.admin.repasses.recuperar.useMutation({
    onSuccess: (result) => afterResolution(result.status, 'aprovado'),
  });
  const busy = preview.isPending || paid.isPending || retry.isPending;
  const data = preview.data;
  const error = paid.error ?? retry.error ?? preview.error;
  const inputClass = 'block w-full rounded border border-line bg-paper p-2';
  if (resolvedElsewhere)
    return <RecoveryResolvedElsewhere status={resolvedElsewhere} onRefresh={refresh} />;
  return (
    <section
      className="space-y-3 rounded border border-rose-200 p-5"
      aria-label="Resolver repasse em verificação"
    >
      <h2>Resolver repasse em verificação</h2>
      {repasse.searchCandidates.length > 0 && <details open>
        <summary>Candidatos históricos — não substituem a nova consulta ao Inter</summary>
        <table className="w-full text-left"><thead><tr><th>Código</th><th>Valor</th><th>Data</th><th>Chave mascarada</th></tr></thead>
          <tbody>{repasse.searchCandidates.map(candidate => <tr key={candidate.codigoSolicitacao}>
            <td>{candidate.codigoSolicitacao}</td><td>{(candidate.valorCents / 100).toFixed(2)}</td>
            <td>{candidate.dataMovimento ?? 'Não informada'}</td><td>{candidate.chaveMascarada ?? 'Não informada'}</td>
          </tr>)}</tbody></table>
      </details>}
      <p>Nenhuma consulta envia dinheiro. Confira o extrato antes de confirmar.</p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setMode('paid');
            setConfirmed(false);
          }}
        >
          Confirmei que saiu
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setMode('retry');
            setDismissed([]);
            setConfirmed(false);
            preview.mutate({ idRepasse: repasse.idRepasse });
          }}
        >
          Confirmei que NÃO saiu
        </button>
      </div>
      {mode && (
        <>
          <label>
            Motivo obrigatório
            <textarea
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
            />
          </label>
          {mode === 'paid' ? (
            <label>
              Referência bancária
              <input
                className={inputClass}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={255}
              />
            </label>
          ) : (
            <>
              {preview.isPending && <p role="status">Consultando o Inter…</p>}
              {data && (
                <div className="space-y-2">
                  <p>
                    Consulta: {data.lookup}. Extrato:{' '}
                    {data.statementAvailable ? 'consultado' : 'indisponível; confira externamente'}.
                    Período: {data.period.dataInicio} a {data.period.dataFim}.
                  </p>
                  <RecoveryCandidatesTable candidates={data.candidates} />
                  {data.candidates.map((candidate, index) => (
                    <label className="block" key={candidate.e2eId ?? index}>
                      {candidate.e2eId ?? 'Sem E2E'} —{' '}
                      {candidate.destination === 'matches'
                        ? 'destino compatível'
                        : candidate.destination === 'unknown'
                          ? 'destino não identificado'
                          : 'outro destinatário'}
                      {candidate.destination === 'different' && candidate.e2eId && (
                        <input
                          type="checkbox"
                          aria-label={`Descartar ${candidate.e2eId}`}
                          checked={dismissed.includes(candidate.e2eId)}
                          onChange={(e) =>
                            setDismissed(
                              e.target.checked
                                ? [...dismissed, candidate.e2eId ?? '']
                                : dismissed.filter((id) => id !== candidate.e2eId),
                            )
                          }
                        />
                      )}
                    </label>
                  ))}
                  {data.decision === 'blocked' ? (
                    <p role="alert">
                      Reenvio bloqueado: pagamento existente ou débito sem destino verificável. Não
                      há exceção manual.
                    </p>
                  ) : data.decision === 'manual_attestation' ? (
                    <>
                      <p>
                        A consulta é inconclusiva. Atesto que conferi o extrato e que nenhum
                        pagamento deste repasse saiu.
                      </p>
                      <label>
                        Evidência do extrato
                        <textarea
                          className={inputClass}
                          value={evidence}
                          onChange={(e) => setEvidence(e.target.value)}
                          maxLength={2000}
                        />
                      </label>
                      <label>
                        Período conferido — início
                        <input
                          type="date"
                          value={periodStart}
                          onChange={(e) => setPeriodStart(e.target.value)}
                        />
                      </label>
                      <label>
                        Fim
                        <input
                          type="date"
                          value={periodEnd}
                          onChange={(e) => setPeriodEnd(e.target.value)}
                        />
                      </label>
                      <label>
                        Digite o valor em reais ({(data.amountCents / 100).toFixed(2)})
                        <input
                          className={inputClass}
                          inputMode="decimal"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                        />
                      </label>
                    </>
                  ) : (
                    <p>Inter retornou negativa definitiva; nenhuma saída compatível no extrato.</p>
                  )}
                </div>
              )}
            </>
          )}
          <label className="block">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            Confirmo esta ação e seu registro no histórico.
          </label>
          <button
            type="button"
            disabled={
              busy ||
              !confirmed ||
              reason.trim().length < 10 ||
              (mode === 'paid' ? !reference.trim() : !data || data.decision === 'blocked')
            }
            onClick={() => setConfirmationOpen(true)}
          >
            {busy
              ? 'Aguarde…'
              : mode === 'paid'
                ? 'Confirmar como pago'
                : 'Autorizar uma nova tentativa'}
          </button>
        </>
      )}
      {confirmationOpen && mode && (
        <RecoveryConfirmation
          mode={mode}
          amountCents={repasse.amountCents}
          reference={reference}
          reason={reason}
          busy={busy}
          error={error?.message}
          onClose={() => setConfirmationOpen(false)}
          onConfirm={() => {
            if (mode === 'paid')
              paid.mutate({
                idRepasse: repasse.idRepasse,
                codigoSolicitacao: reference,
                motivo: reason,
              });
            else if (data)
              retry.mutate({
                idRepasse: repasse.idRepasse,
                motivo: reason,
                evidenceDigest: data.evidenceDigest,
                expectedTransferAttempts: data.expectedTransferAttempts,
                ...(data.decision === 'manual_attestation'
                  ? {
                      attestation: {
                        evidence,
                        periodStart,
                        periodEnd,
                        confirmedAmountCents: Math.round(Number(amount.replace(',', '.')) * 100),
                        dismissedE2Es: dismissed,
                      },
                    }
                  : {}),
              });
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error.message}
        </p>
      )}
    </section>
  );
}

export function RecoveryCandidatesTable({
  candidates,
}: {
  candidates: readonly {
    e2eId: string | null;
    amountCents?: number;
    dataMovimento?: string | null;
    destination: 'matches' | 'different' | 'unknown';
  }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption>Débitos candidatos no extrato — confira antes de atestar</caption>
        <thead>
          <tr>
            {['E2E', 'Valor', 'Data', 'Destino'].map((title) => (
              <th className="border p-2" key={title}>
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {candidates.length === 0 ? (
            <tr>
              <td colSpan={4}>
                Nenhum débito candidato retornado; isso sozinho não comprova ausência de pagamento.
              </td>
            </tr>
          ) : (
            candidates.map((candidate, index) => (
              <tr key={candidate.e2eId ?? index}>
                <td className="border p-2">{candidate.e2eId ?? 'Sem E2E'}</td>
                <td className="border p-2">
                  {candidate.amountCents === undefined
                    ? 'Não informado'
                    : (candidate.amountCents / 100).toLocaleString('pt-BR', {
                        style: 'currency',
                        currency: 'BRL',
                      })}
                </td>
                <td className="border p-2">{candidate.dataMovimento ?? 'Não informada'}</td>
                <td className="border p-2">
                  {candidate.destination === 'matches'
                    ? 'destino compatível'
                    : candidate.destination === 'unknown'
                      ? 'destino não identificado'
                      : 'outro destinatário'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function RecoveryConfirmation({
  mode,
  amountCents,
  reference,
  reason,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  mode: 'paid' | 'retry';
  amountCents: number;
  reference: string;
  reason: string;
  busy: boolean;
  error?: string | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'paid' ? 'Confirmar pagamento manual' : 'Confirmar nova tentativa'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="max-h-[85vh] w-full max-w-lg space-y-4 overflow-auto rounded bg-paper p-6 shadow-xl">
        <h2>{mode === 'paid' ? 'Confirmei que saiu' : 'Confirmei que NÃO saiu'}</h2>
        <p>
          Valor:{' '}
          {(amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
        </p>
        {mode === 'paid' ? (
          <p>
            Referência bancária obrigatória: {reference}. Confirmo que este pagamento chegou ao
            recebedor.
          </p>
        ) : (
          <p>
            Autorizo uma única nova tentativa após conferir o extrato. Um atestado incorreto pode
            pagar duas vezes.
          </p>
        )}
        <p>Motivo: {reason}</p>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <button type="button" disabled={busy} onClick={onClose}>
            Voltar
          </button>
          <button
            type="button"
            disabled={busy || reason.trim().length < 10 || (mode === 'paid' && !reference.trim())}
            onClick={onConfirm}
          >
            {busy ? 'Confirmando…' : 'Confirmar definitivamente'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RecoveryResolvedElsewhere({
  status,
  onRefresh,
}: {
  status: string;
  onRefresh: () => void;
}) {
  return (
    <div role="status">
      <p>
        Repasse já resolvido por outra ação. Estado atual: {status}. Nenhuma alteração foi feita por
        esta confirmação.
      </p>
      <button type="button" onClick={onRefresh}>
        Atualizar
      </button>
    </div>
  );
}
