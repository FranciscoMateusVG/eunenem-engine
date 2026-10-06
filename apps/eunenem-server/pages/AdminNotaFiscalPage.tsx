import { keepPreviousData } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { NotaFiscalPainel } from "@/components/eunenem/admin/nota-fiscal/NotaFiscalPainel";
import { PagamentosTabs } from "@/components/eunenem/admin/PagamentosTabs";
import { isMes, mesAtualSP, mesFromSearch, mesToSearch } from "@/lib/notaFiscalMes";
import { trpc } from "@/lib/trpc.js";

/**
 * /admin/pagamentos/nota-fiscal — PRÉVIA da NFS-e mensal (aperture-dh1k7).
 *
 * O operador escolhe um mês e vê a nota que seria emitida: valor (o mesmo
 * "Resultado de taxas" da Receita), detalhamento, campos da DPS e o XML.
 *
 * NÃO EXISTE ENVIO: nenhum botão desta página emite, envia ou cancela nota,
 * e nada é gravado. O mês vive na query string (`?mes=YYYY-MM`) e é lido no
 * cliente depois de hidratar.
 */
export function AdminNotaFiscalPage() {
  const [mes, setMes] = useState<string | null>(null);

  useEffect(() => {
    setMes(mesFromSearch(window.location.search, new Date()));
  }, []);

  const aplicar = useCallback((proximo: string) => {
    setMes(proximo);
    window.history.replaceState(null, "", `${window.location.pathname}${mesToSearch(proximo)}`);
  }, []);

  const query = trpc.admin.notaFiscal.previaMensal.useQuery(
    { mes: mes ?? "2000-01" },
    { enabled: mes !== null, staleTime: 30_000, placeholderData: keepPreviousData },
  );

  return (
    <AdminShell
      activeBc="financeiro"
      activeNav="pagamentos"
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "pagamentos", href: "/admin/pagamentos" },
        { label: "nota fiscal" },
      ]}
      bcContext="prévia da NFS-e mensal — nada é enviado"
    >
      <section className="space-y-6">
        <PagamentosTabs active="nota-fiscal" />
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            <DddBadge bc="financeiro" size="sm" />
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
              admin · pagamentos · nota fiscal
            </p>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-ink">
            Prévia da NFS-e mensal
          </h1>
          <div
            role="note"
            className="max-w-3xl rounded-md border border-plum/40 bg-plum/5 p-4 text-[14px] leading-relaxed text-ink"
          >
            <strong className="font-semibold">Isto é uma prévia.</strong> Nenhuma nota é emitida,
            enviada ao Sistema Nacional NFS-e ou cancelada a partir desta tela, e nada é gravado. A
            série 99999 e o número exibidos existem só na prévia.
          </div>
        </header>

        {mes ? <SeletorDeMes mes={mes} onAplicar={aplicar} /> : null}

        {query.error ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
            Não foi possível carregar a prévia do mês. {query.error.message}
          </div>
        ) : null}

        {!query.error && !query.data ? (
          <p role="status" className="font-mono text-[12px] text-ink-mute">
            carregando…
          </p>
        ) : null}

        {!query.error && query.data ? (
          <div
            className={query.isPlaceholderData ? "opacity-60" : undefined}
            aria-busy={query.isFetching}
          >
            <NotaFiscalPainel data={query.data} />
          </div>
        ) : null}
      </section>
    </AdminShell>
  );
}

const CONTROLE =
  "min-h-11 rounded border border-line bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft transition-colors hover:border-plum hover:text-plum focus:outline-none focus-visible:ring-2 focus-visible:ring-plum";

export function SeletorDeMes({
  mes,
  onAplicar,
  now = () => new Date(),
}: {
  mes: string;
  onAplicar: (mes: string) => void;
  now?: () => Date;
}) {
  const id = useId();
  const [valor, setValor] = useState(mes);
  const [erro, setErro] = useState(false);
  const maximo = mesAtualSP(now());

  useEffect(() => {
    setValor(mes);
    setErro(false);
  }, [mes]);

  const enviar = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (!isMes(valor) || valor > maximo) {
        setErro(true);
        return;
      }
      setErro(false);
      onAplicar(valor);
    },
    [valor, maximo, onAplicar],
  );

  return (
    <form onSubmit={enviar} className="flex flex-wrap items-end gap-3" noValidate>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-mes`} className="text-[12px] text-ink-soft">
          Mês de competência
        </label>
        <input
          id={`${id}-mes`}
          type="month"
          value={valor}
          max={maximo}
          onChange={(e) => setValor(e.target.value)}
          aria-invalid={erro}
          aria-describedby={erro ? `${id}-erro` : undefined}
          className="min-h-11 rounded border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink"
        />
      </div>
      <button type="submit" className={CONTROLE}>
        Ver prévia
      </button>
      {erro ? (
        <p id={`${id}-erro`} role="alert" className="w-full text-[13px] text-red-800">
          Escolha um mês até {maximo}.
        </p>
      ) : null}
    </form>
  );
}
