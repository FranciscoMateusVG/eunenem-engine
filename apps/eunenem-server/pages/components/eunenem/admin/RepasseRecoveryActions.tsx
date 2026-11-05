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

/** Short Portuguese message for an admin; never raw Zod/JSON text. */
export function mensagemErroAdmin(message: string | undefined | null): string {
  const text = (message ?? '').trim();
  if (!text || /^[[{]/.test(text) || /"(code|path|expected|received)"/.test(text))
    return 'Não foi possível concluir a ação. Confira os dados e tente novamente.';
  return text;
}

export function ManualResolutionActions({ repasse }: { repasse: RepasseDetail }) {
  const [dialog, setDialog] = useState<'paid' | 'retry' | null>(null);
  const [resolvedElsewhere, setResolvedElsewhere] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const refresh = async () => {
    await Promise.all([
      utils.admin.repasses.show.invalidate(),
      utils.admin.repasses.list.invalidate(),
    ]);
  };
  const afterResolution = async (status: string, expected: string) => {
    setDialog(null);
    if (status !== expected) setResolvedElsewhere(status);
    else await refresh();
  };
  const paid = trpc.admin.repasses.resolverManualPago.useMutation({
    onSuccess: (result) => afterResolution(result.status, 'pago'),
  });
  const retry = trpc.admin.repasses.recuperar.useMutation({
    onSuccess: (result) => afterResolution(result.status, 'aprovado'),
  });
  const busy = paid.isPending || retry.isPending;
  const error = paid.error ?? retry.error;
  if (resolvedElsewhere)
    return <RecoveryResolvedElsewhere status={resolvedElsewhere} onRefresh={refresh} />;
  return (
    <section
      className="space-y-3 rounded border border-rose-200 p-5"
      aria-label="Resolver repasse em verificação"
    >
      <h2>Resolver repasse em verificação</h2>
      {repasse.searchCandidates.length > 0 && (
        <details open>
          <summary>Candidatos no extrato (informativo)</summary>
          <table className="w-full text-left">
            <thead>
              <tr>
                <th>Código</th>
                <th>Valor</th>
                <th>Data</th>
                <th>Chave mascarada</th>
              </tr>
            </thead>
            <tbody>
              {repasse.searchCandidates.map((candidate) => (
                <tr key={candidate.codigoSolicitacao}>
                  <td>{candidate.codigoSolicitacao}</td>
                  <td>{(candidate.valorCents / 100).toFixed(2)}</td>
                  <td>{candidate.dataMovimento ?? 'Não informada'}</td>
                  <td>{candidate.chaveMascarada ?? 'Não informada'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="flex flex-wrap gap-3">
        <RecoveryActionButton variant="warning" disabled={busy} onClick={() => setDialog('retry')}>
          Tentar de novo
        </RecoveryActionButton>
        <RecoveryActionButton variant="primary" disabled={busy} onClick={() => setDialog('paid')}>
          Confirmei que saiu
        </RecoveryActionButton>
      </div>
      {dialog && (
        <RecoveryConfirmation
          mode={dialog}
          amountCents={repasse.amountCents}
          busy={busy}
          error={error ? mensagemErroAdmin(error.message) : undefined}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            if (dialog === 'paid') paid.mutate({ idRepasse: repasse.idRepasse });
            else retry.mutate({ idRepasse: repasse.idRepasse });
          }}
        />
      )}
      {error && !dialog && (
        <p role="alert" className="text-red-700">
          {mensagemErroAdmin(error.message)}
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
  busy,
  error,
  onConfirm,
  onClose,
}: {
  mode: 'paid' | 'retry';
  amountCents: number;
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
        <h2>{mode === 'paid' ? 'Confirmei que saiu' : 'Tentar de novo'}</h2>
        <p>
          Valor:{' '}
          {(amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
        </p>
        {mode === 'paid' ? (
          <p>Tem certeza? O repasse será marcado como pago.</p>
        ) : (
          <p>Tem certeza? Se o PIX anterior tiver saído, o recebedor recebe duas vezes.</p>
        )}
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
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Confirmando…' : 'Confirmar'}
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

/**
 * aperture-mno2s — "Enviar pelo Inter agora": only for a conta repasse that
 * the old manual approval marked transferido although nothing was sent.
 * aperture-puali — one button + one confirmation; the extrato is info only.
 */
export function ReenvioPeloInterActions({
  repasse,
}: {
  repasse: Pick<RepasseDetail, 'idRepasse' | 'amountCents'>;
}) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const extrato = trpc.admin.repasses.candidatosReenvio.useQuery(
    { idRepasse: repasse.idRepasse },
    { retry: false },
  );
  const send = trpc.admin.repasses.reenviarPeloInter.useMutation({
    onSuccess: async () => {
      setOpen(false);
      await Promise.all([
        utils.admin.repasses.show.invalidate(),
        utils.admin.repasses.list.invalidate(),
      ]);
    },
  });
  const candidatos = extrato.data?.candidatos ?? [];
  return (
    <section
      className="space-y-3 rounded border border-rose-300 bg-rose-50 p-5"
      aria-label="Enviar pelo Inter agora"
    >
      <h2>Enviar pelo Inter agora</h2>
      <p>
        Este repasse foi aprovado e marcado como transferido, mas nenhum envio automático foi feito.
      </p>
      {candidatos.length > 0 && (
        <div role="note">
          <p>Débitos no extrato que podem ser este repasse (informativo):</p>
          <ul>
            {candidatos.map((c, i) => (
              <li key={c.e2eId ?? i}>
                {c.e2eId ?? 'sem E2E'} — R$ {(c.valorCents / 100).toFixed(2).replace('.', ',')} em{' '}
                {c.dataMovimento ?? 'data não informada'}
              </li>
            ))}
          </ul>
        </div>
      )}
      <RecoveryActionButton
        variant="warning"
        disabled={send.isPending}
        onClick={() => setOpen(true)}
      >
        Enviar pelo Inter agora
      </RecoveryActionButton>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar envio pelo Inter"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-lg space-y-4 rounded bg-paper p-6 shadow-xl">
            <h2>Enviar pelo Inter agora</h2>
            <p>
              Valor:{' '}
              {(repasse.amountCents / 100).toLocaleString('pt-BR', {
                style: 'currency',
                currency: 'BRL',
              })}
            </p>
            <p>Tem certeza? Se o PIX anterior tiver saído, o recebedor recebe duas vezes.</p>
            {send.error && (
              <p role="alert" className="text-red-700">
                {mensagemErroAdmin(send.error.message)}
              </p>
            )}
            <div className="flex gap-3">
              <RecoveryActionButton
                variant="neutral"
                disabled={send.isPending}
                onClick={() => setOpen(false)}
              >
                Voltar
              </RecoveryActionButton>
              <RecoveryActionButton
                variant="warning"
                disabled={send.isPending}
                onClick={() => send.mutate({ idRepasse: repasse.idRepasse })}
              >
                {send.isPending ? 'Enviando…' : 'Confirmar'}
              </RecoveryActionButton>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
