import type { LucroPeriodo } from "../../../../lib/lucroPainel.js";
import { rotuloMesCurto, rotuloSemana } from "../../../../lib/receitaPainel.js";

const dinheiro = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function Grafico({ titulo, periodos, mensal }: { titulo: string; periodos: readonly LucroPeriodo[]; mensal: boolean }) {
  const max = Math.max(1, ...periodos.map((p) => Math.abs(p.valorCents ?? 0)));
  return <section aria-label={titulo} className="rounded-2xl border border-stone-200 bg-white p-4">
    <h2 className="font-semibold text-stone-800">{titulo}</h2>
    <p className="mt-1 text-xs text-stone-500">Tarifas EuNeném menos despesas observadas. Calendário de São Paulo.{!mensal && " Recorrentes rateadas por dia, custo somente até hoje; demais despesas na data real. As semanas do mês corrente podem ser recalculadas quando uma cobrança acontece."}</p>
    <div className="mt-5 grid gap-x-3 gap-y-6 grid-cols-2 sm:grid-cols-4 xl:grid-cols-6">
      {periodos.map((p) => {
        const negativo = (p.valorCents ?? 0) < 0;
        const legenda = p.estado === "sem_dados" ? "— sem dados de despesa" : p.estado === "futuro" ? "— período futuro"
          : p.estado === "incompleto" ? "observado · incompleto" : "observado";
        const rotulo = mensal ? rotuloMesCurto(p.de) : rotuloSemana(p);
        return <div key={p.de} aria-label={rotulo}>
          <div className="relative h-28" aria-hidden="true">
            <div className="absolute top-1/2 w-full border-t border-stone-300" />
            {p.valorCents !== null && <div data-negative={negativo} className={`absolute left-1/4 w-1/2 rounded-sm ${negativo ? "bg-red-500" : "bg-emerald-600"}`}
              style={{ height: `${Math.abs(p.valorCents) / max * 46}%`, ...(negativo ? { top: "50%" } : { bottom: "50%" }) }} />}
          </div>
          <div className="text-xs font-medium">{rotulo}</div>
          {p.valorCents !== null && <div className={`text-sm font-semibold tabular-nums ${negativo ? "text-red-700" : "text-stone-800"}`}>Lucro observado: {dinheiro(p.valorCents)}</div>}
          <div className="text-xs text-stone-500">{legenda}{p.parcial ? " · semana em andamento (parcial)" : ""}</div>
          {!mensal && p.metaRecorrenteCents !== undefined && <div className="text-xs text-amber-800">Meta para se pagar: {dinheiro(p.metaRecorrenteCents)}</div>}
          {!mensal && p.metaRecorrenteCents === 0 ? <div className="text-xs">Sem custo fixo nesta semana</div>
            : !mensal && p.faltamCents !== undefined && <div className="text-xs">{p.faltamCents === 0 ? "Meta atingida ✓" : `Meta não atingida · Faltam ${dinheiro(p.faltamCents)} em tarifas EuNeném, descontadas taxas de provedor, para cobrir a meta.`}</div>}
        </div>;
      })}
    </div>
  </section>;
}

export function LucroGraficos({ data }: { data: { meses: readonly LucroPeriodo[]; semanas: readonly LucroPeriodo[] } }) {
  return <div className="flex flex-col gap-6">
    <Grafico titulo="Lucro líquido por mês" periodos={data.meses} mensal />
    <Grafico titulo="Lucro líquido por semana" periodos={data.semanas} mensal={false} />
  </div>;
}
