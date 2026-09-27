import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { formatBRL } from "@/lib/formatBRL";
import { type Granularidade, rotuloBucket } from "@/lib/receitaPeriodo";
import { type ReceitaBucket, ROTULOS } from "./types";

/**
 * Série da Receita EuNeném (aperture-9bpre) — gráfico em CSS puro, sem
 * biblioteca, mais a tabela equivalente com os MESMOS números.
 *
 * Forma: barras divergentes sobre uma linha de base única. Taxas registradas
 * sobem, cancelamentos descem, e um ponto marca o resultado do intervalo
 * (que pode ficar abaixo da base). Uma só escala para os dois lados.
 *
 * Cores validadas contra a superfície clara (lilás-deep × âmbar 700): passam
 * em faixa de luminosidade, croma, separação para daltonismo e contraste. A
 * direção da barra é a segunda codificação — identidade nunca depende só da
 * cor. Texto usa tokens de tinta, nunca a cor da série.
 *
 * Teclado: o gráfico é UMA parada de tabulação; setas ←/→, Home e End
 * percorrem os intervalos. Cada intervalo anuncia os três valores.
 */

const ALTURA_PLOT_PX = 220;
/**
 * Largura mínima de coluna. Até 12 intervalos cabem em 375px sem rolagem; com
 * mais, as colunas afinam e o quadro rola por dentro quando preciso.
 */
function colunaMinPx(intervalos: number): number {
  return intervalos <= 12 ? 18 : 12;
}

const EIXO_SEM_CENTAVOS = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

/** Rótulo de eixo: sem centavos quando o valor é inteiro em reais. */
function formatEixo(cents: number): string {
  return cents % 100 === 0 ? EIXO_SEM_CENTAVOS.format(cents / 100) : formatBRL(cents);
}

/** Arredonda para cima em 1 / 2 / 5 × 10^k centavos. */
export function tetoLegivel(cents: number): number {
  if (cents <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(cents));
  const fracao = cents / magnitude;
  const passo = fracao <= 1 ? 1 : fracao <= 2 ? 2 : fracao <= 5 ? 5 : 10;
  return passo * magnitude;
}

export interface EscalaSerie {
  /** Topo do eixo (taxas registradas), em centavos. */
  readonly acima: number;
  /** Fundo do eixo (cancelamentos), em centavos, valor positivo. */
  readonly abaixo: number;
}

export function escalaDaSerie(serie: readonly ReceitaBucket[]): EscalaSerie {
  let acima = 0;
  let abaixo = 0;
  for (const bucket of serie) {
    acima = Math.max(acima, bucket.taxasRegistradasCents);
    abaixo = Math.max(abaixo, bucket.cancelamentosCents);
  }
  return { acima: tetoLegivel(acima), abaixo: tetoLegivel(abaixo) };
}

function rotuloCurto(bucket: ReceitaBucket, granularidade: Granularidade): string {
  const [ano, mes, dia] = bucket.inicio.split("-");
  if (granularidade === "mes") {
    const completo = rotuloBucket(bucket, "mes"); // "set/2031"
    return `${completo.slice(0, 3)}/${(ano ?? "").slice(2)}`;
  }
  return `${dia}/${mes}`;
}

function descricao(bucket: ReceitaBucket, granularidade: Granularidade): string {
  return [
    `${rotuloBucket(bucket, granularidade)}${bucket.parcial ? " (intervalo parcial)" : ""}`,
    `${ROTULOS.registradas} ${formatBRL(bucket.taxasRegistradasCents)}`,
    `${ROTULOS.cancelamentos} ${formatBRL(bucket.cancelamentosCents)}`,
    `${ROTULOS.resultado} ${formatBRL(bucket.resultadoDeTaxasCents)}`,
  ].join("; ");
}

export function ReceitaSerieChart({
  serie,
  granularidade,
}: {
  serie: readonly ReceitaBucket[];
  granularidade: Granularidade;
}) {
  // null = ninguém escolheu ainda: a leitura mostra o intervalo mais recente.
  const [ativo, setAtivo] = useState<number | null>(null);
  const colunas = useRef<Array<HTMLButtonElement | null>>([]);
  const rolagem = useRef<HTMLDivElement | null>(null);
  const intervalos = serie.length;
  const colunaMin = colunaMinPx(intervalos);

  // Com muitos intervalos o gráfico rola dentro do próprio quadro; começa no
  // fim, onde está o intervalo mais recente.
  const primeiroInicio = serie[0]?.inicio ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: refaz ao trocar de série, não a cada render
  useEffect(() => {
    // Série nova (outro período ou outra grade): volta à leitura padrão.
    setAtivo(null);
    const el = rolagem.current;
    if (el && intervalos > 0) el.scrollLeft = el.scrollWidth;
  }, [intervalos, granularidade, primeiroInicio]);
  const escala = escalaDaSerie(serie);
  const total = escala.acima + escala.abaixo;

  if (serie.length === 0 || total === 0) {
    return (
      <p className="rounded-md border border-line bg-paper p-5 text-[14px] text-ink-soft">
        Nenhuma taxa registrada ou cancelada neste período — não há o que desenhar. A tabela abaixo
        lista os intervalos mesmo assim.
      </p>
    );
  }

  const base = (escala.acima / total) * 100; // % a partir do topo
  const ultimo = serie.length - 1;
  const indice = ativo === null ? ultimo : Math.min(ativo, ultimo);
  const atual = serie[indice];
  const passoDesktop = Math.max(1, Math.ceil(serie.length / 12));
  const passoMobile = Math.max(1, Math.ceil(serie.length / 4));

  function mover(para: number) {
    const destino = Math.max(0, Math.min(serie.length - 1, para));
    setAtivo(destino);
    colunas.current[destino]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (event.key === "ArrowRight") mover(i + 1);
    else if (event.key === "ArrowLeft") mover(i - 1);
    else if (event.key === "Home") mover(0);
    else if (event.key === "End") mover(serie.length - 1);
    else return;
    event.preventDefault();
  }

  return (
    <figure className="min-w-0 rounded-md border border-line bg-paper p-4">
      <figcaption className="space-y-2">
        <p className="text-[14px] font-semibold text-ink">
          {ROTULOS.receita} por {granularidade === "mes" ? "mês" : "semana"}
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-soft">
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-3 rounded-sm bg-lilac-deep" />
            {ROTULOS.registradas} (acima da linha)
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-3 rounded-sm bg-amber-700" />
            {ROTULOS.cancelamentos} (abaixo da linha)
          </li>
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-full bg-ink ring-2 ring-paper"
            />
            {ROTULOS.resultado}
          </li>
        </ul>
        {atual ? (
          <p
            aria-hidden
            className="min-h-[2.5rem] rounded bg-cream-2/50 px-3 py-1.5 text-[12px] text-ink-soft"
            data-testid="receita-leitura"
          >
            <span className="font-semibold text-ink">
              {formatBRL(atual.resultadoDeTaxasCents)}
            </span>{" "}
            de resultado em {rotuloBucket(atual, granularidade)}
            {atual.parcial ? " (parcial)" : ""} · registradas{" "}
            {formatBRL(atual.taxasRegistradasCents)} · cancelamentos{" "}
            {formatBRL(atual.cancelamentosCents)}
          </p>
        ) : null}
      </figcaption>

      <div ref={rolagem} className="mt-3 overflow-x-auto">
        {/* O respiro vertical e à direita dá lugar aos rótulos que ficam
            centrados sobre as linhas e sob a última coluna. */}
        <div
          className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-2 py-2 pr-3"
          style={{ minWidth: `${64 + 8 + 12 + intervalos * colunaMin}px` }}
        >
          {/* Eixo: só os três valores que ancoram a leitura. */}
          <div
            aria-hidden
            className="relative font-mono text-[10px] tabular-nums text-ink-mute"
            style={{ height: ALTURA_PLOT_PX }}
          >
            <span className="absolute right-0 top-0 -translate-y-1/2 whitespace-nowrap">
              {formatEixo(escala.acima)}
            </span>
            <span
              className="absolute right-0 -translate-y-1/2 whitespace-nowrap text-ink-soft"
              style={{ top: `${base}%` }}
            >
              {formatEixo(0)}
            </span>
            {escala.abaixo > 0 ? (
              <span className="absolute bottom-0 right-0 translate-y-1/2 whitespace-nowrap">
                {formatEixo(-escala.abaixo)}
              </span>
            ) : null}
          </div>

          <div
            role="group"
            aria-label={`Gráfico: ${ROTULOS.registradas.toLowerCase()}, ${ROTULOS.cancelamentos.toLowerCase()} e ${ROTULOS.resultado.toLowerCase()} por intervalo. Use as setas para percorrer.`}
            className="relative flex"
            style={{ height: ALTURA_PLOT_PX }}
            onPointerLeave={(event) => {
              // Ponteiro saiu: volta ao intervalo mais recente, a menos que o
              // teclado esteja dentro do gráfico.
              if (!event.currentTarget.contains(document.activeElement)) setAtivo(null);
            }}
          >
            <span aria-hidden className="absolute inset-x-0 top-0 border-t border-line" />
            {escala.abaixo > 0 ? (
              <span aria-hidden className="absolute inset-x-0 bottom-0 border-t border-line" />
            ) : null}
            <span
              aria-hidden
              className="absolute inset-x-0 border-t border-ink-mute"
              style={{ top: `${base}%` }}
            />
            {serie.map((bucket, i) => {
              const sobe = (bucket.taxasRegistradasCents / total) * 100;
              const desce = (bucket.cancelamentosCents / total) * 100;
              const ponto = base - (bucket.resultadoDeTaxasCents / total) * 100;
              const temEvento =
                bucket.taxasRegistradasCents > 0 || bucket.cancelamentosCents > 0;
              return (
                <button
                  key={bucket.inicio}
                  ref={(el) => {
                    colunas.current[i] = el;
                  }}
                  type="button"
                  tabIndex={i === indice ? 0 : -1}
                  aria-label={descricao(bucket, granularidade)}
                  onFocus={() => setAtivo(i)}
                  onPointerEnter={() => setAtivo(i)}
                  onKeyDown={(event) => onKeyDown(event, i)}
                  style={{ minWidth: colunaMin }}
                  className={[
                    "relative h-full flex-1 cursor-default rounded-sm bg-transparent",
                    "hover:bg-cream-2/60 focus-visible:bg-cream-2/60",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-plum",
                  ].join(" ")}
                >
                  {bucket.taxasRegistradasCents > 0 ? (
                    <span
                      aria-hidden
                      className="absolute left-1/2 min-h-[2px] w-[min(24px,70%)] -translate-x-1/2 rounded-t bg-lilac-deep"
                      style={{ bottom: `${100 - base}%`, height: `${sobe}%` }}
                    />
                  ) : null}
                  {bucket.cancelamentosCents > 0 ? (
                    <span
                      aria-hidden
                      className="absolute left-1/2 min-h-[2px] w-[min(24px,70%)] -translate-x-1/2 rounded-b bg-amber-700"
                      style={{ top: `${base}%`, height: `${desce}%` }}
                    />
                  ) : null}
                  {temEvento ? (
                    <span
                      aria-hidden
                      className="absolute left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-2 ring-paper"
                      style={{ top: `${ponto}%` }}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div aria-hidden />
          <div aria-hidden className="mt-1.5 flex font-mono text-[10px] text-ink-mute">
            {serie.map((bucket, i) => (
              <span
                key={bucket.inicio}
                className="relative h-4 flex-1"
                style={{ minWidth: colunaMin }}
              >
                {/* Contado a partir do fim: o intervalo mais recente sempre tem rótulo. */}
                {(ultimo - i) % passoDesktop === 0 ? (
                  <span
                    className={[
                      "absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap",
                      (ultimo - i) % passoMobile === 0 ? "" : "max-sm:hidden",
                    ].join(" ")}
                  >
                    {rotuloCurto(bucket, granularidade)}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

/** Tabela equivalente ao gráfico: os mesmos intervalos, os mesmos valores. */
export function ReceitaSerieTabela({
  serie,
  granularidade,
  somaSerie,
}: {
  serie: readonly ReceitaBucket[];
  granularidade: Granularidade;
  somaSerie: { taxasRegistradasCents: number; cancelamentosCents: number };
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-paper">
      <table className="min-w-full divide-y divide-line text-left text-[12px]">
        <caption className="px-3 py-2 text-left text-[12px] text-ink-soft">
          Mesmos valores do gráfico, por {granularidade === "mes" ? "mês" : "semana"}. Horário de
          São Paulo.
        </caption>
        <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.12em] text-ink-mute">
          <tr>
            <th scope="col" className="px-3 py-2">
              Intervalo
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {ROTULOS.registradas}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {ROTULOS.cancelamentos}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {ROTULOS.resultado}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {serie.map((bucket) => (
            <tr key={bucket.inicio} className="align-top">
              <th scope="row" className="whitespace-nowrap px-3 py-2 font-normal text-ink">
                {rotuloBucket(bucket, granularidade)}
                {bucket.parcial ? (
                  <span className="ml-1 text-[10px] text-ink-mute">(parcial)</span>
                ) : null}
              </th>
              <Valor cents={bucket.taxasRegistradasCents} />
              <Valor cents={bucket.cancelamentosCents} />
              <Valor cents={bucket.resultadoDeTaxasCents} forte />
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-line bg-cream-2/40">
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">
              Soma da série
            </th>
            <Valor cents={somaSerie.taxasRegistradasCents} />
            <Valor cents={somaSerie.cancelamentosCents} />
            <Valor
              cents={somaSerie.taxasRegistradasCents - somaSerie.cancelamentosCents}
              forte
            />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function Valor({ cents, forte = false }: { cents: number; forte?: boolean }) {
  return (
    <td
      className={`whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums ${
        forte ? "font-semibold text-ink" : "text-ink-soft"
      }`}
    >
      {formatBRL(cents)}
    </td>
  );
}
