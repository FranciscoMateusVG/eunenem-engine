import { useCallback, useState } from "react";
import {
  AdministradoresCell,
  CampanhaLinks,
} from "@/components/eunenem/admin/AdministradoresCell";
import { trpc } from "@/lib/trpc.js";
import { Valor } from "./ReceitaSerieChart";
import {
  formatInstante,
  type ReceitaCampanha,
  type ReceitaDashboard,
  type ReceitaMeioProvedor,
  ROTULOS,
} from "./types";

/**
 * Decomposições da Receita EuNeném (aperture-9bpre): de onde vêm as taxas.
 *
 * Duas partições exclusivas — por campanha e por meio/provedor. A conta
 * administradora é ATRIBUTO da campanha (com link), nunca eixo de soma:
 * campanha com dois coadmins aparece e soma uma vez.
 *
 * A lista por campanha mostra até 100; o que ficou de fora aparece somado em
 * linha própria e o total cobre TODAS. A lista paginada abaixo é uma leitura
 * separada, com instante próprio, e nunca alimenta os totais.
 */

const TH = "px-3 py-2";
const THR = "px-3 py-2 text-right";

function CabecalhoValores() {
  return (
    <>
      <th scope="col" className={THR}>
        {ROTULOS.registradas}
      </th>
      <th scope="col" className={THR}>
        {ROTULOS.cancelamentos}
      </th>
      <th scope="col" className={THR}>
        {ROTULOS.resultado}
      </th>
    </>
  );
}

function LinhaCampanha({ campanha }: { campanha: ReceitaCampanha }) {
  return (
    <tr>
      <th scope="row" className="px-3 py-3 text-left font-normal">
        <div className="min-w-[12rem] font-medium text-ink">{campanha.titulo}</div>
        <CampanhaLinks
          campaignId={campanha.idCampanha}
          campaignSlug={campanha.campaignSlug}
          publicOwnerSlug={campanha.publicOwnerSlug}
        />
      </th>
      <td className="px-3 py-3">
        <AdministradoresCell
          administrators={campanha.administrators}
          campaignId={campanha.idCampanha}
        />
      </td>
      <Valor cents={campanha.taxasRegistradasCents} />
      <Valor cents={campanha.cancelamentosCents} />
      <Valor cents={campanha.resultadoDeTaxasCents} forte />
    </tr>
  );
}

export function ReceitaPorCampanha({
  porCampanha,
  somaPorCampanha,
}: {
  porCampanha: ReceitaDashboard["porCampanha"];
  somaPorCampanha: ReceitaDashboard["conciliacao"]["somaPorCampanha"];
}) {
  const fora = porCampanha.campanhasTotal - porCampanha.rows.length;
  return (
    <section aria-labelledby="receita-campanhas-title" className="space-y-3">
      <div>
        <h2 id="receita-campanhas-title" className="text-lg font-semibold text-ink">
          Por campanha
        </h2>
        <p className="text-[13px] text-ink-soft">
          {porCampanha.campanhasTotal === 1
            ? "1 campanha com taxa no período."
            : `${porCampanha.campanhasTotal} campanhas com taxa no período.`}{" "}
          Administradores são informação da campanha; os valores não são divididos entre eles.
        </p>
      </div>
      {porCampanha.rows.length === 0 ? (
        <p className="rounded-md border border-line bg-paper p-5 text-[14px] text-ink-soft">
          Nenhuma campanha teve taxa registrada ou cancelada neste período.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-paper">
          <table className="min-w-full divide-y divide-line text-left text-[12px]">
            <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.12em] text-ink-mute">
              <tr>
                <th scope="col" className={TH}>
                  Campanha
                </th>
                <th scope="col" className={TH}>
                  Usuário (administradores)
                </th>
                <CabecalhoValores />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {porCampanha.rows.map((campanha) => (
                <LinhaCampanha key={campanha.idCampanha} campanha={campanha} />
              ))}
            </tbody>
            <tfoot className="border-t-2 border-line bg-cream-2/40">
              {porCampanha.truncated ? (
                <tr>
                  <th scope="row" colSpan={2} className="px-3 py-2 text-left font-normal text-ink">
                    Fora desta lista ({fora} {fora === 1 ? "campanha" : "campanhas"})
                  </th>
                  <Valor cents={porCampanha.foraDaLista.taxasRegistradasCents} />
                  <Valor cents={porCampanha.foraDaLista.cancelamentosCents} />
                  <Valor
                    cents={
                      porCampanha.foraDaLista.taxasRegistradasCents -
                      porCampanha.foraDaLista.cancelamentosCents
                    }
                    forte
                  />
                </tr>
              ) : null}
              <tr>
                <th scope="row" colSpan={2} className="px-3 py-2 text-left font-semibold text-ink">
                  Todas as campanhas ({porCampanha.campanhasTotal})
                </th>
                <Valor cents={somaPorCampanha.taxasRegistradasCents} />
                <Valor cents={somaPorCampanha.cancelamentosCents} />
                <Valor
                  cents={
                    somaPorCampanha.taxasRegistradasCents - somaPorCampanha.cancelamentosCents
                  }
                  forte
                />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {porCampanha.truncated ? (
        <p role="status" className="text-[12px] text-amber-900">
          Mostrando as {porCampanha.rows.length} campanhas com mais taxas registradas. As demais
          estão somadas em "Fora desta lista" e o total cobre todas.
        </p>
      ) : null}
    </section>
  );
}

function rotuloMetodo(metodo: ReceitaMeioProvedor["metodo"]): string {
  if (metodo === "pix") return "PIX";
  if (metodo === "credit_card") return "Cartão";
  return "meio não registrado";
}

function rotuloProvedor(provedor: ReceitaMeioProvedor["provedor"]): string {
  if (provedor === "stripe") return "Stripe";
  if (provedor === "inter") return "Inter";
  return "provedor não registrado";
}

export function ReceitaPorMeioProvedor({
  rows,
  soma,
}: {
  rows: ReceitaDashboard["porMeioProvedor"];
  soma: ReceitaDashboard["conciliacao"]["somaPorMeioProvedor"];
}) {
  return (
    <section aria-labelledby="receita-meio-title" className="space-y-3">
      <div>
        <h2 id="receita-meio-title" className="text-lg font-semibold text-ink">
          Por meio de pagamento e provedor
        </h2>
        <p className="text-[13px] text-ink-soft">
          Quando o pagamento não guarda o provedor, a taxa aparece em "provedor não registrado" —
          nunca é descartada.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-line bg-paper p-5 text-[14px] text-ink-soft">
          Nenhuma taxa registrada ou cancelada neste período.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-paper">
          <table className="min-w-full divide-y divide-line text-left text-[12px]">
            <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.12em] text-ink-mute">
              <tr>
                <th scope="col" className={TH}>
                  Meio
                </th>
                <th scope="col" className={TH}>
                  Provedor
                </th>
                <CabecalhoValores />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={`${row.metodo}:${row.provedor}`}>
                  <th scope="row" className="whitespace-nowrap px-3 py-2 font-normal text-ink">
                    {rotuloMetodo(row.metodo)}
                  </th>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-soft">
                    {rotuloProvedor(row.provedor)}
                  </td>
                  <Valor cents={row.taxasRegistradasCents} />
                  <Valor cents={row.cancelamentosCents} />
                  <Valor cents={row.resultadoDeTaxasCents} forte />
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-line bg-cream-2/40">
              <tr>
                <th scope="row" colSpan={2} className="px-3 py-2 text-left font-semibold text-ink">
                  Todos os meios
                </th>
                <Valor cents={soma.taxasRegistradasCents} />
                <Valor cents={soma.cancelamentosCents} />
                <Valor cents={soma.taxasRegistradasCents - soma.cancelamentosCents} forte />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

const DRILLDOWN_PAGE_SIZE = 50;

/**
 * Lista paginada de TODAS as campanhas do período. Leitura separada do
 * painel: cada página tem instante próprio e pode refletir dados mais novos.
 */
export function ReceitaCampanhasDrilldown({ de, ate }: { de: string; ate: string }) {
  const [aberto, setAberto] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [anteriores, setAnteriores] = useState<Array<string | null>>([]);

  const query = trpc.admin.receita.campanhasPaginated.useQuery(
    { de, ate, cursor, limit: DRILLDOWN_PAGE_SIZE },
    { enabled: aberto, staleTime: 30_000 },
  );

  const proxima = useCallback(() => {
    const next = query.data?.nextCursor;
    if (!next) return;
    setAnteriores((pilha) => [...pilha, cursor]);
    setCursor(next);
  }, [cursor, query.data?.nextCursor]);

  const anterior = useCallback(() => {
    setAnteriores((pilha) => {
      if (pilha.length === 0) return pilha;
      setCursor(pilha.at(-1) ?? null);
      return pilha.slice(0, -1);
    });
  }, []);

  return (
    <section aria-labelledby="receita-drilldown-title" className="space-y-3">
      <h2 id="receita-drilldown-title" className="text-lg font-semibold text-ink">
        Todas as campanhas, em páginas
      </h2>
      <button
        type="button"
        aria-expanded={aberto}
        aria-controls="receita-drilldown-conteudo"
        onClick={() => setAberto((valor) => !valor)}
        className="min-h-11 rounded border border-line bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft transition-colors hover:border-plum hover:text-plum focus:outline-none focus-visible:ring-2 focus-visible:ring-plum"
      >
        {aberto ? "Fechar lista paginada" : "Abrir lista paginada"}
      </button>
      {aberto ? (
        <div id="receita-drilldown-conteudo" className="space-y-3">
          <p className="rounded-md border border-line bg-cream-2/40 p-3 text-[12px] text-ink-soft">
            Esta lista é lida separadamente do painel acima e pode refletir um instante posterior.
            Os totais do período vêm sempre do painel, nunca da soma destas páginas.
            {query.data ? ` Página lida em ${formatInstante(query.data.snapshotAt)}.` : ""}
          </p>
          {query.error ? (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-4 text-[13px] text-red-800"
            >
              Não foi possível carregar a lista paginada. {query.error.message}
            </div>
          ) : null}
          {query.isLoading ? (
            <p className="font-mono text-[12px] text-ink-mute">carregando…</p>
          ) : null}
          {query.data && query.data.rows.length === 0 ? (
            <p className="rounded-md border border-line bg-paper p-5 text-[14px] text-ink-soft">
              Nenhuma campanha teve taxa registrada ou cancelada neste período.
            </p>
          ) : null}
          {query.data && query.data.rows.length > 0 ? (
            <div className="overflow-x-auto rounded-md border border-line bg-paper">
              <table className="min-w-full divide-y divide-line text-left text-[12px]">
                <thead className="bg-cream-2/60 font-mono uppercase tracking-[0.12em] text-ink-mute">
                  <tr>
                    <th scope="col" className={TH}>
                      Campanha
                    </th>
                    <th scope="col" className={TH}>
                      Usuário (administradores)
                    </th>
                    <CabecalhoValores />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {query.data.rows.map((campanha) => (
                    <LinhaCampanha key={campanha.idCampanha} campanha={campanha} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-ink-mute">
              {query.data
                ? `página ${anteriores.length + 1} · ${query.data.campanhasTotal} campanha(s)`
                : "carregando…"}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={anteriores.length === 0 || query.isFetching}
                onClick={anterior}
                className="min-h-11 rounded border border-line px-3 py-2 font-mono text-[11px] uppercase focus:outline-none focus-visible:ring-2 focus-visible:ring-plum disabled:opacity-40"
              >
                Anterior
              </button>
              <button
                type="button"
                disabled={!query.data?.nextCursor || query.isFetching}
                onClick={proxima}
                className="min-h-11 rounded border border-line px-3 py-2 font-mono text-[11px] uppercase focus:outline-none focus-visible:ring-2 focus-visible:ring-plum disabled:opacity-40"
              >
                Próxima
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
