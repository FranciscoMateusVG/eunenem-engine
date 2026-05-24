# Plan 0002 — HTML streaming

> **Status**: 📝 deferido. Revisitar quando alguma página passar a depender de dado **lento** (DB query séria, fanout de API externa, qualquer coisa > ~100ms no servidor) ou quando TTFB virar métrica que importa (SEO sério, Core Web Vitals).
>
> **Interage com**: [`0001-code-splitting.md`](./0001-code-splitting.md). As duas coisas juntas (streaming + split por rota) são o que frameworks como Next/Remix realmente automatizam. Se for fazer uma, vale considerar a outra.

## Como funciona hoje

`server.tsx`:

```tsx
const ssrHtml = renderToString(<App pathname={url.pathname} />);
return c.html(envelope(ssrHtml, url.pathname));
```

`renderToString` é **síncrono e atômico**: bloqueia até a árvore inteira renderizar, devolve uma string, você envia. Se qualquer pedaço da árvore tentar buscar dado assincronamente (via `use(promise)` ou `await` num componente async), `renderToString` **errora**. Não dá pra esperar.

Consequências:

- TTFB = tempo total de render. Se uma página leva 1500ms pra montar, o primeiro byte sai aos 1500ms.
- Não dá pra renderizar partes lentas e partes rápidas em paralelo.
- Não dá pra mostrar skeleton + preencher depois.

Pra 3 páginas estáticas como temos hoje, isso é **bom** — síncrono é mais simples, debugável, previsível.

## O que muda com streaming

Trocamos por `renderToPipeableStream` (Node) ou `renderToReadableStream` (Web Streams / edge):

```tsx
const { pipe } = renderToPipeableStream(<App pathname={pathname} />, {
  onShellReady() {
    // primeiro byte sai aqui, com <head> + esqueleto
    pipe(response);
  },
  onAllReady() {
    // disparado quando até Suspense'd content tá pronto (opcional)
  },
  onError(err) { /* ... */ },
  bootstrapModules: ['/public/client.js'],
});
```

Servidor envia bytes **conforme renderiza**, em chunks. Conteúdo dentro de `<Suspense>` boundaries pode ser streamado **fora de ordem**: o fallback aparece, e quando o conteúdo real fica pronto, React injeta um pequeno `<script>` que troca o fallback pelo conteúdo, **sem JS de aplicação rodar ainda**.

## Por que importa — exemplo concreto

Imagina uma página `/loja/:id`:

| Seção                        | Tempo de render |
| ---------------------------- | --------------- |
| Header + nav                 | instantâneo     |
| Detalhes da campanha (DB)    | 200ms           |
| Lista de contribuições (DB)  | 400ms           |
| Recomendações (API externa)  | 1500ms          |

**Com `renderToString`**: servidor espera os 1500ms, manda tudo. Primeiro byte aos 1500ms, paint aos ~1550ms.

**Com streaming + Suspense**:

- 0ms: navegador recebe `<head>`, header, skeletons. **Pinta imediatamente.**
- 200ms: detalhes streamados, swap de skeleton.
- 400ms: lista streamada.
- 1500ms: recomendações streamadas.

Diferença de UX: 1500ms vs ~50ms até o usuário ver algo útil. Lighthouse adora.

## A conexão com Suspense

Streaming só compensa se você marcar o que é lento com `<Suspense>`. O padrão:

```tsx
<Layout>
  <Header />
  <Suspense fallback={<DetalhesSkeleton />}>
    <DetalhesCampanha id={id} />
  </Suspense>
  <Suspense fallback={<ListaSkeleton />}>
    <ListaContribuicoes idCampanha={id} />
  </Suspense>
  <Suspense fallback={<RecomendacoesSkeleton />}>
    <Recomendacoes />
  </Suspense>
</Layout>
```

Cada componente "suspenso" busca seu dado:

```tsx
function DetalhesCampanha({ id }: { id: string }) {
  const campanha = use(fetchCampanha(id));  // joga uma promise; Suspense pega
  return <h1>{campanha.titulo}</h1>;
}
```

**Crítico**: `fetchCampanha(id)` precisa ser memoizado por request — se cada render recriar a promise, vira loop infinito. React 19 tem `cache()` pra isso. Frameworks (Next, Remix) automatizam essa parte; sem framework, você gerencia o cache manualmente (por request, num WeakMap ou similar).

## Implementação — mudanças concretas neste app

**1. `server.tsx`** — trocar `renderToString` por `renderToPipeableStream` + bridge pro Hono:

```tsx
import { renderToPipeableStream } from 'react-dom/server';
import { PassThrough } from 'node:stream';

app.get('*', (c) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  // 404 PRECISA ser decidido aqui — depois do shell flush não dá pra mudar status
  const isKnownRoute = pathname === '/' || pathname === '/contador';
  const status = isKnownRoute ? 200 : 404;

  return new Promise<Response>((resolve, reject) => {
    const passthrough = new PassThrough();
    let didError = false;

    const { pipe, abort } = renderToPipeableStream(
      <StrictMode><App pathname={pathname} /></StrictMode>,
      {
        bootstrapModules: ['/public/client.js'],
        onShellReady() {
          // escreve o prelude (tudo antes do conteúdo da app)
          passthrough.write(htmlPrelude(pathname));
          pipe(passthrough);
          // o fechamento (</div></body></html>) vai automaticamente quando a stream do React fechar
          resolve(c.body(passthrough as any, status, {
            'content-type': 'text/html; charset=utf-8',
          }));
        },
        onShellError(err) {
          didError = true;
          reject(err);
        },
        onError(err) {
          didError = true;
          console.error('SSR streaming error', err);
        },
      },
    );

    // safety net — se demorar muito, aborta
    setTimeout(() => { if (!didError) abort(); }, 10_000);
  });
});

function htmlPrelude(pathname: string): string {
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>eunenem · ${escapeHtml(pathname)}</title><link rel="stylesheet" href="/public/styles.css"/></head><body><div id="root">`;
}
```

Notar:

- O "envelope" arrumadinho de hoje vira "prelude string + stream do React + fechamento automático".
- `bootstrapModules` faz o React emitir o `<script type="module">` automaticamente no lugar certo.
- Status code é decidido **antes** do shell flush.

**2. `client.tsx`** — **nenhuma mudança**. `hydrateRoot` funciona idêntico contra DOM streamado ou contra DOM completo.

**3. Páginas com dados lentos** — refatorar pra usar `<Suspense>` + `use()`:

```tsx
import { cache, Suspense, use } from 'react';

// cache global por request (cuidado: precisa ser per-request em prod, não global!)
const fetchCampanha = cache(async (id: string) => {
  // chamada real ao engine aqui
  return await campanhaRepository.findById(id);
});

export function LojaPage({ id }: { id: string }) {
  return (
    <>
      <Suspense fallback={<div>carregando…</div>}>
        <DetalhesCampanha id={id} />
      </Suspense>
    </>
  );
}

function DetalhesCampanha({ id }: { id: string }) {
  const campanha = use(fetchCampanha(id));
  return <h1>{campanha.titulo}</h1>;
}
```

## A parte difícil — onde a complexidade real mora

1. **Status code antes do shell flush.** Hoje `server.tsx` decide 404 *depois* de renderizar. Com streaming, decisão precisa migrar pra antes. Pra rotas dinâmicas (`/loja/:id` onde `id` pode não existir), isso vira "fetch existência primeiro, depois renderizar" — adiciona uma roundtrip. Frameworks resolvem com `notFound()` dentro de boundaries especiais, mas hand-rolled você lida na unha.

2. **Erro depois do shell flush é não-recuperável.** Antes do flush: pode mandar 500 page. Depois: já comprometeu com 200 OK + bytes parciais. Tem que mostrar erro inline ou cortar a resposta. React 19 melhorou error boundaries com streaming mas continua sendo modelo mental diferente.

3. **Mudança no padrão de data fetching.** Hoje seria `const data = await fetch(...)` lá em cima passando como prop. Com streaming, vira "promise-as-value + Suspense" — perto do padrão React Query / TanStack Query. Não é difícil mas exige reprogramar como você pensa data fetching.

4. **Bridge Hono ↔ React stream.** `@hono/node-server` quer um `Readable` do Node. `renderToPipeableStream` te dá uma API com callbacks. A ponte (PassThrough acima) funciona mas é boilerplate. `renderToReadableStream` (variante Web Streams) é mais limpa pra edge runtimes (Cloudflare Workers, Deno Deploy) mas o Node nativo ainda quer Node streams.

5. **CDNs e proxies podem furar o streaming.** Alguns CDNs/proxies bufferizam respostas inteiras antes de mandar pro cliente, anulando o ganho. Outros têm thresholds baixos de flush. Você descobre na produção, sendo confundido. Cloudflare e Vercel suportam bem; alguns provedores legacy não.

6. **Preload de assets fica crítico.** Enquanto o body streama, você quer que CSS e o bundle JS do cliente cheguem em paralelo. `bootstrapModules` resolve o JS; CSS precisa de `<link rel="preload">` no prelude. Se esquecer, o conteúdo streama mas fica sem estilo até o CSS chegar — pior UX que sem streaming.

7. **Cache de promise por request.** O `cache()` do React 19 funciona, mas globalmente. Se você cachear globalmente, requests diferentes compartilham dado — bug de segurança. Frameworks isolam via async context (`AsyncLocalStorage` no Node). Hand-rolled, você precisa montar essa isolação. Não é difícil mas é fácil errar.

## Quando vale a pena

Mesmo critério do plan 0001, mas pra latência em vez de tamanho:

- **Todas as páginas renderizam em <50ms com dado síncrono**: skip. `renderToString` é mais simples.
- **Alguma página depende de DB/API que leva >200ms**: ganho real em UX.
- **TTFB virou métrica que monitorada (SEO, Core Web Vitals, conversão)**: vai compensar.
- **Páginas com fan-out heterogêneo** (algumas seções rápidas, outras lentas): caso perfeito pra streaming + Suspense.

Se você tá fazendo CRUD com queries simples (< 100ms), streaming é solução procurando problema.

## Esforço estimado

- **Setup básico (server.tsx refactor + bridge Hono)**: meio dia.
- **Refatorar uma página existente pra Suspense + use()**: 1-2 horas por página.
- **Coordenar com code-splitting (plan 0001)**: mais meio dia se você quiser as duas juntas. O manifesto de preload precisa saber sobre chunks streamados.
- **Debugar primeira issue de buffering em CDN**: 2-4 horas + um drink forte.

Total realista pra app de 3-5 rotas com 2 delas usando streaming: **1-2 dias de trabalho**. Não é trivial, não é proibitivo.

## Alternativas (se streaming parecer demais)

- **Não fazer SSR pras páginas lentas**: marca `/recomendacoes` (por exemplo) como client-only — servidor manda shell vazio, cliente busca. Perde SEO/primeiro paint daquela rota, mas evita toda a coordenação.

- **Fetch antes de render, com timeout agressivo**: roda os fetches em `Promise.all` antes do `renderToString`, com timeout de 200ms cada. O que não chegar em 200ms vira `null` e o componente renderiza skeleton. Pior UX que streaming mas dramaticamente mais simples.

- **Migrar pra framework**: Next + Remix resolvem streaming + Suspense + cache por request por padrão. Se você acabar precisando de streaming + code-split + RSC + tudo, talvez seja a hora de migrar. **Mas** não migra antecipadamente — migra quando a dor for real.

## Done definition

- `server.tsx` usa `renderToPipeableStream` no lugar de `renderToString`.
- Alguma página (ex: `/loja/:id`) tem `<Suspense>` boundaries e seções que streamam.
- DevTools Network tab mostra a resposta chegando em chunks (não em uma única transferência).
- Primeiro paint visivelmente mais rápido que antes em página com dado lento.
- Sem hydration mismatch warning no console.
- 404 ainda retorna status 404 corretamente.
- Erro em rota suspensa mostra fallback de erro elegantemente, não tela branca.
