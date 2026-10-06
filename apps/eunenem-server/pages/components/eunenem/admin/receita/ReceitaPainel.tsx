import { formatBRL } from "@/lib/formatBRL";
import {
  alturasPareadas,
  faixaKpiMes,
  faixaKpiSemana,
  formatCompacto,
  nomeMes,
  notaSemana,
  rotuloMesCurto,
  rotuloSemana,
} from "@/lib/receitaPainel";
import { formatLocalDate } from "@/lib/receitaPeriodo";
import type { ReceitaPainelData } from "./types";

/**
 * Painel da aba Receita EuNeném, proposta 1b (aperture-zn5cm).
 *
 * Duas séries lado a lado, cada uma na própria escala: Tarifas EuNeném
 * (lilás) e Recebido no banco (teal). O mês corrente e a semana corrente
 * aparecem em tom claro; semanas futuras do mês, tracejadas e com "—".
 * Tudo vem de UMA resposta de `admin.receita.painel`.
 */

const MONO = "font-mono text-[11px] text-ink-mute";

/** Tom da coluna de valor de cada série (texto sobre branco). */
const TEXTO_TARIFAS = "text-[#7d4f97]";
const TEXTO_RECEBIDO = "text-[#2f6e74]";
const EIXO = "border-[#d9c9d3]";

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function Amostra({ cor, tamanho = "size-2" }: { cor: string; tamanho?: string }) {
  return <span aria-hidden className={`${tamanho} shrink-0 rounded-[2px] ${cor}`} />;
}

export function ReceitaCabecalho({ hoje }: { hoje: string | null }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[30px] font-semibold tracking-[-0.02em] text-ink">Receita EuNeném</h1>
        <p className="text-[14px] text-ink-soft">Taxas da plataforma menos cancelamentos.</p>
      </div>
      {hoje ? (
        <p className="font-mono text-[11px] tracking-[0.05em] text-ink-mute">
          Atualizado {formatLocalDate(hoje)} · horário de São Paulo
        </p>
      ) : null}
    </header>
  );
}

function ColunaKpi({
  serie,
  rotulo,
  cor,
  valor,
  comparacao,
  divisor = false,
}: {
  serie: "tarifas" | "recebido";
  rotulo: string;
  cor: string;
  valor: number;
  comparacao: string;
  divisor?: boolean;
}) {
  return (
    <div
      data-testid={`receita-kpi-${serie}`}
      className={`flex min-w-0 flex-col gap-1 ${
        divisor ? "border-t border-line pt-4 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-5" : ""
      }`}
    >
      <span className="flex items-center gap-1.5 text-[12px] text-ink-soft">
        <Amostra cor={cor} />
        {rotulo}
      </span>
      <p
        data-testid="receita-kpi-valor"
        className="whitespace-nowrap text-[34px] font-semibold leading-[1.1] tracking-[-0.02em] text-ink tabular-nums"
      >
        {formatBRL(valor)}
      </p>
      <p data-testid="receita-kpi-comparacao" className="text-[12px] text-ink-soft">
        {comparacao}
      </p>
    </div>
  );
}

function CartaoKpi({
  testId,
  titulo,
  faixa,
  atual,
  anterior,
  rotuloAnterior,
}: {
  testId: string;
  titulo: string;
  faixa: string;
  atual: ReceitaPainelData["kpis"]["mesAtual"];
  anterior: ReceitaPainelData["kpis"]["mesAnterior"];
  rotuloAnterior: string;
}) {
  return (
    <article
      data-testid={testId}
      aria-label={titulo}
      className="flex flex-col gap-4 rounded-lg border border-line px-6 py-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-soft">
          {titulo}
        </h3>
        <span data-testid="receita-kpi-faixa" className={MONO}>
          {faixa}
        </span>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <ColunaKpi
          serie="tarifas"
          rotulo="Tarifas EuNeném"
          cor="bg-lilac-deep"
          valor={atual.tarifas.resultadoCents}
          comparacao={`${rotuloAnterior}: ${formatBRL(anterior.tarifas.resultadoCents)}`}
        />
        <ColunaKpi
          serie="recebido"
          rotulo="Recebido no banco"
          cor="bg-blue-deep"
          valor={atual.recebido.resultadoCents}
          comparacao={`${rotuloAnterior}: ${formatBRL(anterior.recebido.resultadoCents)}`}
          divisor
        />
      </div>
    </article>
  );
}

export function ReceitaKpis({ kpis }: Pick<ReceitaPainelData, "kpis">) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CartaoKpi
        testId="receita-kpi-mes"
        titulo="Mês atual"
        faixa={faixaKpiMes(kpis.mesAtual)}
        atual={kpis.mesAtual}
        anterior={kpis.mesAnterior}
        rotuloAnterior={capitalizar(nomeMes(kpis.mesAnterior.de))}
      />
      <CartaoKpi
        testId="receita-kpi-semana"
        titulo="Semana atual"
        faixa={faixaKpiSemana(kpis.semanaAtual)}
        atual={kpis.semanaAtual}
        anterior={kpis.semanaAnterior}
        rotuloAnterior="Semana anterior"
      />
    </div>
  );
}

function Legenda() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4 text-[12px] text-ink-soft">
        <span className="flex items-center gap-1.5">
          <Amostra cor="bg-lilac-deep" tamanho="size-2.5" />
          Tarifas EuNeném
        </span>
        <span className="flex items-center gap-1.5">
          <Amostra cor="bg-blue-deep" tamanho="size-2.5" />
          Recebido no banco
        </span>
      </div>
      <span className={MONO}>cada série na sua própria escala</span>
    </div>
  );
}

function Grafico({
  titulo,
  legenda,
  children,
}: {
  titulo: string;
  legenda: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5 rounded-lg border border-line px-6 pb-4 pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[16px] font-semibold text-ink">{titulo}</h2>
        <span className={MONO}>{legenda}</span>
      </div>
      {/* Em telas estreitas o gráfico rola por dentro; a página não. */}
      <div className="overflow-x-auto lg:overflow-visible">{children}</div>
    </section>
  );
}

function maximo(valores: readonly number[]): number {
  return Math.max(...valores, 1);
}

function BarrasPareadas({
  alturas,
  corTarifas,
  corRecebido,
  largura,
  raio,
  futura = false,
}: {
  alturas: { max: number; t: number; r: number };
  corTarifas: string;
  corRecebido: string;
  largura: string;
  raio: string;
  futura?: boolean;
}) {
  const borda = futura ? `border border-b-0 border-dashed ${EIXO}` : "";
  return (
    <div
      aria-hidden
      className={`flex w-full items-end ${largura}`}
      style={{ height: `${alturas.max.toFixed(2)}%` }}
    >
      <div
        className={`min-h-[2px] flex-1 ${raio} ${corTarifas} ${borda}`}
        style={{ height: `${alturas.t.toFixed(2)}%` }}
      />
      <div
        className={`min-h-[2px] flex-1 ${raio} ${corRecebido} ${borda}`}
        style={{ height: `${alturas.r.toFixed(2)}%` }}
      />
    </div>
  );
}

export function ReceitaPorMes({ meses }: Pick<ReceitaPainelData, "meses">) {
  const maxT = maximo(meses.map((m) => m.tarifas.resultadoCents));
  const maxR = maximo(meses.map((m) => m.recebido.resultadoCents));
  const corrente = meses.at(-1);
  const legenda = `últimos ${meses.length} meses${
    corrente?.parcial ? ` · ${nomeMes(corrente.de)} em andamento` : ""
  }`;
  return (
    <Grafico titulo="Por mês" legenda={legenda}>
      <div className="flex min-w-[860px] flex-col px-2 lg:min-w-0 lg:px-0">
        <ol className="flex h-[220px] items-stretch gap-3">
          {meses.map((m) => {
            const titulo = `${nomeMes(m.de)} ${m.de.slice(0, 4)}${
              m.parcial ? " (parcial)" : ""
            } · tarifas ${formatBRL(m.tarifas.resultadoCents)} · recebido ${formatBRL(
              m.recebido.resultadoCents,
            )}`;
            const peso = m.parcial ? "font-semibold" : "font-normal";
            return (
              <li
                key={m.de}
                data-testid="receita-mes"
                data-mes={m.de}
                data-parcial={m.parcial}
                title={titulo}
                aria-label={titulo}
                className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
              >
                <div className="flex flex-col items-center gap-px font-mono text-[10px]">
                  <span data-serie="recebido" className={`whitespace-nowrap ${TEXTO_RECEBIDO} ${peso}`}>
                    {formatCompacto(m.recebido.resultadoCents)}
                  </span>
                  <span data-serie="tarifas" className={`whitespace-nowrap ${TEXTO_TARIFAS} ${peso}`}>
                    {formatCompacto(m.tarifas.resultadoCents)}
                  </span>
                </div>
                <BarrasPareadas
                  alturas={alturasPareadas(
                    m.tarifas.resultadoCents,
                    m.recebido.resultadoCents,
                    maxT,
                    maxR,
                    84,
                  )}
                  corTarifas={m.parcial ? "bg-lilac-soft" : "bg-lilac-deep"}
                  corRecebido={m.parcial ? "bg-blue-soft" : "bg-blue-deep"}
                  largura="max-w-[60px] gap-[3px]"
                  raio="rounded-t-[3px]"
                />
              </li>
            );
          })}
        </ol>
        <div className={`flex gap-3 border-t pt-2 ${EIXO}`} aria-hidden>
          {meses.map((m) => (
            <span
              key={m.de}
              className={`min-w-0 flex-1 text-center font-mono text-[11px] ${
                m.parcial ? "text-ink" : "text-ink-mute"
              }`}
            >
              {rotuloMesCurto(m.de)}
            </span>
          ))}
        </div>
      </div>
    </Grafico>
  );
}

export function ReceitaSemanasDoMes({
  semanas,
  mes,
}: Pick<ReceitaPainelData, "semanas"> & { mes: string }) {
  const visiveis = semanas.filter((s) => s.estado !== "futura");
  const maxT = maximo(visiveis.map((s) => s.tarifas.resultadoCents));
  const maxR = maximo(visiveis.map((s) => s.recebido.resultadoCents));
  return (
    <Grafico titulo={`Semanas de ${nomeMes(mes)}`} legenda="semana de segunda a domingo">
      <div className="flex min-w-[520px] flex-col px-2 lg:min-w-0 lg:px-0">
        <ol className="flex h-[180px] items-stretch gap-6">
          {semanas.map((s) => {
            const futura = s.estado === "futura";
            const atual = s.estado === "atual";
            const peso = atual ? "font-semibold" : "font-normal";
            const rotulo = rotuloSemana(s);
            return (
              <li
                key={s.de}
                data-testid="receita-semana"
                data-de={s.de}
                data-estado={s.estado}
                aria-label={
                  futura
                    ? `${rotulo}: ainda não começou`
                    : `${rotulo}${atual ? " (esta semana)" : ""} · tarifas ${formatBRL(
                        s.tarifas.resultadoCents,
                      )} · recebido ${formatBRL(s.recebido.resultadoCents)}`
                }
                className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
              >
                <div className="flex flex-col items-center gap-px font-mono text-[11px]">
                  <span data-serie="recebido" className={`whitespace-nowrap ${TEXTO_RECEBIDO} ${peso}`}>
                    {futura ? "" : formatBRL(s.recebido.resultadoCents)}
                  </span>
                  <span
                    data-serie="tarifas"
                    className={`whitespace-nowrap ${futura ? "text-ink-mute" : TEXTO_TARIFAS} ${peso}`}
                  >
                    {futura ? "—" : formatBRL(s.tarifas.resultadoCents)}
                  </span>
                </div>
                <BarrasPareadas
                  alturas={
                    futura
                      ? { max: 0, t: 0, r: 0 }
                      : alturasPareadas(
                          s.tarifas.resultadoCents,
                          s.recebido.resultadoCents,
                          maxT,
                          maxR,
                          76,
                        )
                  }
                  corTarifas={atual ? "bg-lilac-soft" : futura ? "bg-transparent" : "bg-lilac-deep"}
                  corRecebido={atual ? "bg-blue-soft" : futura ? "bg-transparent" : "bg-blue-deep"}
                  largura="max-w-[112px] gap-1"
                  raio="rounded-t-[4px]"
                  futura={futura}
                />
              </li>
            );
          })}
        </ol>
        <div className={`flex gap-6 border-t pt-2 ${EIXO}`} aria-hidden>
          {semanas.map((s) => (
            <div key={s.de} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
              <span
                className={`font-mono text-[11px] ${
                  s.estado === "atual" ? "text-ink" : "text-ink-soft"
                }`}
              >
                {rotuloSemana(s)}
              </span>
              <span className="font-mono text-[10px] text-ink-mute">{notaSemana(s)}</span>
            </div>
          ))}
        </div>
      </div>
    </Grafico>
  );
}

/**
 * Aviso compacto: só aparece quando há algo a conferir. Sem nada, a tela é
 * exatamente o 1b. Nenhum valor exibido foi ajustado por causa disto.
 */
export function ReceitaAvisoPainel({
  diferencaConciliacao,
  inconsistencias,
}: Pick<ReceitaPainelData, "diferencaConciliacao" | "inconsistencias">) {
  const itens: { id: string; texto: string }[] = [];
  // Cada série divergente com os dois deltas: registro e cancelamento podem
  // divergir no mesmo valor e se anular na subtração.
  const divergentes = (["tarifas", "recebido"] as const)
    .filter((serie) => {
      const d = diferencaConciliacao[serie];
      return d.registradoCents !== 0 || d.canceladoCents !== 0;
    })
    .map((serie) => {
      const d = diferencaConciliacao[serie];
      return `${serie}: ${formatBRL(d.registradoCents)} em registros e ${formatBRL(
        d.canceladoCents,
      )} em cancelamentos`;
    });
  if (divergentes.length > 0) {
    itens.push({
      id: "receita-aviso-conciliacao",
      texto: `A soma por dia não bate com o total independente. Diferença em ${divergentes.join(
        "; ",
      )}.`,
    });
  }
  const { estornadoSemCancelamento: estornado, canceladoSemEstorno: cancelado } =
    inconsistencias;
  if (estornado.count > 0) {
    itens.push({
      id: "receita-aviso-estornado",
      texto: `${estornado.count} taxa(s) de pagamento estornado sem data de cancelamento (${formatBRL(
        estornado.cents,
      )}): seguem somadas.`,
    });
  }
  if (cancelado.count > 0) {
    itens.push({
      id: "receita-aviso-cancelado",
      texto: `${cancelado.count} taxa(s) cancelada(s) com pagamento não estornado (${formatBRL(
        cancelado.cents,
      )}): descontadas na data do cancelamento.`,
    });
  }
  if (itens.length === 0) return null;
  return (
    <aside
      role="status"
      aria-label="Conferir"
      data-testid="receita-aviso"
      className="flex flex-col gap-1 rounded-lg border border-line px-6 py-3 text-[12px] text-ink-soft"
    >
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-soft">
        Conferir
      </p>
      {itens.map((item) => (
        <p key={item.id} data-testid={item.id}>
          {item.texto}
        </p>
      ))}
      <p className="text-ink-mute">Nenhum valor foi ajustado.</p>
    </aside>
  );
}

export function ReceitaNotas() {
  return (
    <div className="flex flex-col gap-1 text-[12px] text-ink-mute">
      <p>
        <span className="text-ink-soft">Tarifas EuNeném:</span> taxas registradas na data do
        pagamento aprovado, menos cancelamentos na data em que ocorreram.
      </p>
      <p>
        <span className="text-ink-soft">Recebido no banco:</span> soma dos pagamentos aprovados,
        menos estornos. É uma estimativa: o custo do provedor e o valor que de fato caiu na conta
        não são registrados. Estornos parciais, disputas e chargebacks não são registrados e
        ficam fora.
      </p>
    </div>
  );
}

/** Painel puro: tudo o que vem de UMA resposta de `admin.receita.painel`. */
export function ReceitaPainel({ data }: { data: ReceitaPainelData }) {
  return (
    <>
      <ReceitaAvisoPainel
        diferencaConciliacao={data.diferencaConciliacao}
        inconsistencias={data.inconsistencias}
      />
      <ReceitaKpis kpis={data.kpis} />
      <div className="flex flex-col gap-4">
        <Legenda />
        <ReceitaPorMes meses={data.meses} />
      </div>
      <ReceitaSemanasDoMes semanas={data.semanas} mes={data.kpis.mesAtual.de} />
      <ReceitaNotas />
    </>
  );
}
