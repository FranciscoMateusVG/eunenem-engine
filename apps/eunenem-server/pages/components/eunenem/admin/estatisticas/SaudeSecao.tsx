import { useState } from "react";
import { trpc } from "@/lib/trpc.js";
import { formatInstante } from "../receita/types";
import { GraficoBarras, type SerieGrafico } from "./GraficoBarras";
import { numero, rotuloBucket, tituloBucket } from "./formato";
import type { SaudeCategoria, SaudeData, SaudeRecente } from "./types";

/**
 * Seção Saúde & erros (aperture-lcug3), sobre `admin.analytics.saude`.
 *
 * Falhas de provedor são tentativas históricas; webhook, checkout e e-mail
 * são linhas ainda sem resolução hoje (resolvidas somem da contagem). A
 * mensagem do provedor aparece crua (credenciais nossas mascaradas no
 * servidor); a lista corta em 2 KB e "ver completo" busca o texto inteiro.
 */

export const ROTULO_CATEGORIA: Record<SaudeCategoria, string> = {
  provedor: "Provedor (Inter/Stripe)",
  webhook: "Webhooks",
  checkout: "Checkout",
  email: "E-mails",
};

const EXPLICACAO_CATEGORIA: Record<SaudeCategoria, string> = {
  provedor: "tentativas que falharam",
  webhook: "sem processar hoje",
  checkout: "operações falhas/incertas",
  email: "envios falhos/incertos",
};

const SERIES: readonly SerieGrafico[] = [
  { chave: "provedor", nome: ROTULO_CATEGORIA.provedor, cor: "bg-coral-pink", corParcial: "bg-pink-soft" },
  { chave: "webhook", nome: ROTULO_CATEGORIA.webhook, cor: "bg-lilac-deep", corParcial: "bg-lilac-soft" },
  { chave: "checkout", nome: ROTULO_CATEGORIA.checkout, cor: "bg-blue-deep", corParcial: "bg-blue-soft" },
  { chave: "email", nome: ROTULO_CATEGORIA.email, cor: "bg-yellow", corParcial: "bg-yellow/40" },
];

function Referencia({ r }: { r: SaudeRecente["referencia"] }) {
  if (!r.tipo || !r.id) return <span className="text-ink-mute">—</span>;
  const curto = `${r.tipo} ${r.id.slice(0, 8)}`;
  const href =
    r.tipo === "pagamento" ? `/admin/pagamento/${r.id}` : r.tipo === "repasse" ? `/admin/repasses/${r.id}` : null;
  return href ? (
    <a className="underline hover:text-plum" href={href}>
      {curto}
    </a>
  ) : (
    <span title={r.id}>{curto}</span>
  );
}

const PRE =
  "max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-stone-50 p-2 font-mono text-[11px] text-ink";

/** Só monta (e só consulta) quando o operador pede o texto inteiro. */
function MensagemCompleta({ item }: { item: SaudeRecente }) {
  const detalhe = trpc.admin.analytics.saudeDetalhe.useQuery({ id: item.id }, { staleTime: 60_000 });
  if (detalhe.error)
    return (
      <p role="alert" className="text-[11px] text-red-700">
        Não foi possível carregar a mensagem completa. {detalhe.error.message}
      </p>
    );
  if (detalhe.data === undefined) return <p className="font-mono text-[11px] text-ink-mute">carregando…</p>;
  if (detalhe.data === null)
    return <p className="text-[11px] text-ink-mute">Este registro não existe mais (já resolvido?).</p>;
  return (
    <pre data-testid="saude-mensagem-completa" className={PRE}>
      {detalhe.data.mensagem}
    </pre>
  );
}

function Mensagem({ item }: { item: SaudeRecente }) {
  const [completo, setCompleto] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {completo ? (
        <MensagemCompleta item={item} />
      ) : (
        <pre data-testid="saude-mensagem" className={PRE}>
          {item.mensagem}
          {item.truncado ? "…" : ""}
        </pre>
      )}
      {item.truncado ? (
        <button
          type="button"
          className="self-start font-mono text-[11px] text-plum underline"
          onClick={() => setCompleto((v) => !v)}
        >
          {completo ? "ver menos" : "ver completo"}
        </button>
      ) : null}
    </div>
  );
}

export function SaudeSecao({ data }: { data: SaudeData }) {
  const graficoDe = (mensal: boolean) =>
    (mensal ? data.meses : data.semanas).map((b) => ({
      chave: b.de,
      rotulo: rotuloBucket(b, mensal),
      titulo: `${tituloBucket(b, mensal)}: ${data.categorias
        .map((c) => `${ROTULO_CATEGORIA[c]} ${numero(b.contagens[c])}`)
        .join(" · ")}`,
      parcial: b.parcial,
      valores: b.contagens,
    }));
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <ul aria-label="Falhas por categoria" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.categorias.map((c) => (
          <li key={c} data-testid="saude-categoria" className="rounded-xl border border-line p-4">
            <div className="text-sm text-ink-soft">{ROTULO_CATEGORIA[c]}</div>
            <div className="text-2xl font-semibold tabular-nums">{numero(data.totais[c])}</div>
            <div className="font-mono text-[11px] text-ink-mute">{EXPLICACAO_CATEGORIA[c]}</div>
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-soft">
        Falhas de provedor são o histórico de tentativas, inclusive de repasses. Webhooks, checkout e
        e-mails contam só o que continua sem resolução hoje: quando algo é reprocessado com sucesso,
        sai da contagem. A data de webhook é o último processamento e a de e-mail, a última
        tentativa de envio.
      </p>
      <GraficoBarras
        titulo="Falhas por mês"
        explicacao="Somadas por categoria. O mês atual é parcial (tom claro)."
        series={SERIES}
        barras={graficoDe(true)}
        formatar={numero}
        testId="saude-mes"
      />
      <GraficoBarras
        titulo="Falhas por semana"
        explicacao="Semanas de segunda a domingo; as das pontas podem estar cortadas pelo período."
        series={SERIES}
        barras={graficoDe(false)}
        formatar={numero}
        testId="saude-semana"
      />
      <section aria-label="Erros recentes" className="flex min-w-0 flex-col gap-3">
        <div>
          <h2 className="text-[16px] font-semibold tracking-normal! text-ink">Erros recentes</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Os 50 mais recentes do período, com a mensagem crua do provedor (credenciais mascaradas).
          </p>
        </div>
        {data.recentes.length === 0 ? (
          <p data-testid="saude-sem-erros" className="rounded-lg border border-dashed border-line p-6 text-sm text-ink-soft">
            Nenhum erro no período.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {data.recentes.map((item) => (
              <li key={item.id} data-testid="saude-recente" className="rounded-lg border border-line p-3">
                <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[11px] text-ink-mute">
                  <time dateTime={item.em} className="text-ink">
                    {formatInstante(item.em)}
                  </time>
                  <span className="rounded bg-stone-100 px-1.5 py-0.5 text-ink">{ROTULO_CATEGORIA[item.categoria]}</span>
                  {item.provedor ? <span>{item.provedor === "inter" ? "Inter" : "Stripe"}</span> : null}
                  {item.operacao ? <span>{item.operacao}</span> : null}
                  <Referencia r={item.referencia} />
                </div>
                <Mensagem item={item} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
