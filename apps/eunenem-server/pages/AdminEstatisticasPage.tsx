import { useState } from 'react';
import { AdminShell } from '@/components/eunenem/admin/AdminShell';
import { trpc } from '@/lib/trpc.js';
import type { Estatisticas } from './lib/estatisticas.js';
import { addDays, formatLocalDate } from './lib/receitaPeriodo.js';
import { rotuloMesCurto } from './lib/receitaPainel.js';

const numero = (n: number) => n.toLocaleString('pt-BR', {maximumFractionDigits:2});
export function EstatisticasPainel({data}:{data:Estatisticas}) {
  const [meses,setMeses]=useState(3);
  return <section className="flex min-w-0 flex-col gap-6">
    <header><h1 className="text-2xl font-semibold">Estatísticas</h1><p className="text-sm text-ink-soft">Contas EuNeném 2.0 · calendário de São Paulo · até {formatLocalDate(data.hoje)}</p></header>
    <div className="rounded-xl border border-line p-5"><h2>Total de usuários</h2><p data-testid="estatisticas-total" className="text-3xl font-semibold tabular-nums">{numero(data.total)}</p><p className="text-sm text-ink-soft">Não desativados · {numero(data.excluidos)} contas internas/QA excluídas</p></div>
    <section className="rounded-xl border border-line p-4" aria-label="Novos usuários por mês">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2>Novos usuários por mês</h2>
      <label className="flex items-center gap-2 text-sm">Período mensal<select aria-label="Período mensal" className="rounded-lg border border-line bg-white p-2" value={meses} onChange={e=>{const n=Number(e.target.value);if(n===3||n===6||n===12)setMeses(n);}}>
        {[3,6,12].map(n=><option key={n} value={n}>Últimos {n} meses</option>)}
      </select></label></div>
      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">{data.meses.slice(-meses).map(m=><div data-testid="estatisticas-mes" key={m.de} className="rounded-lg bg-stone-50 p-3"><div className="text-sm">{rotuloMesCurto(m.de)}{m.parcial?' · parcial':''}</div><div className="text-2xl font-semibold tabular-nums">{numero(m.novos)}</div></div>)}</div>
    </section>
    <section aria-label="Novos usuários por semana" className="rounded-xl border border-line p-4">
      <h2>Novos usuários por semana</h2><p className="mt-1 text-sm text-ink-soft">Segunda a domingo · variação contra a semana anterior · média móvel de 4 semanas</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{data.semanas.map(s=><article data-testid="estatisticas-semana" key={s.de} className="rounded-lg border border-line p-3 text-sm">
        <h3 className="text-sm">{formatLocalDate(s.de)} – {formatLocalDate(addDays(s.ate,-1))}{s.parcial?' · parcial':''}</h3>
        <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1"><dt>Novos usuários</dt><dd className="text-right font-semibold tabular-nums">{numero(s.novos)}</dd>
        <dt>Variação semanal</dt><dd className="text-right tabular-nums">{s.variacaoPct===null?'— base zero':`${s.variacaoPct>0?'+':''}${numero(s.variacaoPct)}%`}</dd>
        <dt>Média 4 semanas</dt><dd className="text-right tabular-nums">{numero(s.media4Semanas)}</dd></dl>
      </article>)}</div>
    </section>
    <aside className="text-sm text-ink-soft"><p>Semana e mês atuais são parciais. A variação compara o acumulado atual com a semana anterior inteira; não indica queda definitiva. A média inclui a semana exibida e as três anteriores, inclusive semanas sem cadastros.</p>
    <p className="mt-2">Data de criação do perfil no 2.0, não da primeira conta no legado: a migração pode aparecer como cadastro novo. Todas as séries excluem contas desativadas hoje e podem ser revistas após desativação. Excluímos a conta do operador, seus aliases e fixtures identificadas; não todos os administradores.</p></aside>
  </section>;
}
export function AdminEstatisticasPage() {
  const q=trpc.admin.estatisticas.useQuery(undefined,{staleTime:30000});
  return <AdminShell activeNav="estatisticas" activeBc={null} breadcrumb={[{label:'admin',href:'/admin'},{label:'estatisticas'}]} bcContext="crescimento de contas EuNeném">
    {q.error?<p role="alert">Não foi possível carregar as estatísticas. {q.error.message}</p>:q.data?<EstatisticasPainel data={q.data}/>:<p role="status">Carregando estatísticas…</p>}
  </AdminShell>;
}
