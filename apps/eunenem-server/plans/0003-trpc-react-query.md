# Plan 0003 — tRPC + React Query (escolha de stack para mutações)

> **Status**: 📝 deferido. Decisão de stack tomada; implementação fica pra quando aparecer a primeira mutação real (provavelmente quando o engine for integrado e a primeira rota tipo `POST /api/campanhas` precisar existir).

## Decisão

Quando precisarmos de mutações tipadas e cache de dados no cliente, vamos usar **tRPC + TanStack Query** (a.k.a. React Query) — **não** vamos migrar pra Next.js Server Actions nem rolar nossa própria RPC complexa.

## Por que essa escolha

Critério principal: **transparência > magia**. Esse repo escolheu se afastar de frameworks black-box (sem Next, sem Vite, sem Vike) porque a clareza do mental model importa mais do que a brevidade da DX. tRPC + React Query honra essa filosofia:

- **tRPC** runtime é fetch + JSON + Zod. Sem transformação de build, sem `'use server'` removendo código mágicamente do bundle, sem IDs de action gerados em tempo de build. A "magia" é puramente inferência TypeScript em tempo de compilação — autocomplete e tipos end-to-end. Em runtime: chamada HTTP comum.
- **React Query** é um cache map + invalidação de queries com hooks. Sem compiler tricks, sem global state mágico. Cmd+click chega no código real em qualquer lugar.

Comparado às alternativas:

| Opção | Transparência | DX | Veredito |
| --- | --- | --- | --- |
| **Hono POST routes + `fetch()` manual** | ✅ máxima | ❌ baixa (sem tipos, sem cache) | Bom pra 1-2 endpoints; não escala. |
| **Hand-roll RPC (Proxy + ActionMap)** | ✅ alta | ⚠️ média (sem validação, sem cache) | OK pra ~5 actions; vira tRPC mal feito além disso. |
| **tRPC + React Query** | ✅ alta | ✅ alta | **Escolha** — cobre 90% do que Server Actions oferecem, sem black box. |
| **Next.js Server Actions** | ❌ baixa (compiler magic, RSC, revalidation) | ✅ máxima | Rejeitado — anda contra a filosofia do app. |
| **Remix actions** | ⚠️ média (loaders/actions são conceito do framework) | ✅ alta | Rejeitado pelo mesmo motivo de não usar Next. |

## O que ganhamos

- **Tipos end-to-end**: cliente importa `AppRouter` do servidor; autocomplete e type-checking dos args e retornos.
- **Validação no boundary**: cada procedure tRPC tem schema Zod no input. Se chega lixo, erra antes de tocar lógica.
- **Cache + invalidação**: React Query gerencia "está fetchando", "stale, refetch em background", "errou, retry com backoff", "mutei X, invalidar tudo que depende".
- **Batching**: chamar 3 procedures em paralelo vira 1 request HTTP automaticamente.
- **Optimistic updates**: React Query suporta nativamente — UI atualiza antes da resposta do servidor; rollback se falhar.
- **Sem boilerplate de API route**: define a procedure, ela vira chamável no cliente. Sem escrever `app.post('/api/...')` separadamente.

## O que abrimos mão (vs Server Actions)

- **Form progressive enhancement**: `<form action={fn}>` do Next funciona sem JS. Com tRPC, mutações dependem de JS no cliente. *Workaround*: pra rotas que importam funcionar sem JS (raras), escrever um Hono POST handler tradicional ao lado da procedure tRPC. Tipicamente não importa.
- **Revalidação automática de página**: Next re-roda a árvore RSC + streama HTML novo após action. Com tRPC + React Query, você chama `queryClient.invalidateQueries(['campanhas'])` na callback `onSuccess` da mutation. Mais explícito; menos mágico.
- **Co-location absoluta**: Next deixa definir action no mesmo arquivo do componente. Com tRPC, procedures vivem em arquivos separados (organizados por router/feature). Diferença cosmética que vira *ganho* em apps grandes (procedures viram lugar canônico, não escondidas em componentes).

## Estrutura proposta (quando implementar)

```
apps/eunenem-server/
├── server/
│   ├── trpc/
│   │   ├── context.ts          # buildContext(req) — devolve { observability, db, usuarioId? }
│   │   ├── router.ts            # appRouter — combina routers por feature
│   │   ├── procedure.ts         # publicProcedure, protectedProcedure (auth wrapper)
│   │   └── routers/
│   │       ├── campanhas.router.ts
│   │       ├── contribuicoes.router.ts
│   │       └── ...
│   └── index.ts                  # monta tRPC handler em app.use('/trpc/*', ...)
├── client/
│   ├── trpc.ts                  # createTRPCReact<AppRouter>() — cliente tipado
│   └── providers.tsx            # QueryClientProvider + trpc.Provider
└── pages/
    └── ...                       # componentes usam useQuery / useMutation
```

## Implementação — passos

**1. Instalar**:

```bash
pnpm add @trpc/server @trpc/client @trpc/react-query @tanstack/react-query zod superjson
```

**2. Servidor — montar tRPC router**:

```ts
// server/trpc/procedure.ts
import { initTRPC } from '@trpc/server';
import superjson from 'superjson';

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;
```

```ts
// server/trpc/routers/campanhas.router.ts
import { z } from 'zod';
import { publicProcedure, router } from '../procedure.js';

export const campanhasRouter = router({
  listar: publicProcedure
    .input(z.object({ idPlataforma: z.string().uuid() }))
    .query(({ input, ctx }) => ctx.engine.listarCampanhasPorPlataforma(input.idPlataforma)),

  criar: publicProcedure
    .input(z.object({ titulo: z.string().min(1), idPlataforma: z.string().uuid() }))
    .mutation(({ input, ctx }) => ctx.engine.criarCampanha(input)),
});
```

```ts
// server/trpc/router.ts
import { router } from './procedure.js';
import { campanhasRouter } from './routers/campanhas.router.js';

export const appRouter = router({
  campanhas: campanhasRouter,
});

export type AppRouter = typeof appRouter;  // <-- exportar TIPO pro cliente
```

**3. Servidor — montar handler no Hono**:

```ts
// server.tsx
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './server/trpc/router.js';

app.use('/trpc/*', trpcServer({ router: appRouter, createContext: buildContext }));
```

**4. Cliente — providers**:

```tsx
// client/providers.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { useState } from 'react';
import { trpc } from './trpc.js';

export function Providers({ children }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [httpBatchLink({ url: '/trpc' })],
    }),
  );
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
```

**5. Cliente — uso em componente**:

```tsx
import { trpc } from '../client/trpc.js';

export function ListaCampanhasPage() {
  const { data, isLoading } = trpc.campanhas.listar.useQuery({ idPlataforma: 'plat-eunenem-uuid' });
  const utils = trpc.useUtils();
  const criar = trpc.campanhas.criar.useMutation({
    onSuccess: () => utils.campanhas.listar.invalidate(),
  });

  if (isLoading) return <div>carregando…</div>;
  return (
    <>
      <button onClick={() => criar.mutate({ titulo: 'Nova', idPlataforma: '...' })}>+ criar</button>
      <ul>{data?.map((c) => <li key={c.id}>{c.titulo}</li>)}</ul>
    </>
  );
}
```

Pronto. Tipo do retorno de `listar` inferido do servidor; `criar.mutate` valida input contra o Zod; sucesso invalida o cache da query.

## SSR com tRPC

`trpc.useQuery` no SSR retorna `isLoading: true` no primeiro render (sem dado), o que **quebra hidratação** se o cliente carregar dados diferentes do servidor. Soluções:

- **Prefetch no servidor** (`server.tsx`): antes de `renderToString`, chamar as procedures relevantes e popular o `QueryClient` com os resultados via `queryClient.setQueryData(...)`. Serializar o cache no envelope HTML (`<script id="__QUERY_STATE__">...</script>`). Cliente hidrata `QueryClient` a partir desse state. **Mais comum**.
- **Skip SSR pras queries**: marcar queries como `enabled: false` no SSR, deixar cliente fetchar após hidratação. **Mais simples, pior UX (flash de loading)**.
- **Migrar pra streaming SSR** (plano 0002): Suspense + `use()` numa procedure tRPC. Mais elegante mas requer 0002 estar implementado.

Decisão: começar com prefetch + cache hidratação (padrão `@tanstack/react-query` `dehydrate`/`HydrationBoundary`). Migrar pra streaming quando 0002 chegar.

## Quando vale implementar

- **Quando aparecer a 1ª mutação real**: provavelmente quando o engine for integrado e tiver formulários de admin (criar campanha, editar opção, etc.).
- **Quando começarem a aparecer 2+ chamadas de leitura repetidas em páginas diferentes**: o cache compartilhado do React Query elimina re-fetches desnecessários.

Antes disso (só leitura via SSR de dados imutáveis), tRPC é overkill.

## Esforço estimado

- **Setup inicial (router base + 1 procedure + provider no client + 1 useQuery)**: 2-3 horas.
- **Cada nova feature/router**: ~30 minutos pra montar router + tipos fluem sozinhos pro cliente.
- **SSR hydration de query state**: meio dia, primeira vez (padrão é bem documentado).
- **Migração pra streaming SSR depois (plano 0002)**: extra 2-4 horas pra trocar prefetch+hydration por Suspense+use().

## Done definition

- Pelo menos 1 router tRPC (`campanhasRouter` por exemplo) com query + mutation funcionando.
- Cliente componente faz `useQuery` e `useMutation` com tipos derivados.
- SSR pré-popula o cache da query antes da hidratação (sem flash de loading).
- Mutação invalida o cache correto via `utils.X.invalidate()`.
- Erros do servidor (validação Zod, erros lançados) chegam tipados no cliente.
