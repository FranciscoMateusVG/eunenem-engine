import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { CaixaPainel } from "@/components/eunenem/admin/caixa/CaixaPainel";
import { PagamentosTabs } from "@/components/eunenem/admin/PagamentosTabs";
import {
  CAIXA_GRANULARIDADES,
  type CaixaGranularidade,
  type PeriodoCaixa,
} from "@/lib/caixaPeriodo";
import { addDays, addMonthsToMonthStart, localDateInSaoPaulo, startOfMonth } from "@/lib/receitaPeriodo";
import { trpc } from "@/lib/trpc.js";

/**
 * /admin/pagamentos/caixa — Fluxo de caixa (aperture-zoxel).
 *
 * Quanto dinheiro ENTROU (pagamentos aprovados) e quanto SAIU (repasses já
 * transferidos), por dia/semana/mês em America/Sao_Paulo. Repasses aprovados
 * mas ainda não transferidos e os em verificação aparecem à parte e NÃO
 * contam como saída. LEITURA PURA: nada aqui move dinheiro nem altera dado.
 * O período vive na query string (`?de=&ate=&g=`), lido após hidratar.
 */

const ROTULO_GRANULARIDADE: Record<CaixaGranularidade, string> = {
  dia: "por dia",
  semana: "por semana",
  mes: "por mês",
};

function periodoPadrao(hoje: Date): PeriodoCaixa {
  const de = startOfMonth(localDateInSaoPaulo(hoje));
  return { de, ate: addMonthsToMonthStart(de, 1), granularidade: "dia" };
}

function periodoDaUrl(search: string, hoje: Date): PeriodoCaixa {
  const params = new URLSearchParams(search);
  const padrao = periodoPadrao(hoje);
  const de = params.get("de");
  const ate = params.get("ate");
  const g = params.get("g");
  const valida = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  return {
    de: valida(de) ? de : padrao.de,
    ate: valida(ate) ? ate : padrao.ate,
    granularidade: (CAIXA_GRANULARIDADES as readonly string[]).includes(g ?? "")
      ? (g as CaixaGranularidade)
      : padrao.granularidade,
  };
}

export function AdminCaixaPage() {
  const [periodo, setPeriodo] = useState<PeriodoCaixa | null>(null);

  useEffect(() => {
    setPeriodo(periodoDaUrl(window.location.search, new Date()));
  }, []);

  const aplicar = (proximo: PeriodoCaixa) => {
    setPeriodo(proximo);
    const qs = new URLSearchParams({ de: proximo.de, ate: proximo.ate, g: proximo.granularidade });
    window.history.replaceState(null, "", `${window.location.pathname}?${qs.toString()}`);
  };

  const query = trpc.admin.caixa.painel.useQuery(
    periodo ?? { de: "2000-01-01", ate: "2000-01-02", granularidade: "dia" },
    { enabled: periodo !== null, staleTime: 30_000, placeholderData: keepPreviousData },
  );

  const utils = trpc.useUtils();
  const baixarCsv = async (p: PeriodoCaixa) => {
    const arquivo = await utils.admin.caixa.csv.fetch(p, { staleTime: 0 });
    const url = URL.createObjectURL(new Blob([arquivo.conteudo], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = arquivo.nomeArquivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <AdminShell
      activeBc="financeiro"
      activeNav="pagamentos"
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "pagamentos", href: "/admin/pagamentos" },
        { label: "fluxo de caixa" },
      ]}
      bcContext="entradas e saídas de dinheiro — só leitura"
    >
      <section className="flex flex-col gap-7 leading-[normal]">
        <PagamentosTabs active="caixa" />
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-ink">Fluxo de caixa</h1>
          <p className="max-w-3xl text-[14px] text-ink-soft">
            Quanto dinheiro entrou (pagamentos aprovados) e quanto saiu (repasses já transferidos
            para as famílias). Datas no horário de São Paulo. Esta tela só mostra números: não
            envia nem altera nenhum pagamento ou repasse.
          </p>
        </header>

        {periodo ? (
          <FiltroPeriodo periodo={periodo} aoAplicar={aplicar} hoje={query.data?.hoje ?? null} />
        ) : null}

        {query.error ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
            Não foi possível carregar o fluxo de caixa. {query.error.message}
          </div>
        ) : null}

        {!query.error && !query.data ? (
          <p role="status" className="font-mono text-[12px] text-ink-mute">
            carregando…
          </p>
        ) : null}

        {!query.error && query.data ? <CaixaPainel data={query.data} aoBaixarCsv={baixarCsv} /> : null}
      </section>
    </AdminShell>
  );
}

function FiltroPeriodo({
  periodo,
  aoAplicar,
  hoje,
}: {
  periodo: PeriodoCaixa;
  aoAplicar: (p: PeriodoCaixa) => void;
  hoje: string | null;
}) {
  const id = useId();
  const [de, setDe] = useState(periodo.de);
  // O campo mostra o último dia INCLUÍDO; o servidor recebe o fim exclusivo.
  const [ateIncluso, setAteIncluso] = useState(addDays(periodo.ate, -1));
  const [granularidade, setGranularidade] = useState(periodo.granularidade);

  useEffect(() => {
    setDe(periodo.de);
    setAteIncluso(addDays(periodo.ate, -1));
    setGranularidade(periodo.granularidade);
  }, [periodo]);

  const mesAtual = () => {
    const inicio = startOfMonth(hoje ?? localDateInSaoPaulo(new Date()));
    aoAplicar({ de: inicio, ate: addMonthsToMonthStart(inicio, 1), granularidade });
  };

  const campo =
    "min-h-11 rounded-md border border-line bg-white px-3 font-mono text-[13px] text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-plum";

  return (
    <form
      aria-label="Período do fluxo de caixa"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!de || !ateIncluso || ateIncluso < de) return;
        aoAplicar({ de, ate: addDays(ateIncluso, 1), granularidade });
      }}
    >
      <label htmlFor={`${id}-de`} className="flex flex-col gap-1 text-[12px] text-ink-soft">
        De
        <input
          id={`${id}-de`}
          type="date"
          className={campo}
          value={de}
          onChange={(e) => setDe(e.target.value)}
        />
      </label>
      <label htmlFor={`${id}-ate`} className="flex flex-col gap-1 text-[12px] text-ink-soft">
        Até (inclusive)
        <input
          id={`${id}-ate`}
          type="date"
          className={campo}
          value={ateIncluso}
          onChange={(e) => setAteIncluso(e.target.value)}
        />
      </label>
      <label htmlFor={`${id}-g`} className="flex flex-col gap-1 text-[12px] text-ink-soft">
        Agrupar
        <select
          id={`${id}-g`}
          className={campo}
          value={granularidade}
          onChange={(e) => setGranularidade(e.target.value as CaixaGranularidade)}
        >
          {CAIXA_GRANULARIDADES.map((g) => (
            <option key={g} value={g}>
              {ROTULO_GRANULARIDADE[g]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="min-h-11 rounded-md bg-plum px-4 font-mono text-[12px] uppercase tracking-[0.12em] text-white"
      >
        Aplicar
      </button>
      <button
        type="button"
        onClick={mesAtual}
        className="min-h-11 rounded-md border border-line px-4 font-mono text-[12px] uppercase tracking-[0.12em] text-ink-soft hover:text-plum"
      >
        Mês atual
      </button>
    </form>
  );
}
