import { trpc } from "@/lib/trpc.js";

/**
 * LancamentosList — Financeiro BC drill (aperture-rsidz.6, W5).
 *
 * Visual surface for the Financeiro BC's double-entry ledger on the
 * contribuicao detail page. Renders one block per pagamento; each block
 * shows the pagamento header (short id + criadoEm + status chip) plus the
 * TWO lancamentos that an aprovado pagamento books:
 *
 *   - Saldo do recebedor   (credito_saldo_recebedor)
 *   - Receita da plataforma (credito_receita_plataforma)
 *
 * The double-entry shape is the DDD-spine payoff — operator literally
 * sees that every aprovado pagamento books one credit to the recebedor's
 * balance + one credit to the platform's revenue. NOT an accidental
 * two-row rendering: the rows are explicitly labelled, ordered, and the
 * "double-entry" intent is preserved when only one tipo is present
 * (degenerate data) by still slotting the rows by tipo.
 *
 * Pendente / rejeitado pagamentos book ZERO lancamentos; the block
 * renders an explicit "Sem lançamentos (pagamento ainda não aprovado)"
 * affordance instead of an empty body.
 *
 * Lancamento status lifecycle: `pendente` → `disponivel`. Plan 0006 (the
 * maturation rule — PIX T+1h, cartão D+30) is DRAFTED but NOT SHIPPED, so
 * today every lancamento in prod sits at status="pendente". To preempt
 * the operator's "is the system stuck?" reflex, the pendente chip carries
 * a gray-ink one-liner explaining the deferred maturation. Disponivel
 * shows a small green checkmark next to the chip and no affordance line.
 *
 * Wire shape:
 *   trpc.admin.financeiro.listByContribuicao({ idContribuicao })
 *     → { lancamentosByPagamento: [{ idPagamento, pagamentoStatus,
 *         pagamentoCriadoEm, lancamentos: [...] }] }
 *
 * Visual language matches W0..W4 admin sections — font-mono small-caps
 * labels, hairline borders, BRL formatted via Intl.NumberFormat pt-BR.
 */
export function LancamentosList({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  const { data, isLoading, error } =
    trpc.admin.financeiro.listByContribuicao.useQuery({ idContribuicao });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!data) return null;

  const groups = data.lancamentosByPagamento;

  if (groups.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <PagamentoBlock
          key={g.idPagamento}
          idPagamento={g.idPagamento}
          pagamentoStatus={g.pagamentoStatus}
          pagamentoCriadoEm={g.pagamentoCriadoEm}
          lancamentos={g.lancamentos}
        />
      ))}
    </div>
  );
}

type Tipo = "credito_saldo_recebedor" | "credito_receita_plataforma";
type LancamentoStatus = "pendente" | "disponivel";
type PagamentoStatus = "pendente" | "aprovado" | "rejeitado";

type LancamentoRow = {
  id: string;
  idPagamento: string;
  idContribuicao: string;
  idCampanha: string | null;
  tipo: Tipo;
  amountCents: number;
  status: LancamentoStatus;
  criadoEm: string;
};

function LoadingState() {
  return (
    <div className="space-y-3 rounded-md border border-line bg-paper p-5">
      <div className="h-4 w-56 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-72 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-40 animate-pulse rounded bg-cream-2" />
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

function EmptyState() {
  return (
    <div className="rounded-md border border-dashed border-line bg-paper px-5 py-10 text-center">
      <p className="font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
        (sem pagamentos para esta contribuição — nenhum lançamento financeiro
        gerado)
      </p>
    </div>
  );
}

function PagamentoBlock({
  idPagamento,
  pagamentoStatus,
  pagamentoCriadoEm,
  lancamentos,
}: {
  idPagamento: string;
  pagamentoStatus: PagamentoStatus;
  pagamentoCriadoEm: string;
  lancamentos: readonly LancamentoRow[];
}) {
  return (
    <div className="rounded-md border border-line bg-paper">
      <BlockHeader
        idPagamento={idPagamento}
        pagamentoStatus={pagamentoStatus}
        pagamentoCriadoEm={pagamentoCriadoEm}
      />
      <BlockBody pagamentoStatus={pagamentoStatus} lancamentos={lancamentos} />
    </div>
  );
}

function BlockHeader({
  idPagamento,
  pagamentoStatus,
  pagamentoCriadoEm,
}: {
  idPagamento: string;
  pagamentoStatus: PagamentoStatus;
  pagamentoCriadoEm: string;
}) {
  const shortId = `${idPagamento.slice(0, 8)}…`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        pagamento
      </p>
      <code
        title={idPagamento}
        className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-soft"
      >
        {shortId}
      </code>
      <span className="font-mono text-[11px] tabular-nums text-ink-soft">
        {formatCriadaEm(pagamentoCriadoEm)}
      </span>
      <span className="ml-auto">
        <PagamentoStatusChip status={pagamentoStatus} />
      </span>
    </div>
  );
}

function BlockBody({
  pagamentoStatus,
  lancamentos,
}: {
  pagamentoStatus: PagamentoStatus;
  lancamentos: readonly LancamentoRow[];
}) {
  if (pagamentoStatus !== "aprovado") {
    return (
      <div className="px-5 py-5">
        <p className="font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
          Sem lançamentos (pagamento ainda não aprovado)
        </p>
      </div>
    );
  }

  // Aprovado path. We sort by tipo so the double-entry visual order is
  // stable across renders — "Saldo do recebedor" always first, "Receita da
  // plataforma" always second. The slots are populated from the lancamento
  // data; if one side is missing (data corruption / partial save), the
  // slot still renders with an explicit "(não registrado)" affordance so
  // the double-entry expectation is visible rather than silently elided.
  const saldoRecebedor =
    lancamentos.find((l) => l.tipo === "credito_saldo_recebedor") ?? null;
  const receitaPlataforma =
    lancamentos.find((l) => l.tipo === "credito_receita_plataforma") ?? null;

  return (
    <div className="divide-y divide-line">
      <LancamentoRowDouble
        label="Saldo do recebedor"
        sublabel="credito_saldo_recebedor"
        lancamento={saldoRecebedor}
      />
      <LancamentoRowDouble
        label="Receita da plataforma"
        sublabel="credito_receita_plataforma"
        lancamento={receitaPlataforma}
      />
    </div>
  );
}

function LancamentoRowDouble({
  label,
  sublabel,
  lancamento,
}: {
  label: string;
  sublabel: string;
  lancamento: LancamentoRow | null;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-lilac-soft/30">
      <div className="space-y-0.5">
        <p className="text-[13px] text-ink">{label}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
          {sublabel}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        {lancamento === null ? (
          <p className="text-[13px] italic text-ink-mute">(não registrado)</p>
        ) : (
          <>
            <span className="font-mono text-[13px] tabular-nums text-ink">
              {formatBRL(lancamento.amountCents)}
            </span>
            <LancamentoStatusBadge status={lancamento.status} />
          </>
        )}
      </div>
      {lancamento !== null && lancamento.status === "pendente" && (
        <div className="col-span-2">
          <p className="text-[11px] italic leading-snug text-ink-mute">
            Maturação automática ainda não está ativa (plano 0006).
            Aguardando regra de maturação para virar disponível.
          </p>
        </div>
      )}
    </div>
  );
}

function LancamentoStatusBadge({ status }: { status: LancamentoStatus }) {
  // pendente=zinc (matches W4's pagamento chip palette), disponivel=emerald.
  // Disponivel carries a small ✓ glyph — the maturation finish line.
  const isDisponivel = status === "disponivel";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={[
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em]",
          isDisponivel
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : "border-line bg-cream-2 text-ink-soft",
        ].join(" ")}
      >
        <span
          aria-hidden
          className={[
            "inline-block size-[6px] rounded-full",
            isDisponivel ? "bg-emerald-500" : "bg-ink-mute",
          ].join(" ")}
        />
        {isDisponivel ? "disponível" : "pendente"}
      </span>
      {isDisponivel && (
        <span
          aria-hidden
          title="Lançamento maturado e disponível para repasse"
          className="font-mono text-[12px] leading-none text-emerald-600"
        >
          ✓
        </span>
      )}
    </span>
  );
}

function PagamentoStatusChip({ status }: { status: PagamentoStatus }) {
  // Three-state mini chip — mirrors W4's pagamento chip palette so the
  // visual language reads the same across BCs:
  //   aprovado=emerald, pendente=zinc, rejeitado=rose
  const palette =
    status === "aprovado"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "rejeitado"
        ? "border-rose-200 bg-rose-50 text-rose-800"
        : "border-line bg-cream-2 text-ink-soft";
  const dot =
    status === "aprovado"
      ? "bg-emerald-500"
      : status === "rejeitado"
        ? "bg-rose-500"
        : "bg-ink-mute";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em]",
        palette,
      ].join(" ")}
    >
      <span aria-hidden className={`inline-block size-[6px] rounded-full ${dot}`} />
      {status}
    </span>
  );
}

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

function formatCriadaEm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${hh}:${mm}`;
  }
}
