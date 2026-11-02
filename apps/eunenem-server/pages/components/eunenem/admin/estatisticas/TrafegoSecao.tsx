import { formatInstante } from "../receita/types";
import { GraficoBarras, type SerieGrafico } from "./GraficoBarras";
import { numero, pct, rotuloBucket, textoPct, tituloBucket } from "./formato";
import type { TrafegoData } from "./types";

/**
 * Seção Tráfego (aperture-lcug3), sobre `admin.analytics.trafego`.
 *
 * Dados do Mixpanel lidos SÓ no servidor e guardados em cache; o navegador
 * nunca vê credencial. Dias no fuso do projeto Mixpanel (Pacífico), por isso
 * o aviso do servidor aparece literalmente. Quando o Mixpanel falha, a seção
 * diz o motivo em vez de mostrar zeros.
 */

const SERIE_VISITAS: readonly SerieGrafico[] = [
  { chave: "visitas", nome: "Visualizações", cor: "bg-blue-deep", corParcial: "bg-blue-soft" },
];
const SERIE_CADASTROS: readonly SerieGrafico[] = [
  { chave: "cadastros", nome: "Cadastros", cor: "bg-plum", corParcial: "bg-plum/40" },
];

export function TrafegoSecao({ data }: { data: TrafegoData }) {
  const aviso = (
    <p data-testid="trafego-aviso" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      {data.aviso} O Mixpanel conta eventos do site de todos os ambientes e visitantes, por isso
      não é comparável ao Funil, que lê só o banco desta instalação. Atualizado em{" "}
      {formatInstante(data.atualizadoEm)}.
    </p>
  );
  if (!data.disponivel)
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <p role="alert" data-testid="trafego-indisponivel" className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
          {data.motivo ?? "Mixpanel indisponível no momento."}
        </p>
        {aviso}
      </div>
    );
  const barras = (mensal: boolean, campo: "visitas" | "cadastros") =>
    (mensal ? data.meses : data.semanas).map((b) => ({
      chave: b.de,
      rotulo: rotuloBucket(b, mensal),
      titulo: `${tituloBucket(b, mensal)}: ${numero(b.visitas)} visualizações · ${numero(b.cadastros)} cadastros`,
      parcial: b.parcial,
      valores: { [campo]: b[campo] },
    }));
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="grid grid-cols-2 gap-3">
        <div data-testid="trafego-kpi" className="rounded-xl border border-line p-4">
          <div className="text-sm text-ink-soft">Visualizações de página</div>
          <div className="text-2xl font-semibold tabular-nums">{numero(data.totais.visitas)}</div>
          <div className="font-mono text-[11px] text-ink-mute">eventos, não pessoas</div>
        </div>
        <div data-testid="trafego-kpi" className="rounded-xl border border-line p-4">
          <div className="text-sm text-ink-soft">Cadastros</div>
          <div className="text-2xl font-semibold tabular-nums">{numero(data.totais.cadastros)}</div>
          <div className="font-mono text-[11px] text-ink-mute">eventos de conta criada</div>
        </div>
      </div>
      {aviso}
      <GraficoBarras
        titulo="Visualizações por mês"
        explicacao="Páginas vistas no site em cada mês (fuso do Mixpanel)."
        series={SERIE_VISITAS}
        barras={barras(true, "visitas")}
        formatar={numero}
        testId="trafego-mes"
      />
      <GraficoBarras
        titulo="Cadastros por mês"
        explicacao="Contas criadas segundo o Mixpanel; pode diferir um pouco do Funil, que lê o banco no fuso de São Paulo."
        series={SERIE_CADASTROS}
        barras={barras(true, "cadastros")}
        formatar={numero}
      />
      <GraficoBarras
        titulo="Visualizações por semana"
        explicacao="Semanas de segunda a domingo; as das pontas podem estar cortadas pelo período."
        series={SERIE_VISITAS}
        barras={barras(false, "visitas")}
        formatar={numero}
        testId="trafego-semana"
      />
      <section aria-label="Fontes de tráfego" className="rounded-lg border border-line px-4 pb-4 pt-5 sm:px-6">
        <h2 className="text-[16px] font-semibold tracking-normal! text-ink">Fontes</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Pela UTM de cada evento. "Cadastros por visualização" é só uma razão entre dois totais, não
          a taxa de conversão de um funil.
        </p>
        {data.fontes.length === 0 ? (
          <p className="mt-4 text-sm text-ink-soft">Sem eventos no período.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[11px] uppercase text-ink-mute">
                  <th className="py-2 pr-3 font-normal">Fonte</th>
                  <th className="py-2 pl-3 text-right font-normal">Visualizações</th>
                  <th className="py-2 pl-3 text-right font-normal">Cadastros</th>
                  <th className="py-2 pl-3 text-right font-normal">Cadastros por visualização</th>
                </tr>
              </thead>
              <tbody>
                {data.fontes.map((f) => (
                  <tr key={f.fonte} data-testid="trafego-fonte" className="border-b border-line/60">
                    <th scope="row" className="py-2 pr-3 text-left font-medium">
                      {f.fonte}
                    </th>
                    <td className="py-2 pl-3 text-right tabular-nums">{numero(f.visitas)}</td>
                    <td className="py-2 pl-3 text-right tabular-nums">{numero(f.cadastros)}</td>
                    <td className="py-2 pl-3 text-right tabular-nums">{textoPct(pct(f.cadastros, f.visitas))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
