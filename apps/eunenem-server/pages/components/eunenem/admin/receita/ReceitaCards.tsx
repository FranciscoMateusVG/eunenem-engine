import { formatBRL } from "@/lib/formatBRL";
import { formatLocalDate, ultimoDiaIncluido } from "@/lib/receitaPeriodo";
import { type ReceitaCard, ROTULOS } from "./types";

/**
 * Cards da aba Receita EuNeném (aperture-9bpre): semana atual, mês atual e
 * período escolhido. O número principal é o resultado de taxas do intervalo
 * (registradas − cancelamentos) e pode ser negativo — um mês só com
 * cancelamentos é um fato, não um erro.
 *
 * O adicional de cartão aparece em linha própria e nunca entra no resultado.
 */

export function ReceitaCards({
  cards,
}: {
  cards: { semanaAtual: ReceitaCard; mesAtual: ReceitaCard; periodo: ReceitaCard };
}) {
  return (
    <section aria-labelledby="receita-cards-title" className="space-y-3">
      <h2
        id="receita-cards-title"
        className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft"
      >
        {ROTULOS.resultado} por intervalo
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card titulo="Semana atual" card={cards.semanaAtual} />
        <Card titulo="Mês atual" card={cards.mesAtual} />
        <Card titulo="Período escolhido" card={cards.periodo} destaque />
      </div>
    </section>
  );
}

function Card({
  titulo,
  card,
  destaque = false,
}: {
  titulo: string;
  card: ReceitaCard;
  destaque?: boolean;
}) {
  const semEventos = card.lancamentosRegistrados === 0 && card.lancamentosCancelados === 0;
  const negativo = card.resultadoDeTaxasCents < 0;
  return (
    <article
      className={`min-w-0 rounded-md border bg-paper p-4 ${destaque ? "border-plum/40" : "border-line"}`}
    >
      <h3 className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft">{titulo}</h3>
      <p className="mt-0.5 font-mono text-[10px] text-ink-mute">
        {formatLocalDate(card.de)} a {formatLocalDate(ultimoDiaIncluido(card.ate))}
      </p>

      <p className="mt-3 text-[11px] text-ink-soft">{ROTULOS.resultado}</p>
      <p className="break-words text-[24px] font-semibold leading-tight text-ink">
        {formatBRL(card.resultadoDeTaxasCents)}
      </p>
      {negativo ? (
        <p className="mt-1 text-[11px] text-amber-900">
          Negativo: os cancelamentos do intervalo superam as taxas registradas nele.
        </p>
      ) : null}
      {semEventos ? (
        <p className="mt-1 text-[11px] italic text-ink-mute">
          Nenhuma taxa registrada ou cancelada neste intervalo.
        </p>
      ) : null}

      <dl className="mt-3 space-y-1 border-t border-line pt-3 text-[12px]">
        <Linha
          rotulo={ROTULOS.registradas}
          valor={formatBRL(card.taxasRegistradasCents)}
          detalhe={`${card.lancamentosRegistrados} lançamento(s) · ${card.pagamentosComTaxa} pagamento(s)`}
        />
        <Linha
          rotulo={ROTULOS.cancelamentos}
          valor={formatBRL(card.cancelamentosCents)}
          detalhe={`${card.lancamentosCancelados} lançamento(s)`}
        />
      </dl>

      <dl className="mt-3 rounded border border-line bg-cream-2/40 px-3 py-2 text-[11px]">
        <dt className="text-ink-soft">{ROTULOS.adicional}</dt>
        <dd className="mt-0.5 font-mono tabular-nums text-ink-soft">
          registrado {formatBRL(card.adicionalCartao.registradoCents)} · cancelado{" "}
          {formatBRL(card.adicionalCartao.canceladoCents)}
        </dd>
      </dl>
    </article>
  );
}

function Linha({
  rotulo,
  valor,
  detalhe,
}: {
  rotulo: string;
  valor: string;
  detalhe: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-ink-soft">{rotulo}</dt>
      <dd className="font-mono tabular-nums text-ink">{valor}</dd>
      <dd className="w-full text-[10px] text-ink-mute">{detalhe}</dd>
    </div>
  );
}
