import { useEffect, useState, type ReactNode } from 'react';
import { AdminShell } from '@/components/eunenem/admin/AdminShell';
import { EstatisticasTabs, PeriodoSelect } from '@/components/eunenem/admin/estatisticas/EstatisticasNav';
import { GraficoBarras } from '@/components/eunenem/admin/estatisticas/GraficoBarras';
import { trpc } from '@/lib/trpc.js';
import {
  hrefSecao,
  MESES_PADRAO,
  mesesFromSearch,
  type MesesPeriodo,
  SECOES,
  type SecaoEstatisticas,
} from './lib/estatisticasSecoes.js';
import type { Estatisticas } from './lib/estatisticas.js';
import { addDays, formatLocalDate } from './lib/receitaPeriodo.js';
import { nomeMes, rotuloMesCurto } from './lib/receitaPainel.js';

const numero = (n: number) => n.toLocaleString('pt-BR', {maximumFractionDigits:2});
const SERIE_NOVOS = [{chave:'novos',nome:'Novos usuários',cor:'bg-lilac-deep',corParcial:'bg-lilac-soft'}] as const;

/** Novos usuários (jbd25/pxmdy): primeira etapa do funil. */
export function EstatisticasPainel({data,meses}:{data:Estatisticas;meses:MesesPeriodo}) {
  return <div className="flex min-w-0 flex-col gap-6">
    <div className="rounded-xl border border-line p-5"><h2>Total de usuários</h2><p data-testid="estatisticas-total" className="text-3xl font-semibold tabular-nums">{numero(data.total)}</p><p className="text-sm text-ink-soft">Não desativados · {numero(data.excluidos)} contas internas/QA excluídas</p></div>
    <GraficoBarras titulo="Novos usuários por mês" explicacao="Perfis criados no EuNeném 2.0 em cada mês. O mês atual é parcial (tom claro)." series={SERIE_NOVOS} formatar={numero} testId="estatisticas-mes"
      barras={data.meses.slice(-meses).map(m=>({chave:m.de,rotulo:rotuloMesCurto(m.de),titulo:`${nomeMes(m.de)} ${m.de.slice(0,4)}${m.parcial?' (parcial)':''}: ${numero(m.novos)} novos usuários`,parcial:m.parcial,valores:{novos:m.novos}}))}/>
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
  </div>;
}

const DESCRICAO: Record<SecaoEstatisticas,string> = {
  funil:'Do cadastro ao primeiro presente recebido · calendário de São Paulo',
  vendas:'Volume de presentes, ticket médio e PIX × cartão',
  trafego:'Visitas e origens do site (Mixpanel)',
  saude:'Falhas de provedor, webhooks, checkout e e-mails',
};

/** Cabeçalho, abas e seletor de período comuns a todas as seções. */
export function EstatisticasLayout({secao,meses,onMeses,children}:{secao:SecaoEstatisticas;meses:MesesPeriodo;onMeses:(m:MesesPeriodo)=>void;children:ReactNode}) {
  return <section className="flex min-w-0 flex-col gap-6">
    <header><h1 className="text-2xl font-semibold">Estatísticas</h1><p className="text-sm text-ink-soft">{DESCRICAO[secao]}</p></header>
    <EstatisticasTabs active={secao} meses={meses}/>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">{SECOES.find(s=>s.key===secao)!.label}</h2>
      <PeriodoSelect meses={meses} onChange={onMeses}/>
    </div>
    {children}
  </section>;
}

function SecaoEmPreparo({secao}:{secao:SecaoEstatisticas}) {
  return <p role="status" data-testid="estatisticas-em-preparo" className="rounded-lg border border-dashed border-line p-6 text-sm text-ink-soft">
    Esta seção ({DESCRICAO[secao].toLowerCase()}) ainda está sendo preparada.
  </p>;
}

function SecaoFunil({meses}:{meses:MesesPeriodo}) {
  const q=trpc.admin.estatisticas.useQuery(undefined,{staleTime:30000});
  if (q.error) return <p role="alert">Não foi possível carregar as estatísticas. {q.error.message}</p>;
  if (!q.data) return <p role="status">Carregando estatísticas…</p>;
  return <EstatisticasPainel data={q.data} meses={meses}/>;
}

/** Período da URL; lido depois da hidratação porque o SSR só vê o pathname. */
function useMesesDaUrl(secao:SecaoEstatisticas) {
  const [meses,setMeses]=useState<MesesPeriodo>(MESES_PADRAO);
  useEffect(()=>{setMeses(mesesFromSearch(window.location.search));},[]);
  const mudar=(m:MesesPeriodo)=>{
    setMeses(m);
    window.history.replaceState(window.history.state,'',hrefSecao(secao,m));
  };
  return [meses,mudar] as const;
}

export function AdminEstatisticasPage({secao}:{secao:SecaoEstatisticas}) {
  const [meses,setMeses]=useMesesDaUrl(secao);
  const label=SECOES.find(s=>s.key===secao)!.label;
  return <AdminShell activeNav="estatisticas" activeBc={null}
    breadcrumb={secao==='funil'?[{label:'admin',href:'/admin'},{label:'estatisticas'}]:[{label:'admin',href:'/admin'},{label:'estatisticas',href:'/admin/estatisticas'},{label:label.toLowerCase()}]}
    bcContext="métricas do EuNeném">
    <EstatisticasLayout secao={secao} meses={meses} onMeses={setMeses}>
      {secao==='funil'?<SecaoFunil meses={meses}/>:<SecaoEmPreparo secao={secao}/>}
    </EstatisticasLayout>
  </AdminShell>;
}
