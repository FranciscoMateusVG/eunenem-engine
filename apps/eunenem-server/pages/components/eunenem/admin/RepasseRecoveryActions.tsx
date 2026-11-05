import { type ReactNode, useId, useState } from 'react';
import { trpc } from '@/lib/trpc.js';
import type { RepasseDetail } from './RepassesStubData.js';

const BUTTON_BASE =
  'inline-flex cursor-pointer items-center gap-2 rounded-md border px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50';
const BUTTON_VARIANTS = {
  primary:
    'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 focus:ring-emerald-300',
  warning:
    'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 focus:ring-amber-300',
  neutral:
    'border-stone-300 bg-stone-50 text-stone-700 hover:bg-stone-100 focus:ring-stone-300',
} as const;

/**
 * A real, visibly styled button. When `disabled`, `hint` explains what is
 * missing so the operator never faces an unexplained dead control.
 */
export function RecoveryActionButton({
  variant,
  disabled,
  hint,
  onClick,
  children,
}: {
  variant: keyof typeof BUTTON_VARIANTS;
  disabled: boolean;
  hint?: string | null | undefined;
  onClick: () => void;
  children: ReactNode;
}) {
  const hintId = useId();
  const showHint = disabled && Boolean(hint);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-describedby={showHint ? hintId : undefined}
        className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]}`}
      >
        {children}
      </button>
      {showHint && (
        <span id={hintId} className="text-[12px] text-stone-600">
          {hint}
        </span>
      )}
    </span>
  );
}

/** First reason the final confirm button is disabled, or null when it is enabled. */
export function motivoBloqueioConfirmacao(args: {
  busy: boolean;
  confirmed: boolean;
  reason: string;
  mode: 'paid' | 'retry';
  reference: string;
  hasPreview: boolean;
  decision?: string | undefined;
}): string | null {
  if (args.busy) return 'Aguarde a operação em andamento.';
  if (args.mode === 'retry' && !args.hasPreview)
    return 'Aguarde a consulta ao Inter terminar para liberar a nova tentativa.';
  if (args.mode === 'retry' && args.decision === 'blocked')
    return 'Reenvio bloqueado pela consulta: já existe pagamento ou o destino não é verificável.';
  if (args.mode === 'paid' && !args.reference.trim())
    return 'Informe a referência bancária da transferência.';
  if (args.reason.trim().length < 10) return 'Descreva o motivo (mínimo de 10 caracteres).';
  if (!args.confirmed) return 'Marque "Confirmo esta ação" para continuar.';
  return null;
}

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
  const bloqueioConfirmacao = mode
    ? motivoBloqueioConfirmacao({
        busy,
        confirmed,
        reason,
        mode,
        reference,
        hasPreview: Boolean(data),
        decision: data?.decision,
      })
    : null;
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
        <RecoveryActionButton
          variant="primary"
          disabled={busy}
          hint={busy ? 'Aguarde a operação em andamento.' : null}
          onClick={() => {
            setMode('paid');
            setConfirmed(false);
          }}
        >
          Confirmei que saiu
        </RecoveryActionButton>
        <RecoveryActionButton
          variant="warning"
          disabled={busy}
          hint={busy ? 'Aguarde a operação em andamento.' : null}
          onClick={() => {
            setMode('retry');
            setDismissed([]);
            setConfirmed(false);
            preview.mutate({ idRepasse: repasse.idRepasse });
          }}
        >
          Confirmei que NÃO saiu
        </RecoveryActionButton>
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
          <RecoveryActionButton
            variant={mode === 'paid' ? 'primary' : 'warning'}
            disabled={bloqueioConfirmacao !== null}
            hint={bloqueioConfirmacao}
            onClick={() => setConfirmationOpen(true)}
          >
            {busy
              ? 'Aguarde…'
              : mode === 'paid'
                ? 'Confirmar como pago'
                : 'Autorizar uma nova tentativa'}
          </RecoveryActionButton>
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
          <RecoveryActionButton variant="neutral" disabled={busy} onClick={onClose}>
            Voltar
          </RecoveryActionButton>
          <RecoveryActionButton
            variant={mode === 'paid' ? 'primary' : 'warning'}
            disabled={busy || reason.trim().length < 10 || (mode === 'paid' && !reference.trim())}
            hint={
              busy
                ? 'Aguarde a operação em andamento.'
                : 'Motivo (mín. 10 caracteres)' + (mode === 'paid' ? ' e referência bancária são obrigatórios.' : ' é obrigatório.')
            }
            onClick={onConfirm}
          >
            {busy ? 'Confirmando…' : 'Confirmar definitivamente'}
          </RecoveryActionButton>
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
      <RecoveryActionButton variant="neutral" disabled={false} onClick={onRefresh}>
        Atualizar
      </RecoveryActionButton>
    </div>
  );
}

/** "45,00" / "45.00" → cents, or null when it is not a valid amount. */
function parseReaisToCents(value: string): number | null {
  const normalized = value.trim().replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

/** First reason the "Enviar pelo Inter agora" button is disabled, or null when enabled. */
export function motivoBloqueioReenvio(args: {
  busy: boolean;
  reason: string;
  typedAmount: string;
  amountCents: number;
  attested: boolean;
}): string | null {
  if (args.busy) return 'Aguarde a operação em andamento.';
  if (args.reason.trim().length < 10) return 'Descreva o motivo (mínimo de 10 caracteres).';
  if (parseReaisToCents(args.typedAmount) !== args.amountCents)
    return 'Digite o valor exato do repasse em reais para confirmar.';
  if (!args.attested) return 'Marque que conferiu o extrato e que o repasse não foi pago por fora.';
  return null;
}

/**
 * aperture-mno2s — "Enviar pelo Inter agora": only for a conta repasse that
 * the old manual approval marked transferido although nothing was sent. The
 * server re-checks eligibility and the Inter extrato; this is the operator side.
 */
export function ReenvioPeloInterActions({
  repasse,
}: {
  repasse: Pick<RepasseDetail, 'idRepasse' | 'amountCents'>;
}) {
  const [reason, setReason] = useState('');
  const [typedAmount, setTypedAmount] = useState('');
  const [attested, setAttested] = useState(false);
  const utils = trpc.useUtils();
  const send = trpc.admin.repasses.reenviarPeloInter.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.admin.repasses.show.invalidate(),
        utils.admin.repasses.list.invalidate(),
      ]);
    },
  });
  const bloqueio = motivoBloqueioReenvio({
    busy: send.isPending,
    reason,
    typedAmount,
    amountCents: repasse.amountCents,
    attested,
  });
  const inputClass = 'block w-full rounded border border-line bg-paper p-2';
  return (
    <section
      className="space-y-3 rounded border border-rose-300 bg-rose-50 p-5"
      aria-label="Enviar pelo Inter agora"
    >
      <h2>Enviar pelo Inter agora</h2>
      <p role="alert" className="font-semibold text-rose-800">
        Atenção: este repasse foi aprovado e marcado como transferido, mas nenhum envio automático
        foi feito. Se ele já foi pago por fora, enviar de novo vai pagar duas vezes — confirme no
        extrato do Inter que nenhum PIX para este recebedor foi feito antes de continuar. O sistema
        também consulta o extrato e bloqueia o envio se achar um débito compatível.
      </p>
      <label className="block">
        Motivo obrigatório
        <textarea
          className={inputClass}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
        />
      </label>
      <label className="block">
        Digite o valor do repasse em reais ({(repasse.amountCents / 100).toFixed(2).replace('.', ',')})
        <input
          className={inputClass}
          inputMode="decimal"
          value={typedAmount}
          onChange={(e) => setTypedAmount(e.target.value)}
        />
      </label>
      <label className="block">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />{' '}
        Conferi o extrato e este repasse não foi pago por fora.
      </label>
      <RecoveryActionButton
        variant="warning"
        disabled={bloqueio !== null}
        hint={bloqueio}
        onClick={() => {
          const valorDigitadoCents = parseReaisToCents(typedAmount);
          if (valorDigitadoCents === null) return;
          send.mutate({
            idRepasse: repasse.idRepasse,
            motivo: reason,
            valorDigitadoCents,
            atestado: true,
          });
        }}
      >
        {send.isPending ? 'Enviando…' : 'Enviar pelo Inter agora'}
      </RecoveryActionButton>
      {send.error && (
        <p role="alert" className="text-red-700">
          {send.error.message}
        </p>
      )}
    </section>
  );
}
