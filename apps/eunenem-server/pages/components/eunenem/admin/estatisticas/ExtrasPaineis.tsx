import { CoberturaNota } from "./CoberturaNota";
import { GraficoBarras, type SerieGrafico } from "./GraficoBarras";
import { dinheiro, dinheiroCurto, numero, pct, textoPct } from "./formato";
import type { FunilData, SaudeData, VendasData } from "./types";

/**
 * Painéis extras de Funil, Vendas e Saúde (aperture-lcug3, métricas 8/9/12).
 * Cada um traz a nota de cobertura do servidor; códigos crus desconhecidos
 * aparecem como vieram.
 */

const TH = "py-2 pl-3 text-right font-normal";
const THEAD = "border-b border-line text-left font-mono text-[11px] uppercase text-ink-mute";
const SECAO = "flex min-w-0 flex-col gap-4 rounded-lg border border-line px-4 pb-4 pt-5 sm:px-6";

function Cabecalho({ titulo, explicacao }: { titulo: string; explicacao: string }) {
  return (
    <div>
      <h2 className="text-[16px] font-semibold tracking-normal! text-ink">{titulo}</h2>
      <p className="mt-1 text-sm text-ink-soft">{explicacao}</p>
    </div>
  );
}

function Kpi({ rotulo, valor, detalhe }: { rotulo: string; valor: string; detalhe: string }) {
  return (
    <div data-testid="extra-kpi" className="rounded-xl border border-line p-4">
      <div className="text-sm text-ink-soft">{rotulo}</div>
      <div className="text-2xl font-semibold tabular-nums">{valor}</div>
      <div className="font-mono text-[11px] text-ink-mute">{detalhe}</div>
    </div>
  );
}

const ESTADO_CHECKOUT: Record<string, string> = {
  reserved: "Reservada (não enviada ao provedor)",
  in_flight: "Em andamento",
  provider_succeeded: "Provedor confirmou",
  local_committed: "Concluída",
  outcome_unknown: "Resultado incerto",
  failed: "Falhou",
};

/** Métrica 8 — perda e recuperação no checkout (no Funil). */
export function CheckoutPainel({ data }: { data: FunilData["checkout"] }) {
  return (
    <section aria-label="Checkout: perda e recuperação" className={SECAO}>
      <Cabecalho
        titulo="Checkout: perda e recuperação"
        explicacao="Operações de pagamento abertas no período e em que estado estão hoje. Recuperada = o provedor confirmou depois de uma falha na mesma operação; não é o mesmo que compra aprovada."
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi rotulo="Operações" valor={numero(data.operacoes)} detalhe="tentativas, não pessoas" />
        <Kpi rotulo="Com erro" valor={numero(data.comErro)} detalhe={`${textoPct(pct(data.comErro, data.operacoes))} das operações`} />
        <Kpi rotulo="Recuperadas após erro" valor={textoPct(data.percentualRecuperadas)} detalhe={`${numero(data.recuperadasAposErro)} de ${numero(data.comErro)}`} />
        <Kpi rotulo="Troca PIX → cartão" valor={data.trocasPixCartao === null ? "não medido" : numero(data.trocasPixCartao)} detalhe="sem vínculo entre operações" />
      </div>
      {data.estados.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[360px] text-sm">
            <thead>
              <tr className={THEAD}>
                <th className="py-2 pr-3 font-normal">Estado atual</th>
                <th className={TH}>Operações</th>
                <th className={TH}>%</th>
              </tr>
            </thead>
            <tbody>
              {data.estados.map((e) => (
                <tr key={e.estado} data-testid="checkout-estado" className="border-b border-line/60">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    {ESTADO_CHECKOUT[e.estado] ?? e.estado}
                  </th>
                  <td className="py-2 pl-3 text-right tabular-nums">{numero(e.quantidade)}</td>
                  <td className="py-2 pl-3 text-right tabular-nums">{textoPct(pct(e.quantidade, data.operacoes))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-ink-soft">Nenhuma operação de checkout no período.</p>
      )}
      <CoberturaNota cobertura={data.cobertura} />
    </section>
  );
}

const SERIES_FAIXA: readonly SerieGrafico[] = [
  { chave: "disponiveis", nome: "Disponíveis hoje", cor: "bg-ink-mute", corParcial: "bg-line" },
  { chave: "comprados", nome: "Comprados no período", cor: "bg-plum", corParcial: "bg-plum/40" },
];

export function rotuloFaixa(f: { deCents: number; ateCents: number | null }): string {
  return f.ateCents === null ? `${dinheiroCurto(f.deCents)}+` : `${dinheiroCurto(f.deCents)}–${dinheiroCurto(f.ateCents)}`;
}

/** Rótulo curto do eixo, em reais e sem "R$" (cabe no celular). */
export function rotuloFaixaCurto(f: { deCents: number; ateCents: number | null }): string {
  const r = (c: number) => numero(c / 100);
  if (f.ateCents === null) return `${r(f.deCents)}+`;
  return f.deCents === 0 ? `até ${r(f.ateCents)}` : `${r(f.deCents)}–${r(f.ateCents)}`;
}

/** Métrica 9 — mix por faixa de preço (em Vendas). */
export function FaixasPrecoPainel({ data }: { data: VendasData["faixasPreco"] }) {
  const totalComprados = data.faixas.reduce((n, f) => n + f.comprados, 0);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GraficoBarras
        agrupado
        titulo="Presentes por faixa de preço"
        explicacao="Cotas ainda disponíveis no catálogo atual × presentes comprados no período, por faixa de preço (em reais)."
        series={SERIES_FAIXA}
        barras={data.faixas.map((f) => ({
          chave: String(f.deCents),
          rotulo: rotuloFaixaCurto(f),
          titulo: `${rotuloFaixa(f)}: ${numero(f.disponiveis)} disponíveis · ${numero(f.comprados)} comprados · ${dinheiro(f.gmvCents)}`,
          parcial: false,
          valores: { disponiveis: f.disponiveis, comprados: f.comprados },
        }))}
        formatar={numero}
        testId="vendas-faixa"
      />
      <div className="overflow-x-auto">
        <table aria-label="Faixas de preço" className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className={THEAD}>
              <th className="py-2 pr-3 font-normal">Faixa</th>
              <th className={TH}>Disponíveis</th>
              <th className={TH}>Comprados</th>
              <th className={TH}>% dos comprados</th>
              <th className={TH}>Volume</th>
            </tr>
          </thead>
          <tbody>
            {data.faixas.map((f) => (
              <tr key={f.deCents} className="border-b border-line/60">
                <th scope="row" className="py-2 pr-3 text-left font-medium">
                  {rotuloFaixa(f)}
                </th>
                <td className="py-2 pl-3 text-right tabular-nums">{numero(f.disponiveis)}</td>
                <td className="py-2 pl-3 text-right tabular-nums">{numero(f.comprados)}</td>
                <td className="py-2 pl-3 text-right tabular-nums">{textoPct(pct(f.comprados, totalComprados))}</td>
                <td className="py-2 pl-3 text-right tabular-nums">{dinheiro(f.gmvCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CoberturaNota cobertura={data.cobertura} unidade="itens" />
    </div>
  );
}

const TIPO_EMAIL: Record<string, string> = {
  welcome: "Boas-vindas",
  list_ready: "Lista pronta",
  event_reminder: "Lembrete do evento",
  payment_received: "Presente recebido",
  new_message: "Nova mensagem",
  presence_confirmed: "Presença confirmada",
};
const COLUNAS_EMAIL = [
  ["pendentes", "Pendentes"],
  ["enviando", "Enviando"],
  ["enviados", "Enviados"],
  ["falhos", "Falhos"],
  ["desconhecidos", "Incertos"],
  ["suprimidos", "Suprimidos"],
] as const;

/** Métrica 12 — cobertura de e-mails (em Saúde). */
export function EmailCoberturaPainel({ data }: { data: SaudeData["emailCobertura"] }) {
  return (
    <section aria-label="Cobertura de e-mails" className={SECAO}>
      <Cabecalho
        titulo="Cobertura de e-mails"
        explicacao="Para cada tipo de e-mail automático: eventos do período, quantos tinham destinatário e o estado atual dos envios. Enviado não quer dizer entregue."
      />
      {data.tipos.length === 0 ? (
        <p className="text-sm text-ink-soft">Nenhum evento de e-mail no período.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className={THEAD}>
                <th className="py-2 pr-3 font-normal">Tipo</th>
                <th className={TH}>Eventos</th>
                <th className={TH}>Com destinatário</th>
                {COLUNAS_EMAIL.map(([k, l]) => (
                  <th key={k} className={TH}>
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.tipos.map((t) => (
                <tr key={t.tipo} data-testid="email-tipo" className="border-b border-line/60">
                  <th scope="row" className="py-2 pr-3 text-left font-mono text-[12px] font-medium">
                    {TIPO_EMAIL[t.tipo] ?? t.tipo}
                  </th>
                  <td className="py-2 pl-3 text-right tabular-nums">{numero(t.eventosRegistrados)}</td>
                  <td className="py-2 pl-3 text-right tabular-nums">
                    {numero(t.eventosComDestinatario)}
                    <span className="ml-1 font-mono text-[11px] text-ink-mute">
                      {textoPct(pct(t.eventosComDestinatario, t.eventosRegistrados))}
                    </span>
                  </td>
                  {COLUNAS_EMAIL.map(([k]) => (
                    <td key={k} className={`py-2 pl-3 text-right tabular-nums ${(k === "falhos" || k === "desconhecidos") && t[k] > 0 ? "font-semibold text-red-700" : ""}`}>
                      {numero(t[k])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CoberturaNota cobertura={data.cobertura} unidade="eventos" />
    </section>
  );
}
