import { EIXO, MONO } from "../receita/ReceitaPainel";

/**
 * Gráfico de barras (empilhadas) das seções de Estatísticas (aperture-lcug3).
 *
 * Mesma linguagem visual da aba Receita: barras em CSS, uma escala única,
 * período parcial em tom claro, valor acima da barra e rótulo abaixo do eixo.
 * Com muitas barras (semanas de 12 meses) o gráfico rola por dentro; a
 * página não.
 */

export interface SerieGrafico {
  chave: string;
  nome: string;
  /** Classe de fundo do período fechado e do parcial. */
  cor: string;
  corParcial: string;
}

export interface BarraGrafico {
  chave: string;
  rotulo: string;
  /** Texto completo (tooltip / leitor de tela). */
  titulo: string;
  parcial: boolean;
  /** Valor por série; null = não medido (não vira zero). */
  valores: Record<string, number | null>;
}

export function GraficoBarras({
  titulo,
  explicacao,
  series,
  barras,
  formatar,
  testId,
  agrupado = false,
}: {
  titulo: string;
  explicacao: string;
  series: readonly SerieGrafico[];
  barras: readonly BarraGrafico[];
  formatar: (n: number) => string;
  testId?: string;
  /** Barras lado a lado por série (séries que se sobrepõem, ex.: etapas do funil). */
  agrupado?: boolean;
}) {
  const totais = barras.map((b) =>
    series.reduce((n, s) => n + Math.max(0, b.valores[s.chave] ?? 0), 0),
  );
  const max = Math.max(
    1,
    ...(agrupado
      ? barras.flatMap((b) => series.map((s) => b.valores[s.chave] ?? 0))
      : totais),
  );
  const largo = barras.length * (agrupado ? series.length : 1) > 14;
  return (
    <section
      aria-label={titulo}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-line px-4 pb-4 pt-5 sm:px-6"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-[16px] font-semibold tracking-normal! text-ink">{titulo}</h2>
        <p className="text-sm text-ink-soft">{explicacao}</p>
      </div>
      {series.length > 1 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Legenda">
          {series.map((s) => (
            <li key={s.chave} className={`flex items-center gap-1.5 ${MONO}`}>
              <span aria-hidden className={`size-2.5 rounded-sm ${s.cor}`} />
              {s.nome}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative overflow-x-auto">
        <div className={`flex flex-col ${largo ? "min-w-[900px]" : "min-w-[320px]"}`}>
          <ol className="flex h-[200px] items-stretch gap-1.5 sm:gap-3">
            {barras.map((b, i) => {
              const medido = series.some((s) => b.valores[s.chave] != null);
              return (
                <li
                  key={b.chave}
                  data-testid={testId}
                  data-parcial={b.parcial}
                  title={b.titulo}
                  aria-label={b.titulo}
                  className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
                >
                  {agrupado ? (
                    <div aria-hidden className="flex h-full w-full items-end justify-center gap-0.5">
                      {series.map((s) => {
                        const v = b.valores[s.chave];
                        return (
                          <div
                            key={s.chave}
                            data-serie={s.chave}
                            className="flex h-full min-w-0 max-w-[28px] flex-1 flex-col items-center justify-end gap-0.5"
                          >
                            {/* Muitos grupos: os valores ficam só no detalhe da barra. */}
                            {barras.length <= 14 ? (
                              <span className="font-mono text-[9px] text-ink-mute">
                                {v == null ? "—" : formatar(v)}
                              </span>
                            ) : null}
                            <div
                              className={`w-full rounded-t-[2px] ${b.parcial ? s.corParcial : s.cor} ${
                                (v ?? 0) > 0 ? "min-h-[2px]" : ""
                              }`}
                              style={{ height: `${(((v ?? 0) / max) * 80).toFixed(2)}%` }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <>
                  <span
                    className={`whitespace-nowrap font-mono text-[10px] ${
                      b.parcial ? "text-ink-mute" : "text-ink"
                    }`}
                  >
                    {medido ? formatar(totais[i]!) : "—"}
                  </span>
                  <div
                    aria-hidden
                    className={`flex w-full max-w-[56px] flex-col-reverse overflow-hidden rounded-t-[3px] ${
                      totais[i]! > 0 ? "min-h-[2px]" : ""
                    }`}
                    style={{ height: `${((totais[i]! / max) * 84).toFixed(2)}%` }}
                  >
                    {series.map((s) => {
                      const v = Math.max(0, b.valores[s.chave] ?? 0);
                      if (v === 0) return null;
                      return (
                        <div
                          key={s.chave}
                          data-serie={s.chave}
                          className={b.parcial ? s.corParcial : s.cor}
                          style={{ height: `${((v / totais[i]!) * 100).toFixed(2)}%` }}
                        />
                      );
                    })}
                  </div>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
          <div className={`flex gap-1.5 border-t pt-2 sm:gap-3 ${EIXO}`} aria-hidden>
            {barras.map((b) => (
              <span
                key={b.chave}
                className={`min-w-0 flex-1 truncate text-center font-mono text-[10px] ${
                  b.parcial ? "text-ink" : "text-ink-mute"
                }`}
              >
                {b.rotulo}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
