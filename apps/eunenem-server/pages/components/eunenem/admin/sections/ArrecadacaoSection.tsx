import { useState } from "react";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { trpc } from "@/lib/trpc.js";

/**
 * ArrecadacaoSection — plan 0015 Phase 6 reshape (aperture-i45g5).
 *
 * Top section of /admin/contribuicao/:idContribuicao. Renders the
 * Arrecadação-side facts of a single contribuicao: id, valor,
 * disponibilidade, opção + grupo, criadaEm, campanha link, recebedor
 * (gift-not-claimed-safe).
 *
 * Phase 6 simplification — three blocks dropped from this card vs the
 * original rsidz.4 ship:
 *   1. CONTRIBUINTE block (name + email) — moved to per-pagamento
 *      contribuinte affordance in PagamentosSection.
 *   2. MENSAGEM (recadinho) block — same, moves to per-pagamento.
 *   3. Stored `status` badge — replaced with the `indisponivel` predicate
 *      computed from `EXISTS pagamento WHERE id_contribuicao=X AND
 *      status='aprovado'`. Visual style stays the same; the data source
 *      changes. Parallel-prep stub today: derived from the legacy
 *      `status` field. Rex's Phase 1 PR swaps to the real predicate
 *      with no UI change.
 *
 * Why: per plan 0015 Locked Decision #2, the Contribuicao aggregate is
 * "admin-owned, no visitor writes, slot definition only" — contribuinte
 * data is per-pagamento (intencao.contribuinte), and the
 * indisponivel/disponivel state is derived, not stored.
 *
 * Calls `trpc.admin.contribuicoes.findById` which returns the
 * multi-aggregate payload (contribuicao + campanha summary + recebedor
 * snapshot). The legacy `contribuinte` usuario summary slot still
 * arrives on the wire but is unused by this card now.
 *
 * Seam contract (preserved verbatim from rsidz.4):
 *   - Default export `({ idContribuicao }) => JSX.Element`
 *   - Root element carries `data-bc="arrecadacao"`
 *   - Renders the DddBadge header (emerald) so BC wayfinding stays consistent
 */
export default function ArrecadacaoSection({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  const { data, isLoading, error } = trpc.admin.contribuicoes.findById.useQuery(
    { idContribuicao },
  );

  return (
    <section data-bc="arrecadacao" className="space-y-3">
      <SectionHeader />
      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message} />}
      {!isLoading && !error && data === null && (
        <NotFoundState idContribuicao={idContribuicao} />
      )}
      {!isLoading && !error && data && (
        <Body
          idContribuicao={idContribuicao}
          contribuicao={data.contribuicao}
          campanha={data.campanha}
          recebedor={data.recebedor}
        />
      )}
    </section>
  );
}

function SectionHeader() {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-3">
        <DddBadge bc="arrecadacao" size="sm" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          arrecadação
        </h2>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
        contribuição · detalhe
      </span>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3 rounded-md border border-line bg-paper p-5">
      <div className="h-4 w-48 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-64 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-32 animate-pulse rounded bg-cream-2" />
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

function NotFoundState({ idContribuicao }: { idContribuicao: string }) {
  return (
    <div className="rounded-md border border-line bg-paper p-5">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        contribuição não encontrada
      </p>
      <p className="mt-2 text-[13px] text-ink-soft">
        A contribuição{" "}
        <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[12px]">
          {idContribuicao}
        </code>{" "}
        não foi encontrada ou pertence a outra plataforma.
      </p>
    </div>
  );
}

type ContribuicaoDTO = {
  id: string;
  nome: string;
  valorCentavos: number;
  grupo: string | null;
  idOpcaoContribuicao: string;
  criadaEm: string;
  // Plan 0015 Phase 6 — computed predicate (EXISTS pagamento WHERE
  // id_contribuicao=X AND status='aprovado'). The Arrecadação card reads
  // this; the legacy `status` field on the wire is ignored here.
  indisponivel: boolean;
};

type CampanhaSummary = { id: string; titulo: string };
type RecebedorSummary = { nome: string };

function Body({
  idContribuicao,
  contribuicao,
  campanha,
  recebedor,
}: {
  idContribuicao: string;
  contribuicao: ContribuicaoDTO;
  campanha: CampanhaSummary;
  recebedor: RecebedorSummary | null;
}) {
  return (
    <div className="space-y-6 rounded-md border border-line bg-paper p-5">
      <Headline contribuicao={contribuicao} idContribuicao={idContribuicao} />
      <FactsGrid contribuicao={contribuicao} idContribuicao={idContribuicao} />
      <SubGrid>
        <CampanhaBlock campanha={campanha} />
        <RecebedorBlock recebedor={recebedor} />
      </SubGrid>
    </div>
  );
}

function Headline({
  contribuicao,
  idContribuicao,
}: {
  contribuicao: ContribuicaoDTO;
  idContribuicao: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="text-xl font-semibold tracking-tight text-ink">
        {contribuicao.nome}
      </h3>
      <StatusPill indisponivel={contribuicao.indisponivel} />
      <IdCopyChip idContribuicao={idContribuicao} />
    </div>
  );
}

function FactsGrid({
  contribuicao,
  idContribuicao: _idContribuicao,
}: {
  contribuicao: ContribuicaoDTO;
  idContribuicao: string;
}) {
  const facts: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "valor",
      value: (
        <span className="font-mono text-[13px] tabular-nums text-ink">
          {formatBRL(contribuicao.valorCentavos)}
        </span>
      ),
    },
    {
      label: "opção (id)",
      value: (
        <code className="block break-all rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink">
          {contribuicao.idOpcaoContribuicao}
        </code>
      ),
    },
    {
      label: "grupo",
      value:
        contribuicao.grupo !== null && contribuicao.grupo !== "" ? (
          <span className="text-[13px] text-ink">{contribuicao.grupo}</span>
        ) : (
          <span className="text-[13px] italic text-ink-mute">(sem grupo)</span>
        ),
    },
    {
      label: "criada em",
      value: (
        <span className="font-mono text-[12px] tabular-nums text-ink">
          {formatCriadaEm(contribuicao.criadaEm)}
        </span>
      ),
    },
  ];
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
      {facts.map(({ label, value }) => (
        <div
          key={label}
          className="contents [&>dt]:font-mono [&>dt]:text-[11px] [&>dt]:uppercase [&>dt]:tracking-[0.12em] [&>dt]:text-ink-mute"
        >
          <dt className="pt-1">{label}</dt>
          <dd className="pb-2 sm:pb-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SubGrid({ children }: { children: React.ReactNode }) {
  // Phase 6: ContribuinteBlock removed → grid drops from 3 to 2 cols.
  // Campanha + Recebedor now share the row at sm: breakpoint and above.
  return (
    <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
      {children}
    </div>
  );
}

function CampanhaBlock({ campanha }: { campanha: CampanhaSummary }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        campanha
      </p>
      <div className="mt-1 space-y-0.5">
        <p className="text-[13px] text-ink">{campanha.titulo}</p>
        <a
          href={`/admin/campanha/${campanha.id}`}
          className="font-mono text-[12px] text-plum underline-offset-2 hover:underline"
        >
          /admin/campanha/{campanha.id.slice(0, 8)}…
        </a>
      </div>
    </div>
  );
}

function RecebedorBlock({ recebedor }: { recebedor: RecebedorSummary | null }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        recebedor
      </p>
      {recebedor === null ? (
        <p className="mt-1 text-[13px] italic text-ink-mute">(sem recebedor)</p>
      ) : (
        <p className="mt-1 text-[13px] text-ink">{recebedor.nome}</p>
      )}
    </div>
  );
}

/**
 * Disponibilidade pill — visual style unchanged from rsidz.4. The data
 * source moved from a stored `status` field to the `indisponivel` predicate
 * (EXISTS pagamento WHERE id_contribuicao=X AND status='aprovado').
 *
 * Why we read `indisponivel: boolean` instead of a 2-state string:
 *   - The predicate is structurally a boolean (does some aprovado pagamento
 *     exist?). Round-tripping it through a string just to keep the old API
 *     shape was ceremony without value.
 *   - The pill's only two visible states are "disponível" / "indisponível";
 *     a boolean maps to them 1:1.
 */
function StatusPill({ indisponivel }: { indisponivel: boolean }) {
  const isAvailable = !indisponivel;
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em]",
        isAvailable
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-line bg-cream-2 text-ink-soft",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "inline-block size-[6px] rounded-full",
          isAvailable ? "bg-emerald-500" : "bg-ink-mute",
        ].join(" ")}
      />
      {isAvailable ? "disponível" : "presenteada"}
    </span>
  );
}

/**
 * Short-hash + click-to-copy affordance. Two-state button: idle shows the
 * abbreviated id with a "copy" hint, post-click shows "copiado" for 1.5s.
 * Falls back to a non-interactive span if Clipboard API is unavailable
 * (older browsers / non-secure contexts).
 */
function IdCopyChip({ idContribuicao }: { idContribuicao: string }) {
  const [copied, setCopied] = useState(false);
  const shortId = `${idContribuicao.slice(0, 8)}…`;

  const canCopy =
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function";

  const onClick = async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(idContribuicao);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silently ignore — no UX surface for clipboard errors in admin v1.
    }
  };

  if (!canCopy) {
    return (
      <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
        {shortId}
      </code>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "copiado" : `Copiar ${idContribuicao}`}
      aria-label={copied ? "Id copiado" : `Copiar id da contribuição: ${idContribuicao}`}
      className="group inline-flex items-center gap-1.5 rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-soft transition-colors hover:text-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
    >
      <span>{shortId}</span>
      <span
        aria-hidden
        className={[
          "font-mono text-[9px] uppercase tracking-[0.18em]",
          copied ? "text-emerald-600" : "text-ink-mute group-hover:text-plum",
        ].join(" ")}
      >
        {copied ? "copiado" : "copiar"}
      </span>
    </button>
  );
}

function formatBRL(centavos: number): string {
  const reais = centavos / 100;
  // Locale-aware BRL — matches the admin engineering surface (no Patrick
  // Hand stylized formatting; just the canonical pt-BR currency string).
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
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    // Fallback to ISO yyyy-mm-dd HH:mm
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${hh}:${mm}`;
  }
}
