import { keepPreviousData } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { PagamentosTabs } from "@/components/eunenem/admin/PagamentosTabs";
import {
  ConciliacaoAviso,
  InconsistenciasAviso,
  LimitesDaFonte,
} from "@/components/eunenem/admin/receita/ReceitaAvisos";
import { ReceitaCards } from "@/components/eunenem/admin/receita/ReceitaCards";
import {
  ReceitaSerieChart,
  ReceitaSerieTabela,
} from "@/components/eunenem/admin/receita/ReceitaSerieChart";
import {
  ReceitaCampanhasDrilldown,
  ReceitaPorCampanha,
  ReceitaPorMeioProvedor,
} from "@/components/eunenem/admin/receita/ReceitaTabelas";
import { type ReceitaDashboard, ROTULOS } from "@/components/eunenem/admin/receita/types";
import {
  addDays,
  bucketsDoPeriodo,
  type Granularidade,
  mesAtual,
  type PeriodoInvalido,
  type PeriodoReceita,
  periodoFromSearch,
  periodoPadrao,
  periodoToSearch,
  semanaAtual,
  ultimoDiaIncluido,
} from "@/lib/receitaPeriodo";
import { trpc } from "@/lib/trpc.js";

/**
 * /admin/pagamentos/receita — aba Receita EuNeném (aperture-9bpre; plano
 * aperture-owmqs A2.1).
 *
 * Responde "quanto a EuNeném ganha em taxas, e de onde": taxas da plataforma
 * registradas no ledger, por data do evento. Não é a arrecadação das
 * campanhas nem o que sobra depois de custos — a tela diz isso o tempo todo.
 *
 * LEITURA PURA: nenhum botão desta página altera dinheiro, provedor ou dado.
 *
 * O período vive na query string (`?de=&ate=&g=`) e é lido no cliente depois
 * de hidratar; o servidor renderiza a mesma casca para qualquer período.
 */
export function AdminReceitaPage() {
  const [periodo, setPeriodo] = useState<PeriodoReceita | null>(null);

  useEffect(() => {
    setPeriodo(periodoFromSearch(window.location.search, new Date()));
  }, []);

  const aplicar = useCallback((proximo: PeriodoReceita) => {
    setPeriodo(proximo);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${periodoToSearch(proximo)}`,
    );
  }, []);

  const query = trpc.admin.receita.dashboard.useQuery(
    periodo ?? { de: "2000-01-01", ate: "2000-02-01", granularidade: "mes" },
    { enabled: periodo !== null, staleTime: 30_000, placeholderData: keepPreviousData },
  );

  return (
    <AdminShell
      activeBc="financeiro"
      activeNav="pagamentos"
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "pagamentos", href: "/admin/pagamentos" },
        { label: "receita" },
      ]}
      bcContext="taxas da plataforma registradas no ledger"
    >
      <section className="space-y-6">
        <PagamentosTabs active="receita" />
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            <DddBadge bc="financeiro" size="sm" />
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
              admin · pagamentos · receita
            </p>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-ink">{ROTULOS.receita}</h1>
          <p className="max-w-3xl text-[14px] leading-relaxed text-ink-soft">
            Taxas que a plataforma registrou em cada pagamento aprovado, pela data em que foram
            registradas, e cancelamentos pela data em que ocorreram. Não é o valor arrecadado pelas
            campanhas.
          </p>
        </header>

        {periodo ? <ReceitaPeriodoFiltro periodo={periodo} onAplicar={aplicar} /> : null}

        {query.error ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800"
          >
            Não foi possível carregar a receita do período. {query.error.message}
          </div>
        ) : null}

        {!query.error && !query.data ? (
          <p role="status" className="font-mono text-[12px] text-ink-mute">
            carregando…
          </p>
        ) : null}

        {!query.error && query.data ? (
          <div
            className={query.isPlaceholderData ? "space-y-8 opacity-60" : "space-y-8"}
            aria-busy={query.isFetching}
          >
            <ReceitaPainel data={query.data} />
            <ReceitaCampanhasDrilldown
              key={`${query.data.periodo.de}:${query.data.periodo.ate}`}
              de={query.data.periodo.de}
              ate={query.data.periodo.ate}
            />
          </div>
        ) : null}
      </section>
    </AdminShell>
  );
}

/** Painel puro: tudo o que vem de UMA resposta de `admin.receita.dashboard`. */
export function ReceitaPainel({ data }: { data: ReceitaDashboard }) {
  const { granularidade } = data.periodo;
  return (
    <div className="space-y-8">
      <LimitesDaFonte
        primeiroRegistroTaxaEm={data.primeiroRegistroTaxaEm}
        snapshotAt={data.snapshotAt}
      />
      <ConciliacaoAviso conciliacao={data.conciliacao} />
      <InconsistenciasAviso inconsistencias={data.inconsistencias} />
      <ReceitaCards cards={data.cards} />
      <section aria-labelledby="receita-serie-title" className="space-y-3">
        <h2 id="receita-serie-title" className="text-lg font-semibold text-ink">
          Ao longo do período
        </h2>
        <ReceitaSerieChart serie={data.serie} granularidade={granularidade} />
        <ReceitaSerieTabela
          serie={data.serie}
          granularidade={granularidade}
          somaSerie={data.conciliacao.somaSerie}
        />
      </section>
      <ReceitaPorCampanha
        porCampanha={data.porCampanha}
        somaPorCampanha={data.conciliacao.somaPorCampanha}
      />
      <ReceitaPorMeioProvedor
        rows={data.porMeioProvedor}
        soma={data.conciliacao.somaPorMeioProvedor}
      />
    </div>
  );
}

const MENSAGEM_PERIODO: Record<PeriodoInvalido, string> = {
  data_invalida: "Informe as duas datas.",
  intervalo_vazio: "A data final precisa ser igual ou posterior à inicial.",
  buckets_demais:
    "Período longo demais para esta visão: o limite é de 120 intervalos. Encurte o período ou use a visão por mês.",
};

const CONTROLE =
  "min-h-11 rounded border border-line bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft transition-colors hover:border-plum hover:text-plum focus:outline-none focus-visible:ring-2 focus-visible:ring-plum";

export function ReceitaPeriodoFiltro({
  periodo,
  onAplicar,
  now = () => new Date(),
}: {
  periodo: PeriodoReceita;
  onAplicar: (periodo: PeriodoReceita) => void;
  now?: () => Date;
}) {
  const id = useId();
  const [de, setDe] = useState(periodo.de);
  const [ateInclusive, setAteInclusive] = useState(ultimoDiaIncluido(periodo.ate));
  const [erro, setErro] = useState<PeriodoInvalido | null>(null);

  useEffect(() => {
    setDe(periodo.de);
    setAteInclusive(ultimoDiaIncluido(periodo.ate));
    setErro(null);
  }, [periodo.de, periodo.ate]);

  const tentar = useCallback(
    (candidato: PeriodoReceita) => {
      const grade = bucketsDoPeriodo(candidato);
      if (!grade.ok) {
        setErro(grade.erro);
        return;
      }
      setErro(null);
      onAplicar(candidato);
    },
    [onAplicar],
  );

  const trocarGranularidade = (granularidade: Granularidade) => {
    if (granularidade === periodo.granularidade) return;
    const mantido: PeriodoReceita = { ...periodo, granularidade };
    // Mantém o intervalo quando ele cabe na nova visão; senão, usa o padrão.
    onAplicar(bucketsDoPeriodo(mantido).ok ? mantido : periodoPadrao(now(), granularidade));
    setErro(null);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (de === "" || ateInclusive === "") {
      setErro("data_invalida");
      return;
    }
    let ate: string;
    try {
      ate = addDays(ateInclusive, 1);
    } catch {
      setErro("data_invalida");
      return;
    }
    tentar({ de, ate, granularidade: periodo.granularidade });
  };

  const atalhos: ReadonlyArray<{ rotulo: string; periodo: () => PeriodoReceita }> = [
    { rotulo: "Últimos 12 meses", periodo: () => periodoPadrao(now(), "mes") },
    { rotulo: "Últimas 12 semanas", periodo: () => periodoPadrao(now(), "semana") },
    { rotulo: "Mês atual", periodo: () => ({ ...mesAtual(now()), granularidade: "semana" }) },
    {
      rotulo: "Semana atual",
      periodo: () => ({ ...semanaAtual(now()), granularidade: "semana" }),
    },
  ];

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Período da receita"
      className="space-y-3 rounded-md border border-line bg-cream-2/30 p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <fieldset className="min-w-0">
          <legend className="mb-1 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft">
            Agrupar por
          </legend>
          <div className="flex gap-2">
            {(
              [
                ["mes", "Mês"],
                ["semana", "Semana"],
              ] as const
            ).map(([valor, rotulo]) => (
              <button
                key={valor}
                type="button"
                aria-pressed={periodo.granularidade === valor}
                onClick={() => trocarGranularidade(valor)}
                className={`${CONTROLE} ${
                  periodo.granularidade === valor ? "border-plum bg-paper text-ink" : ""
                }`}
              >
                {rotulo}
              </button>
            ))}
          </div>
        </fieldset>

        <label
          htmlFor={`${id}-de`}
          className="min-w-0 space-y-1 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft"
        >
          De
          <input
            id={`${id}-de`}
            type="date"
            required
            value={de}
            onChange={(event) => setDe(event.target.value)}
            className="block min-h-11 w-full min-w-0 rounded border border-line bg-paper px-3 py-2 text-[13px] normal-case tracking-normal text-ink focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
          />
        </label>
        <label
          htmlFor={`${id}-ate`}
          className="min-w-0 space-y-1 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft"
        >
          Até (inclusive)
          <input
            id={`${id}-ate`}
            type="date"
            required
            value={ateInclusive}
            onChange={(event) => setAteInclusive(event.target.value)}
            className="block min-h-11 w-full min-w-0 rounded border border-line bg-paper px-3 py-2 text-[13px] normal-case tracking-normal text-ink focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
          />
        </label>
        <button type="submit" className={`${CONTROLE} border-plum text-ink`}>
          Aplicar período
        </button>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Atalhos de período">
        {atalhos.map((atalho) => (
          <button
            key={atalho.rotulo}
            type="button"
            onClick={() => tentar(atalho.periodo())}
            className={CONTROLE}
          >
            {atalho.rotulo}
          </button>
        ))}
      </div>

      {erro ? (
        <p role="alert" className="text-[13px] text-red-800">
          {MENSAGEM_PERIODO[erro]}
        </p>
      ) : null}
      <p className="text-[12px] text-ink-mute">
        Datas no horário de São Paulo. Semana de segunda a domingo.
      </p>
    </form>
  );
}
