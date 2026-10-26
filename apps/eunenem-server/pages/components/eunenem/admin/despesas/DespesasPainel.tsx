import { formatBRL } from "@/lib/formatBRL";
import { barraDespesas, type Completude, completude } from "@/lib/despesasPainel";
import {
  faixaKpiMes,
  faixaKpiSemana,
  formatCompacto,
  nomeMes,
  notaSemana,
  rotuloMesCurto,
  rotuloSemana,
} from "@/lib/receitaPainel";
import { formatLocalDate } from "@/lib/receitaPeriodo";
import {
  Amostra,
  capitalizar,
  EIXO,
  Grafico,
  MONO,
  maximo,
} from "../receita/ReceitaPainel";
import { formatInstante } from "../receita/types";
import type { CoberturaDespesasData, DespesasPainelData } from "./types";

/**
 * Painel da aba Despesas (aperture-5qoz0 PR3), no mesmo grid e estilo da
 * Receita 1b.
 *
 * Tarifas de processamento OBSERVADAS no provedor, pela data do débito.
 * Uma barra empilhada por período: a altura é o total (escala única) e a
 * fatia de baixo é a parte da Stripe; o resto é Inter.
 *
 * Cada período exibido (KPI, comparação, barra) traz a própria cobertura.
 * Período com tarifa pendente ou falha mostra só o subtotal observado,
 * marcado como tal; sem nada observado, "— pendente" — nunca R$ 0.
 * Tudo vem de UMA resposta de `admin.despesas.painel`.
 */

type Bucket = DespesasPainelData["kpis"]["mesAtual"];
type Contagem = Bucket["cobertura"]["stripe"];
type Serie = "stripe" | "inter" | "manual" | "total";

const COR_STRIPE = { forte: "bg-coral-pink", clara: "bg-pink-soft" };
const COR_INTER = { forte: "bg-green-deep", clara: "bg-green" };
/** Recorrentes/manuais (aperture-0ngn4). */
const COR_MANUAL = { forte: "bg-lilac-deep", clara: "bg-lilac" };

function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

/** "7 confirmadas · 3 pendentes · 1 falha". Pendente é escrito, nunca zero. */
export function resumoCobertura(c: Contagem, meio: "cartão" | "PIX"): string {
  if (c.confirmados + c.pendentes + c.falhos === 0) {
    return `nenhum pagamento com ${meio} no período`;
  }
  const partes = [plural(c.confirmados, "confirmada", "confirmadas")];
  if (c.semTarifa) partes.push(`${c.semTarifa} PIX sem tarifa – franquia`);
  if (c.pendentes > 0) partes.push(plural(c.pendentes, "pendente", "pendentes"));
  if (c.falhos > 0) partes.push(plural(c.falhos, "falha", "falhas"));
  if (c.pendentes === 0 && c.falhos === 0) partes.push("nenhuma pendente");
  return partes.join(" · ");
}

/** Manuais são valor conhecido: nunca deixam um período incompleto. */
function completudeDe(b: Bucket, serie: Serie): Completude {
  if (serie === "stripe") return completude(b.cobertura.stripe);
  if (serie === "inter") return completude(b.cobertura.inter);
  if (serie === "manual") return "completo";
  return completude(b.cobertura.stripe, b.cobertura.inter);
}

function centsDe(b: Bucket, serie: Serie): number {
  if (serie === "stripe") return b.stripeCents;
  if (serie === "inter") return b.interCents;
  if (serie === "manual") return b.manualCents;
  return b.totalCents;
}

/** "2 lançamentos · confirmados" — manuais são sempre confirmados. */
export function resumoManuais(c: Contagem): string {
  if (c.confirmados === 0) return "nenhum lançamento no período";
  return `${plural(c.confirmados, "lançamento", "lançamentos")} · ${
    c.confirmados === 1 ? "confirmado" : "confirmados"
  }`;
}

/**
 * Valor de uma série num período: "R$ X" (completo), "R$ X observados"
 * (subtotal), "R$ X observados · incompleto" (total), ou "— pendente" /
 * "— falha" quando nada foi observado.
 */
export function valorDoPeriodo(b: Bucket, serie: Serie): { valor: string; marca: string | null } {
  const estado = completudeDe(b, serie);
  const cents = centsDe(b, serie);
  if (estado === "completo") return { valor: formatBRL(cents), marca: null };
  if (cents === 0) return { valor: `— ${estado}`, marca: null };
  return {
    valor: formatBRL(cents),
    marca: serie === "total" ? "observados · incompleto" : "observados",
  };
}

function textoDoPeriodo(b: Bucket, serie: Serie): string {
  const { valor, marca } = valorDoPeriodo(b, serie);
  return marca ? `${valor} ${marca}` : valor;
}

function ultimaLeitura(iso: string | null): string {
  return iso ? `última leitura ${formatInstante(iso)}` : "nenhuma leitura ainda";
}

export function DespesasCabecalho({ hoje }: { hoje: string | null }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[30px] font-semibold tracking-[-0.02em]! text-ink">Despesas</h1>
        <p className="text-[14px] text-ink-soft">
          Tarifas de processamento cobradas pelos provedores, na data do débito, e despesas
          recorrentes/manuais cadastradas aqui.
        </p>
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
  atual,
  anterior,
  rotuloAnterior,
  detalhe,
}: {
  serie: Serie;
  rotulo: string;
  cor: string | null;
  atual: Bucket;
  anterior: Bucket;
  rotuloAnterior: string;
  detalhe?: string;
}) {
  const { valor, marca } = valorDoPeriodo(atual, serie);
  const completo = completudeDe(atual, serie) === "completo";
  const semValor = !completo && marca === null;
  return (
    <div
      data-testid={`despesas-kpi-${serie}`}
      className="@container flex min-w-0 flex-col gap-1 border-t border-line pt-3 [overflow-wrap:anywhere]"
    >
      <span className="flex items-center gap-1.5 text-[12px] text-ink-soft">
        {cor ? <Amostra cor={cor} /> : null}
        {rotulo}
      </span>
      <p
        data-testid="despesas-kpi-valor"
        data-completo={completo}
        className={`text-[clamp(18px,10cqi,26px)] font-semibold leading-[1.1] tracking-[-0.02em] tabular-nums ${
          semValor ? "text-ink-mute" : "text-ink"
        }`}
      >
        {valor}
        {marca ? (
          <span className="mt-1 block text-[12px] font-normal leading-normal tracking-normal text-ink-soft">
            {marca}
          </span>
        ) : null}
      </p>
      <p data-testid="despesas-kpi-comparacao" className="text-[12px] text-ink-soft">
        {rotuloAnterior}: {textoDoPeriodo(anterior, serie)}
      </p>
      {detalhe ? (
        <p data-testid={`despesas-kpi-${serie}-cobertura`} className="text-[11px] text-ink-mute">
          {detalhe}
        </p>
      ) : null}
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
  atual: Bucket;
  anterior: Bucket;
  rotuloAnterior: string;
}) {
  const nv = atual.naoVinculadas;
  const comum = { atual, anterior, rotuloAnterior };
  return (
    <article
      data-testid={testId}
      aria-label={titulo}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-line px-4 py-5 sm:px-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-mono! text-[11px] font-semibold uppercase tracking-[0.12em]! text-ink-soft!">
          {titulo}
        </h3>
        <span className={MONO}>{faixa}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-5">
        <ColunaKpi
          serie="stripe"
          rotulo="Stripe (cartão)"
          cor={COR_STRIPE.forte}
          detalhe={resumoCobertura(atual.cobertura.stripe, "cartão")}
          {...comum}
        />
        <ColunaKpi
          serie="inter"
          rotulo="Inter (PIX)"
          cor={COR_INTER.forte}
          detalhe={resumoCobertura(atual.cobertura.inter, "PIX")}
          {...comum}
        />
        <ColunaKpi
          serie="manual"
          rotulo="Recorrentes/manuais"
          cor={COR_MANUAL.forte}
          detalhe={resumoManuais(atual.cobertura.manual)}
          {...comum}
        />
        <ColunaKpi serie="total" rotulo="Total" cor={null} {...comum} />
      </div>
      <p
        data-testid={`${testId}-nao-vinculadas`}
        className="border-t border-line pt-3 text-[12px] text-ink-soft"
      >
        Não vinculadas a pagamento: {plural(nv.count, "tarifa", "tarifas")} ·{" "}
        {formatBRL(nv.cents)} (fora do total)
      </p>
    </article>
  );
}

export function DespesasKpis({ kpis }: Pick<DespesasPainelData, "kpis">) {
  return (
    <div className="grid gap-4 2xl:grid-cols-2">
      <CartaoKpi
        testId="despesas-kpi-mes"
        titulo="Mês atual"
        faixa={faixaKpiMes(kpis.mesAtual)}
        atual={kpis.mesAtual}
        anterior={kpis.mesAnterior}
        rotuloAnterior={capitalizar(nomeMes(kpis.mesAnterior.de))}
      />
      <CartaoKpi
        testId="despesas-kpi-semana"
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
      <div className="flex flex-wrap items-center gap-4 text-[12px] text-ink-soft">
        <span className="flex items-center gap-1.5">
          <Amostra cor={COR_STRIPE.forte} tamanho="size-2.5" />
          Stripe (cartão)
        </span>
        <span className="flex items-center gap-1.5">
          <Amostra cor={COR_INTER.forte} tamanho="size-2.5" />
          Inter (PIX)
        </span>
        <span className="flex items-center gap-1.5">
          <Amostra cor={COR_MANUAL.forte} tamanho="size-2.5" />
          Recorrentes/manuais
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-[2px] border border-dashed border-ink-mute"
          />
          incompleto (pendente ou falha)
        </span>
      </div>
      <span className={MONO}>altura da barra = total observado</span>
    </div>
  );
}

function Barra({
  barra,
  claro,
  completo,
  largura,
  raio,
  vazia = false,
}: {
  barra: { total: number; stripe: number; manual: number };
  claro: boolean;
  completo: boolean;
  largura: string;
  raio: string;
  /** Sem barra: período futuro, ou incompleto sem nada observado. */
  vazia?: boolean;
}) {
  if (vazia) {
    return (
      <div
        aria-hidden
        data-testid="despesas-barra"
        className={`h-[2px] w-full ${largura} ${raio} border border-b-0 border-dashed ${EIXO}`}
      />
    );
  }
  const minimo = barra.total > 0 ? "min-h-[2px]" : "";
  // Incompleto: mesma barra, esmaecida e com contorno tracejado.
  const marca = completo ? "" : "opacity-55 outline outline-1 outline-dashed outline-ink-mute";
  return (
    <div
      aria-hidden
      data-testid="despesas-barra"
      className={`flex w-full flex-col overflow-hidden ${largura} ${raio} ${minimo} ${marca}`}
      style={{ height: `${barra.total.toFixed(2)}%` }}
    >
      {barra.manual > 0 ? (
        <div
          data-fatia="manual"
          className={`shrink-0 ${claro ? COR_MANUAL.clara : COR_MANUAL.forte}`}
          style={{ height: `${barra.manual.toFixed(2)}%` }}
        />
      ) : null}
      <div data-fatia="inter" className={`flex-1 ${claro ? COR_INTER.clara : COR_INTER.forte}`} />
      <div
        data-fatia="stripe"
        className={`shrink-0 ${claro ? COR_STRIPE.clara : COR_STRIPE.forte}`}
        style={{ height: `${barra.stripe.toFixed(2)}%` }}
      />
    </div>
  );
}

/** Rótulo de acessibilidade de um bucket, com a pendência por extenso. */
function detalheValores(b: Bucket): string {
  const manuais = b.manualCents > 0 ? ` · manuais ${formatBRL(b.manualCents)}` : "";
  const base = `Stripe ${formatBRL(b.stripeCents)} · Inter ${formatBRL(
    b.interCents,
  )}${manuais} · total ${formatBRL(b.totalCents)}`;
  const pendentes = b.cobertura.stripe.pendentes + b.cobertura.inter.pendentes;
  const falhos = b.cobertura.stripe.falhos + b.cobertura.inter.falhos;
  if (pendentes + falhos === 0) return base;
  const partes = [];
  if (pendentes > 0) partes.push(plural(pendentes, "pendente", "pendentes"));
  if (falhos > 0) partes.push(plural(falhos, "falha", "falhas"));
  return `${base} · incompleto: ${partes.join(", ")}`;
}

/** Rótulo sobre a barra: valor (curto ou cheio) e, se incompleto, o estado. */
function RotuloBarra({
  b,
  curto,
  destaque,
}: {
  b: Bucket;
  curto: boolean;
  destaque: boolean;
}) {
  const estado = completudeDe(b, "total");
  const peso = destaque ? "font-semibold" : "font-normal";
  if (estado !== "completo" && b.totalCents === 0) {
    return (
      <span className={`whitespace-nowrap font-mono text-[10px] text-ink-mute ${peso}`}>
        — {estado}
      </span>
    );
  }
  return (
    <span className="flex flex-col items-center gap-px">
      <span className={`whitespace-nowrap font-mono text-[10px] text-ink ${peso}`}>
        {curto ? formatCompacto(b.totalCents) : formatBRL(b.totalCents)}
      </span>
      {estado !== "completo" ? (
        <span className="whitespace-nowrap font-mono text-[9px] text-ink-mute">{estado}</span>
      ) : null}
    </span>
  );
}

export function DespesasPorMes({ meses }: Pick<DespesasPainelData, "meses">) {
  const maxT = maximo(meses.map((m) => m.totalCents));
  const corrente = meses.at(-1);
  const legenda = `últimos ${meses.length} meses${
    corrente?.parcial ? ` · ${nomeMes(corrente.de)} em andamento` : ""
  }`;
  return (
    <Grafico titulo="Por mês" legenda={legenda} corrente='[data-parcial="true"]'>
      <div className="flex min-w-[860px] flex-col px-2 lg:min-w-0 lg:px-0">
        <ol className="flex h-[210px] items-stretch gap-3">
          {meses.map((m) => {
            const titulo = `${nomeMes(m.de)} ${m.de.slice(0, 4)}${
              m.parcial ? " (parcial)" : ""
            } · ${detalheValores(m)}`;
            const completo = completudeDe(m, "total") === "completo";
            return (
              <li
                key={m.de}
                data-testid="despesas-mes"
                data-mes={m.de}
                data-parcial={m.parcial}
                data-completo={completo}
                title={titulo}
                aria-label={titulo}
                className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
              >
                <RotuloBarra b={m} curto destaque={m.parcial} />
                <Barra
                  barra={barraDespesas(m.stripeCents, m.totalCents, maxT, 80, m.manualCents)}
                  claro={m.parcial}
                  completo={completo}
                  largura="max-w-[60px]"
                  raio="rounded-t-[3px]"
                  vazia={!completo && m.totalCents === 0}
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

export function DespesasSemanasDoMes({
  semanas,
  mes,
}: Pick<DespesasPainelData, "semanas"> & { mes: string }) {
  const visiveis = semanas.filter((s) => s.estado !== "futura");
  const maxT = maximo(visiveis.map((s) => s.totalCents));
  return (
    <Grafico
      titulo={`Semanas de ${nomeMes(mes)}`}
      legenda="Recorrentes rateadas por dia, custo somente até hoje; avulsas e provedores na data real. As semanas do mês corrente podem ser recalculadas quando uma cobrança acontece."
      corrente='[data-estado="atual"]'
    >
      <div className="flex min-w-[520px] flex-col px-2 lg:min-w-0 lg:px-0">
        <ol className="flex h-[180px] items-stretch gap-6">
          {semanas.map((s) => {
            const futura = s.estado === "futura";
            const atual = s.estado === "atual";
            const completo = completudeDe(s, "total") === "completo";
            const rotulo = rotuloSemana(s);
            return (
              <li
                key={s.de}
                data-testid="despesas-semana"
                data-de={s.de}
                data-estado={s.estado}
                data-completo={completo}
                aria-label={
                  futura
                    ? `${rotulo}: ainda não começou`
                    : `${rotulo}${atual ? " (esta semana)" : ""} · ${detalheValores(s)}`
                }
                className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
              >
                {futura ? (
                  <span className="font-mono text-[11px] text-ink-mute">—</span>
                ) : (
                  <RotuloBarra b={s} curto={false} destaque={atual} />
                )}
                <Barra
                  barra={barraDespesas(s.stripeCents, s.totalCents, maxT, 72, s.manualCents)}
                  claro={atual}
                  completo={completo}
                  largura="max-w-[112px]"
                  raio="rounded-t-[4px]"
                  vazia={futura || (!completo && s.totalCents === 0)}
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

function LinhaCobertura({
  provedor,
  rotulo,
  meio,
  cor,
  cobertura,
}: {
  provedor: "stripe" | "inter";
  rotulo: string;
  meio: "cartão" | "PIX";
  cor: string;
  cobertura: CoberturaDespesasData;
}) {
  return (
    <li
      data-testid={`despesas-cobertura-${provedor}`}
      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line py-3 first:border-t-0"
    >
      <span className="flex items-center gap-1.5 text-[13px] text-ink">
        <Amostra cor={cor} />
        {rotulo}
        <span className={MONO}>desde {formatLocalDate(cobertura.desde)}</span>
      </span>
      <span className="text-[13px] text-ink-soft">
        {resumoCobertura(cobertura.desdeInicio, meio)}
      </span>
      <span className={MONO}>{ultimaLeitura(cobertura.ultimaLeituraEm)}</span>
    </li>
  );
}

export function DespesasCobertura({ cobertura }: Pick<DespesasPainelData, "cobertura">) {
  return (
    <section
      data-testid="despesas-cobertura"
      className="flex flex-col gap-2 rounded-lg border border-line px-6 pb-2 pt-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[16px] font-semibold tracking-normal! text-ink">Cobertura</h2>
        <span className={MONO}>pagamentos pela data do pagamento</span>
      </div>
      <ul className="flex flex-col">
        <LinhaCobertura
          provedor="stripe"
          rotulo="Stripe (cartão)"
          meio="cartão"
          cor={COR_STRIPE.forte}
          cobertura={cobertura.stripe}
        />
        <LinhaCobertura
          provedor="inter"
          rotulo="Inter (PIX)"
          meio="PIX"
          cor={COR_INTER.forte}
          cobertura={cobertura.inter}
        />
      </ul>
    </section>
  );
}

/** Só aparece quando a soma dos dias não bate com o total independente. */
export function DespesasAviso({
  diferencaConciliacao: d,
}: Pick<DespesasPainelData, "diferencaConciliacao">) {
  const partes = [
    ["Stripe", d.stripeCents],
    ["Inter", d.interCents],
    ["não vinculadas", d.naoVinculadasCents],
  ] as const;
  const divergentes = partes.filter(([, v]) => v !== 0);
  if (divergentes.length === 0) return null;
  return (
    <aside
      role="status"
      aria-label="Conferir"
      data-testid="despesas-aviso"
      className="flex flex-col gap-1 rounded-lg border border-line px-6 py-3 text-[12px] text-ink-soft"
    >
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-soft">
        Conferir
      </p>
      <p>
        A soma por dia não bate com o total independente. Diferença em{" "}
        {divergentes.map(([nome, v]) => `${nome}: ${formatBRL(v)}`).join("; ")}.
      </p>
      <p className="text-ink-mute">Nenhum valor foi ajustado.</p>
    </aside>
  );
}

export function DespesasNotas() {
  return (
    <div className="flex flex-col gap-1 text-[12px] text-ink-mute">
      <p>
        <span className="text-ink-soft">Despesas:</span> tarifa de processamento observada no
        extrato do provedor, na data em que o provedor debitou. Nada é estimado: período com
        tarifa pendente ou falha mostra só o que foi observado, marcado como incompleto, nunca
        como zero.
      </p>
      <p>
        <span className="text-ink-soft">Cobertura:</span> pagamentos do período, pela data do
        pagamento. Stripe: leitura da tarifa por pagamento. Inter: tarifa vinculada ou, após
        72h do pagamento e scan completo, sem tarifa cobrada (franquia Inter). Uma tarifa
        posterior substitui o zero observado.
      </p>
      <p>
        <span className="text-ink-soft">Recorrentes/manuais:</span> despesas cadastradas abaixo
        (servidores, ferramentas, assinaturas), no dia de cobrança, horário de São Paulo. Valor
        conhecido, sempre confirmado; só conta depois que o dia chega. Entram no total.
      </p>
      <p>
        <span className="text-ink-soft">Não vinculadas:</span> tarifas que o provedor cobrou sem
        um pagamento correspondente identificado. Ficam fora do total até serem vinculadas.
      </p>
    </div>
  );
}

/** Painel puro: tudo o que vem de UMA resposta de `admin.despesas.painel`. */
export function DespesasPainel({ data }: { data: DespesasPainelData }) {
  return (
    <>
      <DespesasAviso diferencaConciliacao={data.diferencaConciliacao} />
      <DespesasKpis kpis={data.kpis} />
      <div className="flex flex-col gap-4">
        <Legenda />
        <DespesasPorMes meses={data.meses} />
      </div>
      <DespesasSemanasDoMes semanas={data.semanas} mes={data.kpis.mesAtual.de} />
      <DespesasCobertura cobertura={data.cobertura} />
      <DespesasNotas />
    </>
  );
}
