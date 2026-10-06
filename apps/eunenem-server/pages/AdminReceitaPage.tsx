import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { PagamentosTabs } from "@/components/eunenem/admin/PagamentosTabs";
import {
  ReceitaCabecalho,
  ReceitaPainel,
} from "@/components/eunenem/admin/receita/ReceitaPainel";
import { trpc } from "@/lib/trpc.js";

/**
 * /admin/pagamentos/receita — aba Receita EuNeném, proposta 1b
 * (aperture-zn5cm; antes aperture-9bpre).
 *
 * Tarifas EuNeném (taxas da plataforma menos cancelamentos) e Recebido no
 * banco (pagamentos aprovados menos estornos, estimativa) lado a lado: mês e
 * semana atuais, os últimos 12 meses e as semanas do mês corrente, em
 * America/Sao_Paulo.
 *
 * LEITURA PURA: nenhum botão desta página altera dinheiro, provedor ou dado.
 */
export function AdminReceitaPage() {
  const query = trpc.admin.receita.painel.useQuery(undefined, { staleTime: 30_000 });

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
      {/* Entrelinha "normal", como no design 1b (o preflight usa 1.5). */}
      <section className="flex flex-col gap-7 leading-[normal]">
        <PagamentosTabs active="receita" />
        <ReceitaCabecalho hoje={query.data?.hoje ?? null} />

        {query.error ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800"
          >
            Não foi possível carregar a receita. {query.error.message}
          </div>
        ) : null}

        {!query.error && !query.data ? (
          <p role="status" className="font-mono text-[12px] text-ink-mute">
            carregando…
          </p>
        ) : null}

        {!query.error && query.data ? <ReceitaPainel data={query.data} /> : null}
      </section>
    </AdminShell>
  );
}
