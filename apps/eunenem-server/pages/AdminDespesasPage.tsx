import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { PagamentosTabs } from "@/components/eunenem/admin/PagamentosTabs";
import {
  DespesasCabecalho,
  DespesasPainel,
} from "@/components/eunenem/admin/despesas/DespesasPainel";
import {
  DespesasManuaisLista,
  FormDespesaManual,
} from "@/components/eunenem/admin/despesas/DespesasManuais";
import { trpc } from "@/lib/trpc.js";

/**
 * /admin/pagamentos/despesas — aba Despesas (aperture-5qoz0 PR3).
 *
 * Tarifas de processamento observadas na Stripe (cartão) e no Inter (PIX),
 * pela data do débito: mês e semana atuais, os últimos 12 meses e as semanas
 * do mês corrente, em America/Sao_Paulo, mais a cobertura (confirmadas,
 * pendentes, falhas). Pendente nunca é mostrado como zero.
 *
 * Tarifas: LEITURA PURA, nenhuma chamada a provedor. A única escrita é o
 * cadastro de despesas recorrentes/manuais (aperture-0ngn4), abaixo do painel.
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

        {query.data ? <DespesasManuaisSecao hoje={query.data.hoje} /> : null}
      </section>
    </AdminShell>
  );
}

/** Cadastro + lista; cada mutação invalida o painel (total muda). */
function DespesasManuaisSecao({ hoje }: { hoje: string }) {
  const utils = trpc.useUtils();
  const lista = trpc.admin.despesas.manuais.listar.useQuery(undefined, { staleTime: 30_000 });
  const aoMudar = {
    onSuccess: async () => {
      await Promise.all([
        utils.admin.despesas.manuais.listar.invalidate(),
        utils.admin.despesas.painel.invalidate(),
      ]);
    },
  };
  const criar = trpc.admin.despesas.manuais.criar.useMutation(aoMudar);
  const alterarValor = trpc.admin.despesas.manuais.alterarValor.useMutation(aoMudar);
  const encerrar = trpc.admin.despesas.manuais.encerrar.useMutation(aoMudar);

  return (
    <section data-testid="despesas-manuais" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[16px] font-semibold tracking-normal! text-ink">
          Despesas recorrentes e manuais
        </h2>
        <span className="font-mono text-[11px] text-ink-mute">
          mudar o valor vale a partir de uma data · o passado não muda
        </span>
      </div>
      <FormDespesaManual
        key={criar.isSuccess ? `ok-${criar.submittedAt}` : "novo"}
        hoje={hoje}
        salvando={criar.isPending}
        erro={criar.error?.message ?? null}
        onSalvar={(despesa) => criar.mutate(despesa)}
      />
      {lista.error ? (
        <p role="alert" className="text-[13px] text-red-800">
          Não foi possível carregar as despesas cadastradas. {lista.error.message}
        </p>
      ) : lista.data ? (
        <DespesasManuaisLista
          despesas={lista.data.despesas}
          hoje={hoje}
          salvando={alterarValor.isPending || encerrar.isPending}
          erro={alterarValor.error?.message ?? encerrar.error?.message ?? null}
          onAlterarValor={(input) => alterarValor.mutate(input)}
          onEncerrar={(input) => encerrar.mutate(input)}
        />
      ) : (
        <p role="status" className="font-mono text-[12px] text-ink-mute">
          carregando…
        </p>
      )}
    </section>
  );
}
