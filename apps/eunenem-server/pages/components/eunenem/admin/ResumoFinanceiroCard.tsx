import { formatBRL } from "@/lib/formatBRL";

/**
 * ResumoFinanceiroCard — totais das campanhas administradas por uma conta
 * (aperture-5jk8y). Puro: recebe o DTO de `admin.usuarios.financeiro.summary`.
 *
 * Honestidade antes de estética:
 *   - "Recebido (confirmado)" = linhas com pagamento aprovado e sem
 *     cancelamento. Estornado e anomalias ficam FORA e são mostrados à parte.
 *   - "Pendente de conferência" agrupa estorno em andamento (valor ainda não
 *     estornado) + inconsistente. Nunca vira "disponível".
 *   - A diferença com o cross-check do ledger só aparece quando ≠ 0 e nunca é
 *     ajustada.
 *   - Taxa do provedor, estorno parcial e chargeback: não existem no ledger,
 *     então não são exibidos como número.
 */

export interface TotaisResumo {
  recebidoConfirmadoCents: number;
  disponivelCents: number;
  aguardandoLiberacaoCents: number;
  aguardandoTransferenciaCents: number;
  transferenciaFalhouCents: number;
  emTransferenciaCents: number;
  enviadoAoBancoCents: number;
  transferidoCents: number;
  resgatadoConcluidoCents: number;
  estornoEmAndamentoCents: number;
  inconsistenteCents: number;
  pendenteConferenciaCents: number;
  estornadoCents: number;
  estornadoCount: number;
  anomaliaCents: number;
  anomaliaCount: number;
  lancamentosCount: number;
}

export interface ResumoFinanceiroCardProps {
  totais: TotaisResumo;
  ledgerAprovadoSemCancelCents: number;
  diferencaNaoConciliadaCents: number;
  campanhasTotal: number;
}

export function ResumoFinanceiroCard({
  totais: t,
  ledgerAprovadoSemCancelCents,
  diferencaNaoConciliadaCents,
  campanhasTotal,
}: ResumoFinanceiroCardProps) {
  const vazio = t.lancamentosCount === 0;
  return (
    <div className="rounded-md border border-line bg-paper p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          resumo financeiro
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          {campanhasTotal === 1
            ? "1 campanha administrada"
            : `${campanhasTotal} campanhas administradas`}
          {" · "}
          {t.lancamentosCount === 1 ? "1 lançamento" : `${t.lancamentosCount} lançamentos`}
        </span>
      </div>

      {vazio && (
        <p className="mt-3 text-[13px] italic text-ink-mute">
          Nenhum lançamento nas campanhas administradas por esta conta.
        </p>
      )}

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Recebido (confirmado)" cents={t.recebidoConfirmadoCents} primary />
        <Tile label="Resgatado (concluído)" cents={t.resgatadoConcluidoCents} primary />
        <Tile label="Disponível para resgate" cents={t.disponivelCents} />
        <Tile label="Aguardando liberação" cents={t.aguardandoLiberacaoCents} />
        <Tile
          label="Em transferência"
          cents={t.emTransferenciaCents}
          sub={
            t.transferenciaFalhouCents > 0
              ? `aguardando ${formatBRL(t.aguardandoTransferenciaCents)} · falhou ${formatBRL(
                  t.transferenciaFalhouCents,
                )}`
              : null
          }
        />
        <Tile label="Enviado ao banco" cents={t.enviadoAoBancoCents} />
        <Tile
          label="Pendente de conferência"
          cents={t.pendenteConferenciaCents}
          tone={t.pendenteConferenciaCents > 0 ? "warn" : "default"}
          sub={
            t.pendenteConferenciaCents > 0
              ? `estorno em andamento ${formatBRL(
                  t.estornoEmAndamentoCents,
                )} · inconsistente ${formatBRL(t.inconsistenteCents)}`
              : null
          }
        />
        <Tile
          label="Estornado (fora do recebido)"
          cents={t.estornadoCents}
          tone="muted"
          sub={
            t.estornadoCount > 0
              ? `${t.estornadoCount} ${t.estornadoCount === 1 ? "lançamento" : "lançamentos"}`
              : null
          }
        />
        {t.anomaliaCount > 0 && (
          <Tile
            label="Anomalias (fora do recebido)"
            cents={t.anomaliaCents}
            tone="danger"
            sub={`${t.anomaliaCount} ${
              t.anomaliaCount === 1 ? "linha sem pagamento aprovado" : "linhas sem pagamento aprovado"
            } ou com carimbos contraditórios`}
          />
        )}
      </dl>

      {t.estornoEmAndamentoCents > 0 && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          Estorno em andamento: {formatBRL(t.estornoEmAndamentoCents)} ainda não foi estornado.
          Continua dentro do recebido até o cancelamento ser persistido.
        </p>
      )}

      {diferencaNaoConciliadaCents !== 0 && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800"
        >
          Diferença não conciliada: {formatBRL(diferencaNaoConciliadaCents)} (recebido{" "}
          {formatBRL(t.recebidoConfirmadoCents)} vs. ledger aprovado sem cancelamento{" "}
          {formatBRL(ledgerAprovadoSemCancelCents)}). Valor não ajustado — requer conferência.
        </p>
      )}

      <p className="mt-4 font-mono text-[10px] leading-relaxed tracking-[0.02em] text-ink-mute">
        recebido = disponível + aguardando liberação + em transferência + enviado ao banco +
        resgatado + pendente de conferência · estornado e anomalias ficam fora · taxa do
        provedor, estorno parcial e chargeback: não disponíveis nesta versão
      </p>
    </div>
  );
}

function Tile({
  label,
  cents,
  sub = null,
  primary = false,
  tone = "default",
}: {
  label: string;
  cents: number;
  sub?: string | null;
  primary?: boolean;
  tone?: "default" | "muted" | "warn" | "danger";
}) {
  const toneClass =
    tone === "warn"
      ? "border-amber-200 bg-amber-50/60"
      : tone === "danger"
        ? "border-red-200 bg-red-50/60"
        : tone === "muted"
          ? "border-line bg-cream-2/40"
          : "border-line bg-paper";
  const valueClass =
    tone === "muted"
      ? "text-ink-mute"
      : tone === "danger"
        ? "text-red-800"
        : tone === "warn"
          ? "text-amber-900"
          : "text-ink";
  return (
    <div className={`rounded-md border px-3 py-2.5 ${toneClass}`}>
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">{label}</dt>
      <dd
        className={`mt-1 font-mono tabular-nums ${primary ? "text-[18px] font-semibold" : "text-[15px]"} ${valueClass}`}
      >
        {formatBRL(cents)}
      </dd>
      {sub && <dd className="mt-0.5 text-[11px] leading-snug text-ink-soft">{sub}</dd>}
    </div>
  );
}
