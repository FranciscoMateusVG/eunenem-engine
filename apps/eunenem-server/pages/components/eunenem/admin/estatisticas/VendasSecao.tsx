import { FaixasPrecoPainel } from "./ExtrasPaineis";
import { GraficoBarras, type SerieGrafico } from "./GraficoBarras";
import {
  dinheiro,
  dinheiroCurto,
  numero,
  pct,
  rotuloBucket,
  textoPct,
  tituloBucket,
} from "./formato";
import type { VendasData } from "./types";

/**
 * Seção Vendas (aperture-lcug3), sobre `admin.analytics.vendas`.
 *
 * Volume bruto de presentes pela data de aprovação (estornos posteriores
 * continuam contando). As taxas de PIX usam outra régua: a turma de PIX
 * GERADOS no período e o que aconteceu com ela até agora.
 */

const SERIES_MEIO: readonly SerieGrafico[] = [
  { chave: "pix", nome: "PIX", cor: "bg-blue-deep", corParcial: "bg-blue-soft" },
  { chave: "cartao", nome: "Cartão", cor: "bg-lilac-deep", corParcial: "bg-lilac-soft" },
];
const SERIE_PRESENTES: readonly SerieGrafico[] = [
  { chave: "presentes", nome: "Presentes", cor: "bg-plum", corParcial: "bg-plum/40" },
];
const SERIES_PIX: readonly SerieGrafico[] = [
  { chave: "gerados", nome: "Gerados", cor: "bg-ink-mute", corParcial: "bg-line" },
  { chave: "pagos", nome: "Pagos", cor: "bg-green-deep", corParcial: "bg-green" },
  { chave: "expirados", nome: "Expirados", cor: "bg-coral-pink", corParcial: "bg-pink-soft" },
];

function Kpi({ rotulo, valor, detalhe }: { rotulo: string; valor: string; detalhe: string }) {
  return (
    <div data-testid="vendas-kpi" className="rounded-xl border border-line p-4">
      <div className="text-sm text-ink-soft">{rotulo}</div>
      <div className="text-2xl font-semibold tabular-nums">{valor}</div>
      <div className="font-mono text-[11px] text-ink-mute">{detalhe}</div>
    </div>
  );
}

export function VendasSecao({ data }: { data: VendasData }) {
  const t = data.totais;
  const meioCents = t.pixCents + t.cartaoCents;
  const barras = <K extends string>(
    mensal: boolean,
    valores: (b: VendasData["meses"][number]) => Record<K, number>,
    texto: (b: VendasData["meses"][number]) => string,
  ) =>
    (mensal ? data.meses : data.semanas).map((b) => ({
      chave: b.de,
      rotulo: rotuloBucket(b, mensal),
      titulo: `${tituloBucket(b, mensal)}: ${texto(b)}`,
      parcial: b.parcial,
      valores: valores(b),
    }));
  const valorPorMeio = (mensal: boolean) =>
    barras(
      mensal,
      (b) => ({ pix: b.pixCents, cartao: b.cartaoCents }),
      (b) => `PIX ${dinheiro(b.pixCents)} · cartão ${dinheiro(b.cartaoCents)} · ${numero(b.presentes)} presentes`,
    );
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi rotulo="Volume em presentes" valor={dinheiro(t.gmvCents)} detalhe="bruto, sem taxas" />
        <Kpi rotulo="Presentes" valor={numero(t.presentes)} detalhe="unidades pagas" />
        <Kpi
          rotulo="Ticket médio"
          valor={t.ticketMedioCents === null ? "—" : dinheiro(t.ticketMedioCents)}
          detalhe="volume ÷ presentes"
        />
        <Kpi
          rotulo="PIX × cartão, em valor"
          valor={`${textoPct(pct(t.pixCents, meioCents))} em PIX`}
          detalhe={`${dinheiroCurto(t.pixCents)} PIX · ${dinheiroCurto(t.cartaoCents)} cartão`}
        />
      </div>
      <p className="text-sm text-ink-soft">
        Presentes pela data em que o pagamento foi aprovado. Estornos posteriores continuam no
        volume bruto. Um pagamento pode levar vários presentes: foram{" "}
        {numero(t.pixQtd + t.cartaoQtd)} pagamentos aprovados ({numero(t.pixQtd)} PIX, {numero(t.cartaoQtd)}{" "}
        cartão).
      </p>
      <GraficoBarras
        titulo="Volume por mês, PIX e cartão"
        explicacao="Valor dos presentes aprovados em cada mês, sem taxas da plataforma nem adicional do cartão."
        series={SERIES_MEIO}
        barras={valorPorMeio(true)}
        formatar={dinheiroCurto}
        testId="vendas-mes"
      />
      <GraficoBarras
        titulo="Volume por semana, PIX e cartão"
        explicacao="Semanas de segunda a domingo; as das pontas podem estar cortadas pelo período."
        series={SERIES_MEIO}
        barras={valorPorMeio(false)}
        formatar={dinheiroCurto}
        testId="vendas-semana"
      />
      <GraficoBarras
        titulo="Presentes por mês"
        explicacao="Unidades de presente pagas. Ticket médio no detalhe de cada barra."
        series={SERIE_PRESENTES}
        barras={barras(
          true,
          (b) => ({ presentes: b.presentes }),
          (b) =>
            `${numero(b.presentes)} presentes · ticket médio ${
              b.ticketMedioCents === null ? "—" : dinheiro(b.ticketMedioCents)
            }`,
        )}
        formatar={numero}
      />
      <section aria-label="PIX gerados, pagos e expirados" className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          <Kpi rotulo="PIX gerados" valor={numero(t.pixGerados)} detalhe="QR codes emitidos" />
          <Kpi
            rotulo="Pagos"
            valor={textoPct(pct(t.pixPagos, t.pixGerados))}
            detalhe={`${numero(t.pixPagos)} dos gerados`}
          />
          <Kpi
            rotulo="Expirados"
            valor={textoPct(pct(t.pixExpirados, t.pixGerados))}
            detalhe={`${numero(t.pixExpirados)} dos gerados`}
          />
        </div>
        <GraficoBarras
          agrupado
          titulo="PIX por mês de geração"
          explicacao="PIX gerados no mês e o que aconteceu com eles até agora. Os ainda dentro do prazo não são pagos nem expirados, então as taxas não somam 100%."
          series={SERIES_PIX}
          barras={barras(
            true,
            (b) => ({ gerados: b.pixGerados, pagos: b.pixPagos, expirados: b.pixExpirados }),
            (b) =>
              `${numero(b.pixGerados)} gerados · ${numero(b.pixPagos)} pagos (${textoPct(
                pct(b.pixPagos, b.pixGerados),
              )}) · ${numero(b.pixExpirados)} expirados (${textoPct(pct(b.pixExpirados, b.pixGerados))})`,
          )}
          formatar={numero}
          testId="vendas-pix-mes"
        />
      </section>
      <FaixasPrecoPainel data={data.faixasPreco} />
    </div>
  );
}
