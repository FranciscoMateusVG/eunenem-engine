import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { PagamentosTabs } from "@/components/eunenem/admin/PagamentosTabs";
import {
  DespesasCabecalho,
  DespesasPainel,
} from "@/components/eunenem/admin/despesas/DespesasPainel";
import { trpc } from "@/lib/trpc.js";

/**
 * /admin/pagamentos/despesas — aba Despesas (aperture-5qoz0 PR3).
 *
 * Tarifas de processamento observadas na Stripe (cartão) e no Inter (PIX),
 * pela data do débito: mês e semana atuais, os últimos 12 meses e as semanas
 * do mês corrente, em America/Sao_Paulo, mais a cobertura (confirmadas,
 * pendentes, falhas). Pendente nunca é mostrado como zero.
 *
 * LEITURA PURA: nenhuma chamada a provedor; nenhum botão altera dado.
 */
export function AdminDespesasPage() {
  const query = trpc.admin.despesas.painel.useQuery(undefined, { staleTime: 30_000 });

  return (
    <AdminShell
      activeBc="financeiro"
      activeNav="pagamentos"
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "pagamentos", href: "/admin/pagamentos" },
        { label: "despesas" },
      ]}
      bcContext="tarifas observadas nos provedores"
    >
      <section className="flex flex-col gap-7 leading-[normal]">
        <PagamentosTabs active="despesas" />
        <DespesasCabecalho hoje={query.data?.hoje ?? null} />

        {query.error ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800"
          >
            Não foi possível carregar as despesas. {query.error.message}
          </div>
        ) : null}

        {!query.error && !query.data ? (
          <p role="status" className="font-mono text-[12px] text-ink-mute">
            carregando…
          </p>
        ) : null}

        {!query.error && query.data ? <DespesasPainel data={query.data} /> : null}
      </section>
    </AdminShell>
  );
}
