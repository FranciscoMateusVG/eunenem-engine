import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseJobEnqueuer } from '../../../adapters/pagamentos/transferencia-enqueuer.js';
import type { TransferenciaProvider } from '../../../adapters/pagamentos/transferencia-provider.js';
import type { IdRepasse } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';
import {
  classifyDestination,
  decideManualRecovery,
  type RecoveryEvidence,
} from './manual-recovery-policy.js';

export interface RecoveryDeps {
  livroFinanceiroRepository: LivroFinanceiroRepository;
  transferenciaProvider: TransferenciaProvider;
  clock: () => Date;
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('recovery_lookup_timeout')), 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function consultarRecuperacaoRepasse(deps: RecoveryDeps, idRepasse: IdRepasse) {
  const repo = deps.livroFinanceiroRepository;
  const repasse = await repo.findRepasseById(idRepasse);
  if (!repasse || repasse.status !== 'verificando')
    throw new FinanceiroInputInvalidoError(
      'Repasse já resolvido ou não está em verificação. Recarregue para ver o estado atual.',
    );
  const attempts = await repo.findTransferAttemptsByRepasseId(idRepasse);
  const original = [...attempts].reverse().find((a) => a.operation === 'pagar_pix');
  if (!original) throw new FinanceiroInputInvalidoError('Tentativa original não encontrada');
  const start = new Date(original.startedAt.getTime() - 86_400_000);
  const end = new Date(original.startedAt.getTime() + 86_400_000);
  const period = {
    dataInicio: start.toISOString().slice(0, 10),
    dataFim: end.toISOString().slice(0, 10),
  };
  let lookup: RecoveryEvidence['lookup'] = 'inconclusive';
  const codigo = original.codigoSolicitacao ?? repasse.interCodigoSolicitacao;
  if (codigo) {
    try {
      const result = await deadline(deps.transferenciaProvider.consultarPagamento(codigo));
      // Inter PIXP97 is explicitly ambiguous, even under a failure envelope.
      // Inspect only in memory; provider payload never enters the response/audit.
      const ambiguous = JSON.stringify(result.raw)?.includes('PIXP97') === true;
      lookup = ambiguous
        ? 'inconclusive'
        : result.status === 'cancelado' || result.status === 'rejeitado'
          ? 'negative'
          : 'positive';
    } catch {
      /* 404/timeout/invalid response is never a negative receipt. */
    }
  }
  const recipient = await repo.findRecebedorAtivoPorIdCampanha(repasse.idCampanha);
  const fingerprint =
    original.requestSummary?.match(/(?:^|;)key_sha256:([a-f0-9]{64})(?:;|$)/)?.[1] ?? null;
  let statementAvailable = true;
  let candidates: RecoveryEvidence['candidates'] = [];
  try {
    const payments = await deadline(deps.transferenciaProvider.buscarPagamentos(period));
    candidates = payments
      .filter((p) => {
        if (p.valorCents !== repasse.amountCents) return false;
        // Date-only or absent dates cannot safely narrow the bank's day window.
        if (!p.dataMovimento?.includes('T')) return true;
        const timestamp = Date.parse(p.dataMovimento);
        return (
          !Number.isFinite(timestamp) ||
          (timestamp >= start.getTime() && timestamp <= end.getTime())
        );
      })
      .map((p) => ({
        e2eId: p.e2eId?.trim() || null,
        amountCents: p.valorCents,
        dataMovimento: p.dataMovimento ?? null,
        destination: classifyDestination(p, recipient, fingerprint),
      }));
  } catch {
    statementAvailable = false;
  }
  const evidence = { lookup, candidates };
  // A missing statement is not a clean statement. Still allow an explicit
  // external-statement attestation, unless the original lookup was positive.
  const decision = decideManualRecovery({
    ...evidence,
    lookup: !statementAvailable && lookup === 'negative' ? 'inconclusive' : lookup,
  });
  const result = {
    originalBankCode: codigo ?? null,
    idRepasse,
    expectedTransferAttempts: repasse.transferAttempts,
    amountCents: repasse.amountCents,
    period,
    lookup,
    statementAvailable,
    candidates,
    decision,
  };
  return {
    ...result,
    evidenceDigest: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  };
}
export const RecoveryInputSchema = z.object({
  idRepasse: z.string().uuid(),
  expectedTransferAttempts: z.number().int().positive(),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  motivo: z.string().trim().min(10).max(1000),
  attestation: z
    .object({
      evidence: z.string().trim().min(10).max(2000),
      periodStart: z.string().date(),
      periodEnd: z.string().date(),
      confirmedAmountCents: z.number().int().positive(),
      dismissedE2Es: z.array(z.string().trim().min(1).max(255)).max(1000),
    })
    .optional(),
});
export async function recuperarRepasse(
  deps: RecoveryDeps & { repasseJobEnqueuer: RepasseJobEnqueuer },
  input: z.infer<typeof RecoveryInputSchema>,
  actor: string,
) {
  const parsed = RecoveryInputSchema.safeParse(input);
  if (!parsed.success) throw new FinanceiroInputInvalidoError('Preencha motivo e confirmação');
  const value = parsed.data;
  const preview = await consultarRecuperacaoRepasse(deps, value.idRepasse as IdRepasse);
  if (preview.decision === 'blocked')
    throw new FinanceiroInputInvalidoError('Débito compatível ou sem destino: reenvio bloqueado');
  if (
    preview.evidenceDigest !== value.evidenceDigest ||
    preview.expectedTransferAttempts !== value.expectedTransferAttempts
  ) {
    throw new FinanceiroInputInvalidoError('Consulta mudou. Consulte o Inter novamente');
  }
  if (preview.decision === 'manual_attestation') {
    const att = value.attestation;
    if (
      !att ||
      att.confirmedAmountCents !== preview.amountCents ||
      att.periodStart > preview.period.dataInicio ||
      att.periodEnd < preview.period.dataFim ||
      preview.candidates.some((c) => !c.e2eId || !att.dismissedE2Es.includes(c.e2eId))
    ) {
      throw new FinanceiroInputInvalidoError('Ateste valor, período e cada E2E descartado');
    }
  }
  return deps.livroFinanceiroRepository.recuperarRepasseTransaction(
    {
      idRepasse: value.idRepasse as IdRepasse,
      expectedTransferAttempts: value.expectedTransferAttempts,
      audit: JSON.stringify({
        kind: preview.decision,
        actor,
        motivo: value.motivo,
        evidence: preview,
        attestation: value.attestation ?? null,
      }),
      agora: deps.clock(),
    },
    (executor) => deps.repasseJobEnqueuer.enqueueExecutar({ idRepasse: value.idRepasse }, executor),
  );
}
