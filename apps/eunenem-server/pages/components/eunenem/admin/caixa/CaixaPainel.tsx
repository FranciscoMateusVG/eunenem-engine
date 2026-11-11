import { useState } from "react";
import { formatBRL } from "@/lib/formatBRL";
import { formatLocalDate } from "@/lib/receitaPeriodo";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../../server/trpc/router.js";

/**
 * Painel do Fluxo de caixa (aperture-zoxel). Só apresenta o read model
 * `admin.caixa.painel`; nenhuma conta nova é feita aqui.
 */

export type CaixaPainelData = inferRouterOutputs<AppRouter>["admin"]["caixa"]["painel"];

const METODOS_ENTRADA = [
  ["pix", "PIX"],
  ["credit_card", "Cartão"],
  ["nao_registrado", "Método não registrado"],
] as const;

function Cartao({
  titulo,
  valor,
  nota,
  tom = "normal",
}: {
  titulo: string;
  valor: string;
  nota?: string;
  tom?: "normal" | "forte";
}) {
  return (
    <div className="rounded-md border border-line bg-white p-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-mute">{titulo}</p>
      <p
        className={`mt-1 font-mono tabular-nums ${tom === "forte" ? "text-2xl font-semibold text-ink" : "text-xl text-ink"}`}
      >
        {valor}
      </p>
      {nota ? <p className="mt-1 text-[12px] text-ink-soft">{nota}</p> : null}
    </div>
  );
}

const TH = "px-3 py-2 text-right font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute";
const TD = "whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-ink-soft";

export function CaixaPainel({
  data,
  aoBaixarCsv,
}: {
  data: CaixaPainelData;
  /** Gera e baixa o CSV do período; rejeita com a causa se falhar. */
  aoBaixarCsv: (periodo: CaixaPainelData["periodo"]) => Promise<void>;
}) {
  const { entradas, saidas, pendentes, conciliacao } = data;
  const dif = conciliacao.diferencas;
  const temDiferenca = Object.values(dif).some((v) => v !== 0);
  // `ate` é exclusivo; o texto mostra o último dia incluído.
  const periodoTexto = `${formatLocalDate(data.periodo.de)} a ${formatLocalDate(fimInclusivo(data.periodo.ate))}`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-[12px] text-ink-mute">
          Período: {periodoTexto} · horário de São Paulo
        </p>
        <BotaoCsv periodo={data.periodo} aoBaixar={aoBaixarCsv} />
      </div>

      <section aria-labelledby="caixa-resumo" className="space-y-3">
        <h2 id="caixa-resumo" className="text-[16px] font-semibold text-ink">
          Resumo do período
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Cartao
            titulo="Entrou"
            valor={formatBRL(entradas.liquidoCents)}
            nota={`${formatBRL(entradas.brutoCents)} em ${entradas.pagamentos} pagamento(s) aprovado(s), menos ${formatBRL(entradas.estornosCents)} de estornos`}
          />
          <Cartao
            titulo="Saiu"
            valor={formatBRL(saidas.totalCents)}
            nota={`${saidas.repasses} repasse(s) já transferido(s)`}
          />
          <Cartao
            titulo="Saldo do período"
            valor={formatBRL(data.saldoCents)}
            nota="Entrou − saiu. Repasses ainda não transferidos não entram."
            tom="forte"
          />
          <Cartao
            titulo="Ainda a transferir"
            valor={formatBRL(
              pendentes.aprovadosNaoTransferidos.cents +
                pendentes.emVerificacao.cents +
                pendentes.semComprovante.cents,
            )}
            nota="Foto de agora, não depende do período. Não conta como saída."
          />
        </div>
      </section>

      <section aria-labelledby="caixa-entradas" className="space-y-3">
        <h2 id="caixa-entradas" className="text-[16px] font-semibold text-ink">
          Entradas por forma de pagamento
        </h2>
        <div className="overflow-x-auto rounded-md border border-line bg-white">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="px-3 py-2 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute">
                  Forma
                </th>
                <th scope="col" className={TH}>Presente</th>
                <th scope="col" className={TH}>Taxa EuNeném</th>
                <th scope="col" className={TH}>Adicional do cartão</th>
                <th scope="col" className={TH}>Total aprovado</th>
                <th scope="col" className={TH}>Estornos</th>
                <th scope="col" className={TH}>Líquido</th>
              </tr>
            </thead>
            <tbody>
              {METODOS_ENTRADA.map(([chave, rotulo]) => {
                const m = entradas.porMetodo[chave];
                if (chave === "nao_registrado" && m.brutoCents === 0 && m.estornosCents === 0) {
                  return null;
                }
                return (
                  <tr key={chave} className="border-b border-line last:border-0">
                    <th scope="row" className="px-3 py-2 text-left font-normal text-ink">{rotulo}</th>
                    <td className={TD}>{formatBRL(m.presenteCents)}</td>
                    <td className={TD}>{formatBRL(m.taxaCents)}</td>
                    <td className={TD}>{formatBRL(m.adicionalCartaoCents)}</td>
                    <td className={TD}>{formatBRL(m.brutoCents)}</td>
                    <td className={TD}>{formatBRL(m.estornosCents)}</td>
                    <td className={`${TD} font-semibold text-ink`}>{formatBRL(m.liquidoCents)}</td>
                  </tr>
                );
              })}
              <tr className="bg-surface-soft">
                <th scope="row" className="px-3 py-2 text-left font-semibold text-ink">Total</th>
                <td className={TD}>{formatBRL(entradas.presenteCents)}</td>
                <td className={TD}>{formatBRL(entradas.taxaCents)}</td>
                <td className={TD}>{formatBRL(entradas.adicionalCartaoCents)}</td>
                <td className={TD}>{formatBRL(entradas.brutoCents)}</td>
                <td className={TD}>{formatBRL(entradas.estornosCents)}</td>
                <td className={`${TD} font-semibold text-ink`}>{formatBRL(entradas.liquidoCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-ink-mute">
          O adicional do cartão é o custo repassado ao pagador: entra no caixa, mas não é receita da
          EuNeném. Estorno aparece no dia em que foi cancelado.
        </p>
      </section>

      <section aria-labelledby="caixa-saidas" className="space-y-3">
        <h2 id="caixa-saidas" className="text-[16px] font-semibold text-ink">
          Saídas: repasses já transferidos
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Cartao
            titulo="Pelo Inter (automático)"
            valor={formatBRL(saidas.porMetodo.inter.cents)}
            nota={`${saidas.porMetodo.inter.repasses} repasse(s)`}
          />
          <Cartao
            titulo="Manual (com referência bancária)"
            valor={formatBRL(saidas.porMetodo.manual.cents)}
            nota={`${saidas.porMetodo.manual.repasses} repasse(s)`}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3" data-testid="caixa-pendentes">
          <Cartao
            titulo="Aprovados, ainda não transferidos"
            valor={formatBRL(pendentes.aprovadosNaoTransferidos.cents)}
            nota={`${pendentes.aprovadosNaoTransferidos.repasses} repasse(s) aprovado(s) cujo dinheiro ainda não saiu (em envio, enviado ao banco ou com falha)`}
          />
          <Cartao
            titulo="Em verificação"
            valor={formatBRL(pendentes.emVerificacao.cents)}
            nota={`${pendentes.emVerificacao.repasses} repasse(s) à espera de conferência manual`}
          />
          <Cartao
            titulo="Marcado como transferido sem comprovante — conferir"
            valor={formatBRL(pendentes.semComprovante.cents)}
            nota={`${pendentes.semComprovante.repasses} repasse(s) aprovado(s) e marcado(s) como transferido(s), mas sem envio pelo banco nem referência bancária. Não contam como saída.`}
          />
        </div>
      </section>

      <section aria-labelledby="caixa-serie" className="space-y-3">
        <h2 id="caixa-serie" className="text-[16px] font-semibold text-ink">
          Dia a dia, semana a semana
        </h2>
        <div className="overflow-x-auto rounded-md border border-line bg-white">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="px-3 py-2 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute">
                  Período
                </th>
                <th scope="col" className={TH}>Entrou</th>
                <th scope="col" className={TH}>Estornos</th>
                <th scope="col" className={TH}>Saiu</th>
                <th scope="col" className={TH}>Saldo</th>
              </tr>
            </thead>
            <tbody>
              {data.serie.map((b) => (
                <tr key={b.inicio} className="border-b border-line last:border-0">
                  <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal text-ink">
                    {formatLocalDate(b.inicio)}
                    {data.periodo.granularidade === "dia" ? "" : ` a ${formatLocalDate(fimInclusivo(b.fim))}`}
                    {b.parcial ? " (parcial)" : ""}
                  </th>
                  <td className={TD}>{formatBRL(b.entradasBrutasCents)}</td>
                  <td className={TD}>{formatBRL(b.estornosCents)}</td>
                  <td className={TD}>{formatBRL(b.saidasCents)}</td>
                  <td className={`${TD} font-semibold text-ink`}>{formatBRL(b.saldoCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="caixa-conciliacao" className="space-y-2">
        <h2 id="caixa-conciliacao" className="text-[16px] font-semibold text-ink">
          Conferência com o livro financeiro
        </h2>
        {temDiferenca ? (
          <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-[13px] text-amber-900">
            Os números abaixo não fecham ao centavo. Não ajustamos nada: confira com o time
            técnico antes de usar este período. Diferenças (em centavos): entradas{" "}
            {dif.entradasBrutasCents}, estornos {dif.estornosCents}, saídas {dif.saidasCents},
            total pago {dif.totalPagoCents}, repasses {dif.repassesCents}.
          </div>
        ) : (
          <p className="text-[13px] text-ink-soft" data-testid="caixa-conciliado">
            Fecha ao centavo: o total das entradas é igual ao valor pago nos{" "}
            {entradas.pagamentos} pagamento(s) ({formatBRL(conciliacao.totalPagoDosPagamentosCents)}
            ), as saídas são iguais aos repasses ({formatBRL(conciliacao.totalDosRepassesCents)}) e
            a soma da tabela é igual ao total.
          </p>
        )}
      </section>
    </div>
  );
}

function fimInclusivo(fimExclusivo: string): string {
  return new Date(new Date(`${fimExclusivo}T12:00:00Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function BotaoCsv({
  periodo,
  aoBaixar,
}: {
  periodo: CaixaPainelData["periodo"];
  aoBaixar: (periodo: CaixaPainelData["periodo"]) => Promise<void>;
}) {
  const [baixando, setBaixando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const baixar = async () => {
    setBaixando(true);
    setErro(null);
    try {
      await aoBaixar(periodo);
    } catch (e: unknown) {
      setErro("Não foi possível gerar o CSV. Tente de novo.");
    } finally {
      setBaixando(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {erro ? (
        <span role="alert" className="text-[12px] text-red-800">
          {erro}
        </span>
      ) : null}
      <button
        type="button"
        onClick={baixar}
        disabled={baixando}
        className="min-h-11 rounded-md border border-line px-4 font-mono text-[12px] uppercase tracking-[0.12em] text-ink hover:text-plum disabled:opacity-60"
      >
        {baixando ? "gerando…" : "Baixar CSV"}
      </button>
    </div>
  );
}
