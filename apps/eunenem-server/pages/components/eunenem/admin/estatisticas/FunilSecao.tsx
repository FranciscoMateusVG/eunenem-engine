import { GraficoBarras, type SerieGrafico } from "./GraficoBarras";
import { numero, pct, rotuloBucket, textoPct, tituloBucket } from "./formato";
import type { FunilData, FunilEtapa, FunilOrigem } from "./types";

/**
 * Seção Funil (aperture-lcug3), sobre `admin.analytics.funil`.
 *
 * Coortes de cadastro: quem se cadastrou no período e, até agora, alcançou
 * cada marco. Os marcos são observados de forma independente (a lista pode
 * nascer antes do onboarding), então a porcentagem é sempre "do cadastro",
 * nunca "da etapa anterior".
 */

export const ROTULO_ETAPA: Record<FunilEtapa, string> = {
  cadastro: "Cadastro",
  onboarding: "Onboarding concluído",
  lista_criada: "Lista criada",
  primeiro_presente: "1º presente recebido",
};

const ROTULO_ORIGEM: Record<FunilOrigem, string> = {
  google_ads: "Google Ads",
  organico: "Orgânico",
  direto: "Direto",
  outros: "Outras origens",
  desconhecida: "Sem registro (antes da atribuição)",
};

const SERIES: readonly SerieGrafico[] = [
  { chave: "cadastro", nome: ROTULO_ETAPA.cadastro, cor: "bg-plum", corParcial: "bg-plum/40" },
  { chave: "onboarding", nome: ROTULO_ETAPA.onboarding, cor: "bg-lilac-deep", corParcial: "bg-lilac-soft" },
  { chave: "lista_criada", nome: ROTULO_ETAPA.lista_criada, cor: "bg-blue-deep", corParcial: "bg-blue-soft" },
  { chave: "primeiro_presente", nome: ROTULO_ETAPA.primeiro_presente, cor: "bg-green-deep", corParcial: "bg-green" },
];

export function FunilSecao({ data }: { data: FunilData }) {
  const graficoDe = (mensal: boolean) => (mensal ? data.meses : data.semanas).map((b) => ({
    chave: b.de,
    rotulo: rotuloBucket(b, mensal),
    titulo: `${tituloBucket(b, mensal)}: ${data.etapas
      .map((e) => `${ROTULO_ETAPA[e]} ${numero(b.contagens[e])}`)
      .join(" · ")}`,
    parcial: b.parcial,
    valores: b.contagens,
  }));
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <ol aria-label="Etapas do funil" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.etapas.map((e) => (
          <li key={e} data-testid="funil-etapa" className="rounded-xl border border-line p-4">
            <div className="text-sm text-ink-soft">{ROTULO_ETAPA[e]}</div>
            <div className="text-2xl font-semibold tabular-nums">{numero(data.totais[e])}</div>
            {e !== "cadastro" ? (
              <div className="font-mono text-[11px] text-ink-mute">
                {textoPct(pct(data.totais[e], data.totais.cadastro))} dos cadastros
              </div>
            ) : (
              <div className="font-mono text-[11px] text-ink-mute">cadastros no período</div>
            )}
          </li>
        ))}
      </ol>
      <p className="text-sm text-ink-soft">
        Quem se cadastrou no período e até agora chegou a cada etapa. As etapas são medidas
        separadamente (a lista é criada no cadastro, às vezes antes do onboarding), por isso a
        porcentagem é sempre sobre os cadastros.
      </p>
      <GraficoBarras
        agrupado
        titulo="Funil por mês de cadastro"
        explicacao="Cada grupo é a turma que se cadastrou no mês. Turmas recentes ainda podem avançar."
        series={SERIES}
        barras={graficoDe(true)}
        formatar={numero}
        testId="funil-mes"
      />
      <GraficoBarras
        agrupado
        titulo="Funil por semana de cadastro"
        explicacao="Semanas de segunda a domingo; as das pontas podem estar cortadas pelo período."
        series={SERIES}
        barras={graficoDe(false)}
        formatar={numero}
        testId="funil-semana"
      />
      <section aria-label="Funil por origem" className="rounded-lg border border-line px-4 pb-4 pt-5 sm:px-6">
        <h2 className="text-[16px] font-semibold tracking-normal! text-ink">Por origem do primeiro acesso</h2>
        <p className="mt-1 text-sm text-ink-soft">
          De onde a pessoa veio na primeira visita (gclid/UTM). Contas criadas antes da atribuição
          aparecem como "sem registro".
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[11px] uppercase text-ink-mute">
                <th className="py-2 pr-3 font-normal">Origem</th>
                {data.etapas.map((e) => (
                  <th key={e} className="py-2 pl-3 text-right font-normal">
                    {ROTULO_ETAPA[e]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.porOrigem.map((o) => (
                <tr key={o.origem} data-testid="funil-origem" className="border-b border-line/60">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    {ROTULO_ORIGEM[o.origem]}
                  </th>
                  {data.etapas.map((e) => (
                    <td key={e} className="py-2 pl-3 text-right tabular-nums">
                      {numero(o.contagens[e])}
                      {e !== "cadastro" ? (
                        <span className="ml-1 font-mono text-[11px] text-ink-mute">
                          {textoPct(pct(o.contagens[e], o.contagens.cadastro))}
                        </span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
