/**
 * Example: end-to-end interactive web demo for the engine.
 *
 * Boots a tiny Hono server that exposes 4 flows as crude HTML pages so you
 * can drive the whole engine from a browser:
 *
 *   1. Admin       — pick plataforma → create user → create campanha →
 *                    add opções → add contribuições
 *   2. Loja        — see contribuições disponíveis → pick → pay
 *   3. Status      — see all contribuições + pagamentos + their statuses
 *   4. Financeiro  — saldo + receita + repasse (request payout)
 *
 * All state lives in module-scoped memory adapters; restarting the process
 * wipes everything. A `Reset` button is on the home page too.
 *
 * Long-running by design — NOT part of `pnpm check`. Run with:
 *
 *   pnpm tsx examples/fluxo-completo.web.ts
 *
 * Then open http://127.0.0.1:3000 in a browser.
 */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { CampanhaRepositoryMemory } from '../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../src/adapters/financeiro/livro-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../src/adapters/pagamentos/event-publisher.memory.js';
import { PagamentoProviderFake } from '../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../src/adapters/pagamentos/repository.memory.js';
import { PlataformaRepositoryMemory } from '../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../src/adapters/taxas/regra-provider.memory.js';
import { AuthServiceMemoria } from '../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../src/adapters/usuario/repository.memory.js';
import type { LancamentoFinanceiro } from '../src/domain/financeiro/entities/lancamento-financeiro.js';
import { ConsoleLogger } from '../src/observability/console-logger.js';
import { noopTracer } from '../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../src/use-cases/arrecadacao/criar-contribuicao.js';
import { finalizarPagamentoAprovado } from '../src/use-cases/checkout/finalizar-pagamento-aprovado.js';
import { iniciarPagamentoContribuicao } from '../src/use-cases/checkout/iniciar-pagamento-contribuicao.js';
import { iniciarRepasseRecebedor } from '../src/use-cases/checkout/iniciar-repasse-recebedor.js';
import {
  type ContribuicaoPrecalculada,
  type OpcaoComContribuicoes,
  obterContribuicoesPrecalculadasCampanha,
} from '../src/use-cases/checkout/obter-contribuicoes-precalculadas-campanha.js';
import { registrarContaUsuario } from '../src/use-cases/usuario/registrar-conta-usuario.js';

// ──────────────────────────────────────────────────────────────────────────
// Module-scoped state (in-memory; lost on process restart or POST /reset)
// ──────────────────────────────────────────────────────────────────────────

const observability = {
  logger: new ConsoleLogger(),
  tracer: noopTracer(),
};

interface State {
  readonly plataformaRepository: PlataformaRepositoryMemory;
  readonly usuarioRepository: UsuarioRepositoryMemory;
  readonly authService: AuthServiceMemoria;
  readonly recebedorRepository: RecebedorRepositoryMemory;
  readonly campanhaRepository: CampanhaRepositoryMemory;
  readonly contribuicaoRepository: ContribuicaoRepositoryMemory;
  readonly provedorRegraTaxa: ProvedorRegraTaxaMemory;
  readonly pagamentoRepository: PagamentoRepositoryMemory;
  readonly pagamentoEventPublisher: PagamentoEventPublisherMemory;
  readonly pagamentoProvider: PagamentoProviderFake;
  readonly livroFinanceiroRepository: LivroFinanceiroRepositoryMemory;
}

function createState(): State {
  const recebedorRepository = new RecebedorRepositoryMemory();
  return {
    plataformaRepository: new PlataformaRepositoryMemory(),
    usuarioRepository: new UsuarioRepositoryMemory(),
    authService: new AuthServiceMemoria(),
    recebedorRepository,
    campanhaRepository: new CampanhaRepositoryMemory(recebedorRepository),
    contribuicaoRepository: new ContribuicaoRepositoryMemory(),
    provedorRegraTaxa: new ProvedorRegraTaxaMemory(),
    pagamentoRepository: new PagamentoRepositoryMemory(),
    pagamentoEventPublisher: new PagamentoEventPublisherMemory(),
    pagamentoProvider: new PagamentoProviderFake({ statusResultado: 'aprovado' }),
    livroFinanceiroRepository: new LivroFinanceiroRepositoryMemory(recebedorRepository),
  };
}

let state: State = createState();
const clock = () => new Date();

// ──────────────────────────────────────────────────────────────────────────
// DEMO-ONLY helper: flip pendente → disponivel for a campanha's lancamentos
//
// In production the maturation rule would live in domain (e.g. "lancamento
// mature D+30 after pagamento.criadoEm"). For this demo we mutate the
// LivroFinanceiroRepositoryMemory's internal map directly so the repasse
// flow is testable without waiting 30 days. Marked clearly as demo-only.
// ──────────────────────────────────────────────────────────────────────────
function matureLancamentosForCampanha(idCampanha: string): number {
  const internalMap = (
    state.livroFinanceiroRepository as unknown as {
      lancamentos: Map<string, LancamentoFinanceiro>;
    }
  ).lancamentos;
  let count = 0;
  for (const [id, l] of internalMap) {
    if (l.idCampanha === idCampanha && l.status === 'pendente') {
      internalMap.set(id, { ...l, status: 'disponivel' });
      count++;
    }
  }
  return count;
}

// ──────────────────────────────────────────────────────────────────────────
// HTML helpers (no CSS, very crude — easy to read in a browser)
// ──────────────────────────────────────────────────────────────────────────

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-br">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <header>
      <a href="/">← home</a>
    </header>
    <hr />
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatCents(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2)}`;
}

function errorPage(title: string, message: string): string {
  return page(title, `<p style="color:#a00"><strong>Erro:</strong> ${escapeHtml(message)}</p>`);
}

const LOJA_PAGE_SIZE = 30;

// ──────────────────────────────────────────────────────────────────────────
// Loja helpers — extracted so the route handler stays small and below the
// cognitive-complexity cap. See the LOJA handler for the full story.
// ──────────────────────────────────────────────────────────────────────────

interface LojaFilters {
  readonly grupoFiltro: string;
  readonly incluirIndisponiveis: boolean;
  readonly page: number;
}

interface CollapsedCard {
  readonly key: string;
  readonly nome: string;
  readonly imagemUrl: string | null;
  readonly grupo: string | null;
  readonly composicao: ContribuicaoPrecalculada['composicao'];
  readonly valorContribuicaoCents: number;
  readonly disponiveis: string[];
  indisponiveis: number;
}

function parseLojaPage(raw: string | undefined): number {
  const n = Number(raw ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function filterLojaContribs(
  contribs: readonly ContribuicaoPrecalculada[],
  filters: LojaFilters,
): ContribuicaoPrecalculada[] {
  let out: ContribuicaoPrecalculada[] = [...contribs];
  if (!filters.incluirIndisponiveis) out = out.filter((ct) => ct.disponivel);
  if (filters.grupoFiltro === '__sem_grupo__') {
    return out.filter((ct) => ct.grupo === null);
  }
  if (filters.grupoFiltro) {
    return out.filter((ct) => ct.grupo === filters.grupoFiltro);
  }
  return out;
}

function collapseLojaContribs(contribs: readonly ContribuicaoPrecalculada[]): CollapsedCard[] {
  const map = new Map<string, CollapsedCard>();
  for (const ct of contribs) {
    const key = `${ct.nome}|${ct.valorContribuicaoCents}|${ct.imagemUrl ?? ''}|${ct.grupo ?? ''}`;
    let card = map.get(key);
    if (!card) {
      card = {
        key,
        nome: ct.nome,
        imagemUrl: ct.imagemUrl,
        grupo: ct.grupo,
        composicao: ct.composicao,
        valorContribuicaoCents: ct.valorContribuicaoCents,
        disponiveis: [],
        indisponiveis: 0,
      };
      map.set(key, card);
    }
    if (ct.disponivel) card.disponiveis.push(ct.idContribuicao);
    else card.indisponiveis++;
  }
  return [...map.values()];
}

function sortCardsByGrupoFirstSeen(cards: readonly CollapsedCard[]): CollapsedCard[] {
  const grupoOrder = new Map<string | null, number>();
  let idx = 0;
  for (const card of cards) {
    if (grupoOrder.has(card.grupo)) continue;
    grupoOrder.set(card.grupo, card.grupo === null ? Number.POSITIVE_INFINITY : idx++);
  }
  return [...cards].sort((a, b) => {
    const oa = grupoOrder.get(a.grupo) ?? 0;
    const ob = grupoOrder.get(b.grupo) ?? 0;
    return oa - ob;
  });
}

function paginateCards(
  cards: readonly CollapsedCard[],
  page: number,
  pageSize: number,
): { totalPages: number; pageClamped: number; pageCards: CollapsedCard[] } {
  const totalPages = Math.max(1, Math.ceil(cards.length / pageSize));
  const pageClamped = Math.min(page, totalPages);
  const start = (pageClamped - 1) * pageSize;
  return { totalPages, pageClamped, pageCards: cards.slice(start, start + pageSize) };
}

function bucketCardsByGrupo(cards: readonly CollapsedCard[]): Map<string | null, CollapsedCard[]> {
  const buckets = new Map<string | null, CollapsedCard[]>();
  for (const card of cards) {
    const list = buckets.get(card.grupo);
    if (list) list.push(card);
    else buckets.set(card.grupo, [card]);
  }
  return buckets;
}

function countLabelFor(card: CollapsedCard, total: number): string {
  if (total !== 1) return `${card.disponiveis.length} de ${total} disponíveis`;
  return card.disponiveis.length === 1 ? 'disponível' : 'esgotado';
}

function renderCollapsedCard(card: CollapsedCard, slug: string, idCampanha: string): string {
  const total = card.disponiveis.length + card.indisponiveis;
  const buyId = card.disponiveis[0];
  const imgHtml = card.imagemUrl
    ? `<img src="${escapeHtml(card.imagemUrl)}" alt="" height="60" style="vertical-align:middle; margin-right:8px; border:1px solid #ccc" /> `
    : '';
  const actionHtml = buyId
    ? `<form method="get" action="/p/${escapeHtml(slug)}/loja/${escapeHtml(idCampanha)}/checkout/${escapeHtml(buyId)}" style="display:inline">
        <button type="submit">${total > 1 ? 'Comprar 1' : 'Comprar'}</button>
      </form>`
    : '<em>(esgotado)</em>';
  return `<li style="margin-bottom:8px">
    ${imgHtml}
    <strong>${escapeHtml(card.nome)}</strong> — base ${formatCents(card.valorContribuicaoCents)}
    + taxa ${formatCents(card.composicao.feeAmountCents)} =
    <strong>${formatCents(card.composicao.totalPaidCents)}</strong>
    <span style="color:#555">(${escapeHtml(countLabelFor(card, total))})</span>
    ${actionHtml}
  </li>`;
}

function renderBucketsHtml(
  buckets: Map<string | null, CollapsedCard[]>,
  renderOne: (card: CollapsedCard) => string,
): string {
  const hasAnyGroup = [...buckets.keys()].some((k) => k !== null);
  return [...buckets.entries()]
    .map(([grupo, list]) => {
      const heading = hasAnyGroup
        ? `<h3>${grupo === null ? '<em>(sem grupo)</em>' : escapeHtml(grupo)}</h3>`
        : '';
      return `${heading}<ul>${list.map(renderOne).join('')}</ul>`;
    })
    .join('');
}

function renderPaginationHtml(
  totalPages: number,
  pageClamped: number,
  totalCards: number,
  buildQuery: (overrides: Record<string, string | undefined>) => string,
): string {
  if (totalPages <= 1) {
    const label = totalCards === 1 ? 'item distinto' : 'itens distintos';
    return `<p style="color:#777">${totalCards} ${label}</p>`;
  }
  const prev =
    pageClamped > 1
      ? ` <a href="${buildQuery({ page: String(pageClamped - 1) })}">← anterior</a>`
      : '';
  const next =
    pageClamped < totalPages
      ? ` <a href="${buildQuery({ page: String(pageClamped + 1) })}">próxima →</a>`
      : '';
  return `<p style="color:#555">
    Página ${pageClamped} de ${totalPages} — ${totalCards} itens distintos
    ${prev}
    ${next}
  </p>`;
}

function makeBuildQuery(
  filters: LojaFilters,
): (overrides: Record<string, string | undefined>) => string {
  return (overrides) => {
    const params = new URLSearchParams();
    if (filters.grupoFiltro) params.set('grupo', filters.grupoFiltro);
    if (filters.incluirIndisponiveis) params.set('incluir_indisponiveis', '1');
    if (filters.page > 1) params.set('page', String(filters.page));
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) params.delete(k);
      else params.set(k, v);
    }
    const s = params.toString();
    return s ? `?${s}` : '';
  };
}

function collectGruposDistintos(opcoes: readonly OpcaoComContribuicoes[]): {
  grupos: readonly string[];
  temUngrouped: boolean;
} {
  const grupos = new Set<string>();
  let temUngrouped = false;
  for (const o of opcoes) {
    for (const ct of o.contribuicoes) {
      if (ct.grupo) grupos.add(ct.grupo);
      else temUngrouped = true;
    }
  }
  return { grupos: [...grupos].sort(), temUngrouped };
}

function renderFilterFormHtml(
  slug: string,
  idCampanha: string,
  grupos: readonly string[],
  temUngrouped: boolean,
  filters: LojaFilters,
): string {
  const opts = grupos
    .map(
      (g) =>
        `<option value="${escapeHtml(g)}" ${g === filters.grupoFiltro ? 'selected' : ''}>${escapeHtml(g)}</option>`,
    )
    .join('');
  const semGrupoOpt = temUngrouped
    ? `<option value="__sem_grupo__" ${filters.grupoFiltro === '__sem_grupo__' ? 'selected' : ''}>(sem grupo)</option>`
    : '';
  const limparHtml =
    filters.grupoFiltro || filters.incluirIndisponiveis || filters.page > 1
      ? ` <a href="/p/${escapeHtml(slug)}/loja/${escapeHtml(idCampanha)}" style="margin-left:8px">limpar</a>`
      : '';
  return `<form method="get" style="background:#f5f5f5; padding:8px; margin-bottom:12px">
    <label>Grupo:
      <select name="grupo">
        <option value="">(todos)</option>
        ${opts}
        ${semGrupoOpt}
      </select>
    </label>
    <label style="margin-left:8px">
      <input type="checkbox" name="incluir_indisponiveis" value="1" ${filters.incluirIndisponiveis ? 'checked' : ''} />
      incluir indisponíveis
    </label>
    <button type="submit" style="margin-left:8px">Aplicar</button>
    ${limparHtml}
  </form>`;
}

function renderLojaOpcao(
  opcao: OpcaoComContribuicoes,
  filters: LojaFilters,
  slug: string,
  idCampanha: string,
  buildQuery: (overrides: Record<string, string | undefined>) => string,
): string {
  const filtered = filterLojaContribs(opcao.contribuicoes, filters);
  if (filtered.length === 0) {
    return `<h2>${escapeHtml(opcao.tipo)}</h2><p><em>(nenhuma com os filtros atuais)</em></p>`;
  }
  const cards = collapseLojaContribs(filtered);
  const sorted = sortCardsByGrupoFirstSeen(cards);
  const { totalPages, pageClamped, pageCards } = paginateCards(
    sorted,
    filters.page,
    LOJA_PAGE_SIZE,
  );
  const buckets = bucketCardsByGrupo(pageCards);
  const bucketsHtml = renderBucketsHtml(buckets, (card) =>
    renderCollapsedCard(card, slug, idCampanha),
  );
  const paginationHtml = renderPaginationHtml(totalPages, pageClamped, sorted.length, buildQuery);
  return `<h2>${escapeHtml(opcao.tipo)}</h2>${bucketsHtml}${paginationHtml}`;
}

// ──────────────────────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────────────────────

const app = new Hono();

// ── HOME ────────────────────────────────────────────────────────────────────
app.get('/', async (c) => {
  const plataformas = await state.plataformaRepository.listAtivas();

  // collect a quick summary per plataforma (campanha count)
  const summaries = await Promise.all(
    plataformas.map(async (p) => {
      const campanhas = await state.campanhaRepository.findByPlataforma(p.id);
      return { plataforma: p, campanhas };
    }),
  );

  const body = `
    <p>
      Demo interativo do <strong>engine</strong> de intermediação financeira.
      Cada plataforma (eunenem, eucasei) tem suas próprias regras de taxa e usuários.
      Tudo é em memória — reinicie o processo ou clique no botão Reset para zerar.
    </p>

    <h2>Os 4 fluxos</h2>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Fluxo</th><th>URL</th><th>O que faz</th><th>Ator</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>1. Admin</strong></td>
          <td><code>/p/:slug</code> e <code>/admin/campanhas/...</code></td>
          <td>
            Cria usuários, cria campanhas, adiciona opções (presente/rifa/convite)
            e contribuições (itens com valor).
          </td>
          <td>Administrador</td>
        </tr>
        <tr>
          <td><strong>2. Loja</strong></td>
          <td><code>/p/:slug/loja/:idCampanha</code></td>
          <td>
            Mostra contribuições disponíveis com preço pré-calculado (base + taxa
            da plataforma) e dispara o checkout (Phase 2 saga + Phase 3 process manager).
          </td>
          <td>Contribuinte</td>
        </tr>
        <tr>
          <td><strong>3. Status</strong></td>
          <td><code>/p/:slug/status/:idCampanha</code></td>
          <td>
            Lista todas as contribuições (disponivel/indisponivel) e pagamentos
            (pendente/aprovado/rejeitado) da campanha — visão operacional.
          </td>
          <td>Admin / suporte</td>
        </tr>
        <tr>
          <td><strong>4. Financeiro</strong></td>
          <td><code>/p/:slug/financeiro/:idCampanha</code></td>
          <td>
            Saldo do recebedor (pendente + disponível), receita da plataforma,
            lancamentos detalhados. Permite solicitar repasse (Phase 5) e tem botão
            DEMO para maturar lancamentos pendentes (em produção seria regra D+30).
          </td>
          <td>Recebedor + admin</td>
        </tr>
      </tbody>
    </table>

    <h3>Roteiro sugerido para testar tudo</h3>
    <ol>
      <li>Escolha uma plataforma abaixo (<em>eunenem</em>: 5% em tudo; <em>eucasei</em>: 6% presente / 8% rifa).</li>
      <li><strong>Admin</strong>: crie um usuário, depois uma campanha com esse usuário como admin.</li>
      <li>Na página da campanha: adicione uma opção (ex: <em>presente</em>) e uma contribuição (ex: "Fralda", 8000 centavos).</li>
      <li><strong>Loja</strong>: confira o preço pré-calculado, clique "Comprar", preencha contribuinte, pague.</li>
      <li><strong>Status</strong>: veja a contribuição como <em>indisponivel</em> e o pagamento como <em>aprovado</em>.</li>
      <li><strong>Financeiro</strong>: veja o saldo pendente + receita. Clique <em>"Maturar pendentes"</em>. Solicite um repasse.</li>
      <li>Volte ao home e teste a outra plataforma para ver a diferença de preço (R$80 vira R$84 em eunenem vs R$86.40 em rifa eucasei).</li>
    </ol>

    <h2>Plataformas disponíveis</h2>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th>Nome</th><th>Slug</th><th>Campanhas</th><th>Abrir</th></tr>
      </thead>
      <tbody>
        ${summaries
          .map(
            ({ plataforma, campanhas }) => `<tr>
              <td><strong>${escapeHtml(plataforma.nome)}</strong></td>
              <td><code>${escapeHtml(plataforma.slug)}</code></td>
              <td>${campanhas.length}</td>
              <td><a href="/p/${escapeHtml(plataforma.slug)}">abrir →</a></td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>

    <h2>Reset</h2>
    <p style="color:#777">
      Apaga todos os usuários, campanhas, pagamentos, lancamentos e repasses.
      Recria as plataformas seed (eunenem + eucasei).
    </p>
    <form method="post" action="/reset">
      <button type="submit">Reset state</button>
    </form>
  `;
  return c.html(page('engine demo', body));
});

app.post('/reset', (c) => {
  state = createState();
  return c.redirect('/');
});

// ── PLATAFORMA HOME ─────────────────────────────────────────────────────────
app.get('/p/:slug', async (c) => {
  const slug = c.req.param('slug');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma)
    return c.html(errorPage('plataforma', `Plataforma ${slug} nao encontrada.`), 404);

  // list users on this plataforma
  const usuariosTodos = [
    ...(
      state.usuarioRepository as unknown as {
        usuarios: Map<
          string,
          { id: string; idPlataforma: string; email: string; nomeExibicao: string }
        >;
      }
    ).usuarios.values(),
  ];
  const usuariosDaPlataforma = usuariosTodos.filter((u) => u.idPlataforma === plataforma.id);

  // list campanhas on this plataforma
  const campanhasDaPlataforma = await state.campanhaRepository.findByPlataforma(plataforma.id);

  const body = `
    <p><strong>Plataforma:</strong> ${escapeHtml(plataforma.nome)} — <code>${escapeHtml(plataforma.slug)}</code></p>

    <h2>Admin — usuarios</h2>
    <ul>
      ${
        usuariosDaPlataforma
          .map(
            (u) =>
              `<li>${escapeHtml(u.nomeExibicao)} — ${escapeHtml(u.email)} (id: <code>${escapeHtml(u.id)}</code>)</li>`,
          )
          .join('') || '<li><em>(nenhum)</em></li>'
      }
    </ul>
    <h3>Criar usuario</h3>
    <form method="post" action="/p/${escapeHtml(slug)}/usuarios">
      <label>Nome de exibição: <input name="nomeExibicao" required /></label><br />
      <label>Email: <input name="email" type="email" required /></label><br />
      <label>Senha simulada: <input name="senhaSimulada" required /></label><br />
      <button type="submit">Criar usuario</button>
    </form>

    <h2>Admin — campanhas</h2>
    <ul>
      ${
        campanhasDaPlataforma
          .map(
            (camp) => `<li>
              <strong>${escapeHtml(camp.titulo)}</strong> (id: <code>${escapeHtml(camp.id)}</code>)
              <ul>
                <li><a href="/p/${escapeHtml(slug)}/admin/campanhas/${escapeHtml(camp.id)}">administrar</a></li>
                <li><a href="/p/${escapeHtml(slug)}/loja/${escapeHtml(camp.id)}">loja (contribuinte)</a></li>
                <li><a href="/p/${escapeHtml(slug)}/status/${escapeHtml(camp.id)}">status</a></li>
                <li><a href="/p/${escapeHtml(slug)}/financeiro/${escapeHtml(camp.id)}">financeiro</a></li>
              </ul>
            </li>`,
          )
          .join('') || '<li><em>(nenhuma)</em></li>'
      }
    </ul>
    <p><a href="/p/${escapeHtml(slug)}/admin/campanhas/new">+ criar nova campanha</a></p>
  `;
  return c.html(page(`plataforma — ${plataforma.nome}`, body));
});

// ── ADMIN: CREATE USER ─────────────────────────────────────────────────────
app.post('/p/:slug/usuarios', async (c) => {
  const slug = c.req.param('slug');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma) return c.html(errorPage('usuario', `Plataforma ${slug} nao encontrada.`), 404);

  const form = await c.req.parseBody();
  try {
    await registrarContaUsuario(
      {
        usuarioRepository: state.usuarioRepository,
        plataformaRepository: state.plataformaRepository,
        authService: state.authService,
        clock,
        observability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: plataforma.id,
        idConta: randomUUID(),
        email: String(form.email ?? ''),
        nomeExibicao: String(form.nomeExibicao ?? ''),
        senhaSimulada: String(form.senhaSimulada ?? ''),
      },
    );
    return c.redirect(`/p/${slug}`);
  } catch (err) {
    return c.html(errorPage('criar usuario', (err as Error).message), 400);
  }
});

// ── ADMIN: NEW CAMPANHA FORM ───────────────────────────────────────────────
app.get('/p/:slug/admin/campanhas/new', async (c) => {
  const slug = c.req.param('slug');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma) return c.html(errorPage('campanha', `Plataforma ${slug} nao encontrada.`), 404);

  const usuariosTodos = [
    ...(
      state.usuarioRepository as unknown as {
        usuarios: Map<
          string,
          { id: string; idConta: string; idPlataforma: string; email: string; nomeExibicao: string }
        >;
      }
    ).usuarios.values(),
  ];
  const usuariosDaPlataforma = usuariosTodos.filter((u) => u.idPlataforma === plataforma.id);
  if (usuariosDaPlataforma.length === 0) {
    return c.html(
      errorPage('campanha', `Nenhum usuario na plataforma ${slug}. Crie um usuario primeiro.`),
      400,
    );
  }

  const body = `
    <form method="post" action="/p/${escapeHtml(slug)}/admin/campanhas">
      <label>Título: <input name="titulo" required /></label><br />
      <label>Administrador:
        <select name="idConta" required>
          ${usuariosDaPlataforma
            .map(
              (u) =>
                `<option value="${escapeHtml(u.idConta)}">${escapeHtml(u.nomeExibicao)} (${escapeHtml(u.email)})</option>`,
            )
            .join('')}
        </select>
      </label><br />
      <fieldset>
        <legend>Recebedor (PIX)</legend>
        <label>Nome titular: <input name="recebedorNomeTitular" required /></label><br />
        <label>Tipo chave PIX:
          <select name="recebedorTipoChavePix" required>
            <option value="email">email</option>
            <option value="cpf">cpf</option>
            <option value="cnpj">cnpj</option>
            <option value="telefone">telefone</option>
            <option value="aleatoria">aleatoria</option>
          </select>
        </label><br />
        <label>Chave PIX: <input name="recebedorChavePix" required /></label><br />
      </fieldset>
      <button type="submit">Criar campanha</button>
    </form>
  `;
  return c.html(page('criar campanha', body));
});

app.post('/p/:slug/admin/campanhas', async (c) => {
  const slug = c.req.param('slug');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma) return c.html(errorPage('campanha', `Plataforma ${slug} nao encontrada.`), 404);

  const form = await c.req.parseBody();
  const idCampanha = randomUUID();
  try {
    await criarCampanha(
      {
        campanhaRepository: state.campanhaRepository,
        recebedorRepository: state.recebedorRepository,
        plataformaRepository: state.plataformaRepository,
        clock,
        observability,
      },
      {
        id: idCampanha,
        idPlataforma: plataforma.id,
        idsAdministradores: [String(form.idConta ?? '')],
        dadosRecebedor: {
          nomeTitular: String(form.recebedorNomeTitular ?? ''),
          tipoChavePix: String(form.recebedorTipoChavePix ?? '') as
            | 'cpf'
            | 'cnpj'
            | 'email'
            | 'telefone'
            | 'aleatoria',
          chavePix: String(form.recebedorChavePix ?? ''),
        },
        titulo: String(form.titulo ?? ''),
      },
    );
    return c.redirect(`/p/${slug}/admin/campanhas/${idCampanha}`);
  } catch (err) {
    return c.html(errorPage('criar campanha', (err as Error).message), 400);
  }
});

// ── ADMIN: CAMPANHA DETAIL (opções + contribuições) ────────────────────────
app.get('/p/:slug/admin/campanhas/:idCampanha', async (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma) return c.html(errorPage('campanha', `Plataforma ${slug} nao encontrada.`), 404);

  const campanha = await state.campanhaRepository.findById(idCampanha);
  if (!campanha)
    return c.html(errorPage('campanha', `Campanha ${idCampanha} nao encontrada.`), 404);

  const contribuicoes = await state.contribuicaoRepository.findByCampanhaId(idCampanha);

  const body = `
    <p><strong>Título:</strong> ${escapeHtml(campanha.titulo)}</p>
    <p><strong>Recebedor:</strong> ${
      campanha.dadosRecebedor
        ? `${escapeHtml(campanha.dadosRecebedor.nomeTitular)} — ${escapeHtml(campanha.dadosRecebedor.tipoChavePix)}: ${escapeHtml(campanha.dadosRecebedor.chavePix)}`
        : '<em>nao cadastrado</em>'
    }</p>

    <h2>Opções (sacolas)</h2>
    <ul>
      ${
        campanha.opcoes
          .map(
            (o) =>
              `<li><strong>${escapeHtml(o.tipo)}</strong> (id: <code>${escapeHtml(o.id)}</code>)</li>`,
          )
          .join('') || '<li><em>(nenhuma)</em></li>'
      }
    </ul>
    <h3>Adicionar opção</h3>
    <form method="post" action="/p/${escapeHtml(slug)}/admin/campanhas/${escapeHtml(idCampanha)}/opcoes">
      <label>Tipo:
        <select name="tipo" required>
          <option value="presente">presente</option>
          <option value="rifa">rifa</option>
          <option value="convite">convite</option>
        </select>
      </label>
      <button type="submit">Adicionar opção</button>
    </form>

    <h2>Contribuições</h2>
    <ul>
      ${
        contribuicoes
          .map(
            (ct) => `<li>
              ${ct.imagemUrl ? `<img src="${escapeHtml(ct.imagemUrl)}" alt="" height="40" style="vertical-align:middle; margin-right:6px" /> ` : ''}
              <strong>${escapeHtml(ct.nome)}</strong> — ${formatCents(ct.valor)} —
              <em>${escapeHtml(ct.status)}</em>
              ${ct.grupo ? ` <span style="background:#eef; padding:1px 4px; border-radius:3px">grupo: ${escapeHtml(ct.grupo)}</span>` : ''}
              ${ct.contribuinte ? ` — contribuinte: ${escapeHtml(ct.contribuinte.nome)} &lt;${escapeHtml(ct.contribuinte.email)}&gt;` : ''}
              (id: <code>${escapeHtml(ct.id)}</code>)
            </li>`,
          )
          .join('') || '<li><em>(nenhuma)</em></li>'
      }
    </ul>
    ${
      campanha.opcoes.length > 0
        ? `<h3>Adicionar contribuição</h3>
    <form method="post" action="/p/${escapeHtml(slug)}/admin/campanhas/${escapeHtml(idCampanha)}/contribuicoes">
      <label>Nome: <input name="nome" required /></label><br />
      <label>Valor (em centavos): <input name="valor" type="number" min="1" required /></label><br />
      <label>URL da imagem (opcional): <input name="imagemUrl" type="url" placeholder="https://..." /></label><br />
      <label>Grupo (opcional, ex: "vestuário"): <input name="grupo" maxlength="60" placeholder="vestuário, alimentação..." /></label><br />
      <label>Opção:
        <select name="idOpcaoContribuicao" required>
          ${campanha.opcoes
            .map(
              (o) =>
                `<option value="${escapeHtml(o.id)}">${escapeHtml(o.tipo)} — ${escapeHtml(o.id)}</option>`,
            )
            .join('')}
        </select>
      </label><br />
      <button type="submit">Criar contribuição</button>
    </form>`
        : '<p><em>Adicione uma opção antes de criar contribuições.</em></p>'
    }
  `;
  return c.html(page(`admin — ${campanha.titulo}`, body));
});

app.post('/p/:slug/admin/campanhas/:idCampanha/opcoes', async (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  const form = await c.req.parseBody();
  try {
    await adicionarOpcaoContribuicao(
      { campanhaRepository: state.campanhaRepository, observability },
      {
        idCampanha,
        idOpcao: randomUUID(),
        tipo: String(form.tipo ?? '') as 'presente' | 'rifa' | 'convite',
      },
    );
    return c.redirect(`/p/${slug}/admin/campanhas/${idCampanha}`);
  } catch (err) {
    return c.html(errorPage('adicionar opção', (err as Error).message), 400);
  }
});

app.post('/p/:slug/admin/campanhas/:idCampanha/contribuicoes', async (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  const form = await c.req.parseBody();
  const imagemUrlRaw = String(form.imagemUrl ?? '').trim();
  const grupoRaw = String(form.grupo ?? '').trim();
  try {
    await criarContribuicao(
      {
        campanhaRepository: state.campanhaRepository,
        contribuicaoRepository: state.contribuicaoRepository,
        clock,
        observability,
      },
      {
        id: randomUUID(),
        idCampanha,
        idOpcaoContribuicao: String(form.idOpcaoContribuicao ?? ''),
        nome: String(form.nome ?? ''),
        valor: Number(form.valor ?? 0),
        imagemUrl: imagemUrlRaw === '' ? null : imagemUrlRaw,
        grupo: grupoRaw === '' ? null : grupoRaw,
      },
    );
    return c.redirect(`/p/${slug}/admin/campanhas/${idCampanha}`);
  } catch (err) {
    return c.html(errorPage('criar contribuição', (err as Error).message), 400);
  }
});

// ── LOJA (contribuinte): see + pay ─────────────────────────────────────────
//
// Filter + paginate + collapse identical items. With a real gift-registry
// campanha we can easily have ~5k contribuições (e.g. 100 distinct items ×
// up to 99 slots each). Three UI strategies handle that without changing
// the engine:
//
//   1. Filter by grupo and "apenas disponíveis" — defaults to disponíveis only.
//   2. Collapse identical items (nome+valor+imagemUrl+grupo) into a single
//      card with "X de Y disponíveis", so 99 "Fralda" rows render as 1 card.
//   3. Paginate the collapsed cards (LOJA_PAGE_SIZE per opção).
//
// The DTO from `obterContribuicoesPrecalculadasCampanha` still returns the
// full set — pagination is a presentation choice, not an engine boundary.
app.get('/p/:slug/loja/:idCampanha', async (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma) return c.html(errorPage('loja', `Plataforma ${slug} nao encontrada.`), 404);

  const filters: LojaFilters = {
    grupoFiltro: c.req.query('grupo') ?? '',
    incluirIndisponiveis: c.req.query('incluir_indisponiveis') === '1',
    page: parseLojaPage(c.req.query('page')),
  };

  try {
    const dto = await obterContribuicoesPrecalculadasCampanha(
      {
        campanhaRepository: state.campanhaRepository,
        contribuicaoRepository: state.contribuicaoRepository,
        provedorRegraTaxa: state.provedorRegraTaxa,
        observability,
      },
      { idPlataforma: plataforma.id, idCampanha },
    );

    const buildQuery = makeBuildQuery(filters);
    const { grupos, temUngrouped } = collectGruposDistintos(dto.opcoes);
    const filterFormHtml = renderFilterFormHtml(slug, idCampanha, grupos, temUngrouped, filters);
    const opcoesHtml = dto.opcoes
      .map((o) => renderLojaOpcao(o, filters, slug, idCampanha, buildQuery))
      .join('');

    const body = `
      <p><strong>Campanha:</strong> ${escapeHtml(dto.tituloCampanha)}</p>
      ${filterFormHtml}
      ${opcoesHtml}
    `;
    return c.html(page(`loja — ${dto.tituloCampanha}`, body));
  } catch (err) {
    return c.html(errorPage('loja', (err as Error).message), 400);
  }
});

app.get('/p/:slug/loja/:idCampanha/checkout/:idContribuicao', async (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  const idContribuicao = c.req.param('idContribuicao');
  const body = `
    <p>Confirme seus dados e o pagamento será aprovado automaticamente (provider fake).</p>
    <form method="post" action="/p/${escapeHtml(slug)}/loja/${escapeHtml(idCampanha)}/checkout/${escapeHtml(idContribuicao)}">
      <label>Seu nome: <input name="nome" required /></label><br />
      <label>Seu email: <input name="email" type="email" required /></label><br />
      <label>Método:
        <select name="metodo" required>
          <option value="pix">pix</option>
          <option value="cartao_credito">cartao_credito</option>
        </select>
      </label><br />
      <button type="submit">Pagar</button>
    </form>
  `;
  return c.html(page('checkout', body));
});

app.post('/p/:slug/loja/:idCampanha/checkout/:idContribuicao', async (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  const idContribuicao = c.req.param('idContribuicao');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma) return c.html(errorPage('checkout', `Plataforma ${slug} nao encontrada.`), 404);

  const form = await c.req.parseBody();
  const idPagamento = randomUUID();

  try {
    // Phase 2: saga — claim + create pendente pagamento
    await iniciarPagamentoContribuicao(
      {
        campanhaRepository: state.campanhaRepository,
        contribuicaoRepository: state.contribuicaoRepository,
        provedorRegraTaxa: state.provedorRegraTaxa,
        pagamentoRepository: state.pagamentoRepository,
        pagamentoEventPublisher: state.pagamentoEventPublisher,
        clock,
        observability,
      },
      {
        idPlataforma: plataforma.id,
        idCampanha,
        idContribuicao,
        contribuinte: {
          nome: String(form.nome ?? ''),
          email: String(form.email ?? ''),
        },
        metodo: String(form.metodo ?? 'pix') as 'pix' | 'cartao_credito',
        idPagamento,
        idIntencaoPagamento: randomUUID(),
      },
    );

    // Phase 3: process manager — provider returns aprovado, register Financeiro
    const { pagamento, lancamentos } = await finalizarPagamentoAprovado(
      {
        pagamentoRepository: state.pagamentoRepository,
        pagamentoProvider: state.pagamentoProvider,
        pagamentoEventPublisher: state.pagamentoEventPublisher,
        contribuicaoRepository: state.contribuicaoRepository,
        campanhaRepository: state.campanhaRepository,
        livroFinanceiroRepository: state.livroFinanceiroRepository,
        clock,
        observability,
      },
      { idPagamento },
    );

    const body = `
      <p style="color:#070"><strong>Pagamento aprovado!</strong></p>
      <p>idPagamento: <code>${escapeHtml(pagamento.id)}</code></p>
      <p>Total pago: <strong>${formatCents(pagamento.intencao.amountCents)}</strong></p>
      <p>Lancamentos criados em Financeiro: ${lancamentos.length}</p>
      <ul>
        <li><a href="/p/${escapeHtml(slug)}/loja/${escapeHtml(idCampanha)}">voltar à loja</a></li>
        <li><a href="/p/${escapeHtml(slug)}/status/${escapeHtml(idCampanha)}">ver status</a></li>
        <li><a href="/p/${escapeHtml(slug)}/financeiro/${escapeHtml(idCampanha)}">ver financeiro</a></li>
      </ul>
    `;
    return c.html(page('pagamento aprovado', body));
  } catch (err) {
    return c.html(errorPage('checkout', (err as Error).message), 400);
  }
});

// ── STATUS: contribuições + pagamentos ─────────────────────────────────────
app.get('/p/:slug/status/:idCampanha', async (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma) return c.html(errorPage('status', `Plataforma ${slug} nao encontrada.`), 404);

  const campanha = await state.campanhaRepository.findById(idCampanha);
  if (!campanha) return c.html(errorPage('status', `Campanha ${idCampanha} nao encontrada.`), 404);

  const contribuicoes = await state.contribuicaoRepository.findByCampanhaId(idCampanha);

  // dig the pagamento repository's internal map to list pagamentos for this campanha
  const pagamentosTodos = [
    ...(
      state.pagamentoRepository as unknown as {
        pagamentos: Map<
          string,
          {
            id: string;
            status: string;
            intencao: { idContribuicao: string; amountCents: number; metodo: string };
          }
        >;
      }
    ).pagamentos.values(),
  ];
  const idsContribuicaoDaCampanha = new Set(contribuicoes.map((ct) => ct.id));
  const pagamentosDaCampanha = pagamentosTodos.filter((p) =>
    idsContribuicaoDaCampanha.has(p.intencao.idContribuicao),
  );

  const body = `
    <p><strong>Campanha:</strong> ${escapeHtml(campanha.titulo)}</p>

    <h2>Contribuições</h2>
    <table border="1" cellpadding="4" cellspacing="0">
      <thead>
        <tr><th>nome</th><th>valor</th><th>status</th><th>contribuinte</th></tr>
      </thead>
      <tbody>
        ${
          contribuicoes
            .map(
              (ct) => `<tr>
                <td>${escapeHtml(ct.nome)}</td>
                <td>${formatCents(ct.valor)}</td>
                <td>${escapeHtml(ct.status)}</td>
                <td>${ct.contribuinte ? `${escapeHtml(ct.contribuinte.nome)} &lt;${escapeHtml(ct.contribuinte.email)}&gt;` : '—'}</td>
              </tr>`,
            )
            .join('') || '<tr><td colspan="4"><em>(nenhuma)</em></td></tr>'
        }
      </tbody>
    </table>

    <h2>Pagamentos</h2>
    <table border="1" cellpadding="4" cellspacing="0">
      <thead>
        <tr><th>idContribuicao</th><th>amount</th><th>metodo</th><th>status</th></tr>
      </thead>
      <tbody>
        ${
          pagamentosDaCampanha
            .map(
              (p) => `<tr>
                <td><code>${escapeHtml(p.intencao.idContribuicao)}</code></td>
                <td>${formatCents(p.intencao.amountCents)}</td>
                <td>${escapeHtml(p.intencao.metodo)}</td>
                <td>${escapeHtml(p.status)}</td>
              </tr>`,
            )
            .join('') || '<tr><td colspan="4"><em>(nenhum)</em></td></tr>'
        }
      </tbody>
    </table>
  `;
  return c.html(page(`status — ${campanha.titulo}`, body));
});

// ── FINANCEIRO: saldo + receita + repasse ──────────────────────────────────
app.get('/p/:slug/financeiro/:idCampanha', async (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma)
    return c.html(errorPage('financeiro', `Plataforma ${slug} nao encontrada.`), 404);

  const campanha = await state.campanhaRepository.findById(idCampanha);
  if (!campanha)
    return c.html(errorPage('financeiro', `Campanha ${idCampanha} nao encontrada.`), 404);

  const lancamentos = await state.livroFinanceiroRepository.findLancamentosByIdCampanha(idCampanha);

  const lancRecebedor = lancamentos.filter((l) => l.tipo === 'credito_saldo_recebedor');
  const lancReceita = lancamentos.filter((l) => l.tipo === 'credito_receita_plataforma');
  const saldoPendente = lancRecebedor
    .filter((l) => l.status === 'pendente')
    .reduce((s, l) => s + l.amountCents, 0);
  const saldoDisponivel = lancRecebedor
    .filter((l) => l.status === 'disponivel')
    .reduce((s, l) => s + l.amountCents, 0);
  const receitaTotal = lancReceita.reduce((s, l) => s + l.amountCents, 0);

  const repasses = await state.livroFinanceiroRepository.findRepassesByIdCampanha(idCampanha);

  const body = `
    <p><strong>Campanha:</strong> ${escapeHtml(campanha.titulo)}</p>

    <h2>Saldo do recebedor</h2>
    <ul>
      <li>Pendente: <strong>${formatCents(saldoPendente)}</strong></li>
      <li>Disponível: <strong>${formatCents(saldoDisponivel)}</strong></li>
    </ul>

    <h2>Receita da plataforma (todas as taxas dessa campanha)</h2>
    <p><strong>${formatCents(receitaTotal)}</strong></p>

    <h2>Lancamentos</h2>
    <table border="1" cellpadding="4" cellspacing="0">
      <thead>
        <tr><th>tipo</th><th>amount</th><th>status</th><th>idPagamento</th></tr>
      </thead>
      <tbody>
        ${
          lancamentos
            .map(
              (l) => `<tr>
                <td>${escapeHtml(l.tipo)}</td>
                <td>${formatCents(l.amountCents)}</td>
                <td>${escapeHtml(l.status)}</td>
                <td><code>${escapeHtml(l.idPagamento)}</code></td>
              </tr>`,
            )
            .join('') || '<tr><td colspan="4"><em>(nenhum)</em></td></tr>'
        }
      </tbody>
    </table>

    <h3>DEMO: maturar lancamentos pendentes</h3>
    <p style="color:#777">
      Em produção, lancamentos maturariam por regra de negócio (e.g. D+30 depois do pagamento).
      Para testar o repasse, este botão flipa <em>pendente → disponível</em> manualmente.
    </p>
    <form method="post" action="/p/${escapeHtml(slug)}/financeiro/${escapeHtml(idCampanha)}/mature">
      <button type="submit">Maturar pendentes</button>
    </form>

    <h2>Solicitar repasse</h2>
    <form method="post" action="/p/${escapeHtml(slug)}/financeiro/${escapeHtml(idCampanha)}/repasses">
      <label>Valor (centavos): <input name="amountCents" type="number" min="1" required /></label>
      <button type="submit">Solicitar repasse</button>
    </form>

    <h2>Repasses solicitados</h2>
    <table border="1" cellpadding="4" cellspacing="0">
      <thead>
        <tr><th>id</th><th>amount</th><th>status</th></tr>
      </thead>
      <tbody>
        ${
          repasses
            .map(
              (r) => `<tr>
                <td><code>${escapeHtml(r.id)}</code></td>
                <td>${formatCents(r.amountCents)}</td>
                <td>${escapeHtml(r.status)}</td>
              </tr>`,
            )
            .join('') || '<tr><td colspan="3"><em>(nenhum)</em></td></tr>'
        }
      </tbody>
    </table>
  `;
  return c.html(page(`financeiro — ${campanha.titulo}`, body));
});

app.post('/p/:slug/financeiro/:idCampanha/mature', (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  matureLancamentosForCampanha(idCampanha);
  return c.redirect(`/p/${slug}/financeiro/${idCampanha}`);
});

app.post('/p/:slug/financeiro/:idCampanha/repasses', async (c) => {
  const slug = c.req.param('slug');
  const idCampanha = c.req.param('idCampanha');
  const plataforma = await state.plataformaRepository.findBySlug(slug);
  if (!plataforma) return c.html(errorPage('repasse', `Plataforma ${slug} nao encontrada.`), 404);

  const form = await c.req.parseBody();
  try {
    await iniciarRepasseRecebedor(
      {
        campanhaRepository: state.campanhaRepository,
        recebedorRepository: state.recebedorRepository,
        livroFinanceiroRepository: state.livroFinanceiroRepository,
        clock,
        observability,
      },
      {
        idPlataforma: plataforma.id,
        idCampanha,
        idRepasse: randomUUID(),
        amountCents: Number(form.amountCents ?? 0),
      },
    );
    return c.redirect(`/p/${slug}/financeiro/${idCampanha}`);
  } catch (err) {
    return c.html(errorPage('solicitar repasse', (err as Error).message), 400);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port: PORT });
const address = server.address();
const portAtual = address && typeof address !== 'string' ? address.port : PORT;

console.log('');
console.log('🌐 Frame engine demo — interactive web');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`✅ Listening on http://127.0.0.1:${portAtual}`);
console.log('');
console.log('Plataformas seed: eunenem + eucasei');
console.log('State: in-memory; Ctrl-C ou Reset no UI para zerar.');
console.log('');
