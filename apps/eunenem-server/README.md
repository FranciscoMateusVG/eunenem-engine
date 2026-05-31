# eunenem-server

Frontend da plataforma **eunenem**, servida por **Hono + React 19 SSR + esbuild + Tailwind 4**. Sem Vite, sem Next, sem framework. Vive em `apps/eunenem-server/` dentro do repo `engine`, isolado do gate de qualidade do engine (lint/tsc/depcruise escopados ao `src/`).

## Stack

- **Hono** + `@hono/node-server` — HTTP + roteamento + static assets.
- **React 19** — `renderToString` no servidor, `hydrateRoot` no cliente.
- **esbuild** — empacota só `client.tsx` em `public/client.js`.
- **Tailwind 4 CLI** — compila `tailwind.css` em `public/styles.css`.
- **concurrently** — roda os 3 processos (build do cliente, build do CSS, servidor) em paralelo.

## Como rodar

```bash
cd apps/eunenem-server
pnpm install
pnpm dev
```

Abre em http://localhost:3001.

### Scripts

| Script           | O que faz                                                                |
| ---------------- | ------------------------------------------------------------------------ |
| `pnpm dev`       | esbuild --watch + tailwind --watch + `tsx watch server.tsx` em paralelo. |
| `pnpm build`     | Builda `public/client.js` minificado + `public/styles.css` minificado.   |
| `pnpm start`     | Servidor em produção (assume `pnpm build` rodado antes).                 |
| `pnpm typecheck` | `tsc --noEmit`.                                                          |

## Como funciona

1. Requisição chega no Hono.
2. `/public/*` → `serveStatic` devolve o arquivo do disco.
3. Qualquer outra rota → `renderToString(<App pathname={url.pathname} />)` → envelope HTML com `<div id="root">${ssr}</div>` + `<script src="/public/client.js">`.
4. Cliente carrega `client.js`, chama `hydrateRoot()` com o mesmo `<App pathname={location.pathname} />` — React acopla os listeners.
5. Navegar entre `/` e `/contador` é full page nav (links HTML normais). Sem SPA router — se quiser depois, adiciona react-router ou hand-roll.

## Estrutura

```
apps/eunenem-server/
├── package.json
├── tsconfig.json
├── tailwind.css           # @import "tailwindcss" + @source para purge
├── build.mjs              # esbuild + tailwind, watch ou one-shot
├── server.tsx             # Hono + roteamento + envelope HTML
├── client.tsx             # hydrateRoot entry
├── pages/
│   ├── App.tsx            # roteamento por pathname (server + client)
│   ├── Layout.tsx         # header + footer + nav
│   ├── HomePage.tsx       # /
│   ├── ContadorPage.tsx   # /contador
│   └── NotFoundPage.tsx   # 404
└── public/                # gerado (gitignored): client.js, styles.css
```

## Isolamento do engine

| Ferramenta          | Escopo                                          | Toca em `apps/`? |
| ------------------- | ----------------------------------------------- | ---------------- |
| `tsc` (engine root) | `include: ["src"]`                              | ❌               |
| `eslint`            | `src|tests|examples|migrations|scripts`         | ❌               |
| `dependency-cruiser`| `src/`                                          | ❌               |
| `biome`             | `**` mas com `!apps/**`                         | ❌ (excluído)    |

Resultado: `pnpm check` do engine não vê este app. Alterações aqui não quebram o engine; alterações no engine não quebram este app.

## Local Stripe webhook (aperture-24n36)

O handler em `POST /api/webhooks/stripe` verifica a assinatura via
`stripe.webhooks.constructEvent` antes de despachar para os use-cases
de finalização. Para testar localmente:

```bash
# Em outro terminal, com a Stripe CLI logada (stripe login):
stripe listen --forward-to localhost:3001/api/webhooks/stripe
# > Ready! Your webhook signing secret is whsec_xxx (^C to quit)
```

Cole o `whsec_xxx` no `.env` como `STRIPE_WEBHOOK_SECRET` e reinicie o
servidor de dev (`pnpm dev`) para o env recarregar. O secret muda a
cada `stripe listen` — não compartilhe entre máquinas.

Triggers úteis:

```bash
stripe trigger checkout.session.completed
stripe trigger checkout.session.expired
stripe trigger payment_intent.payment_failed
```

Smoke test de assinatura inválida (deve retornar 400 com
`signature mismatch`, NUNCA vazando a mensagem do SDK):

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"id":"evt_fake","type":"checkout.session.completed"}' \
  http://localhost:3001/api/webhooks/stripe -w "\n%{http_code}\n"
# → signature mismatch
# → 400
```

Em produção, configure o webhook endpoint no Stripe Dashboard (URL
pública do server + path `/api/webhooks/stripe`) e use o signing
secret que o Stripe gera lá.

## Próximos passos sugeridos

- **Integrar o engine**: importar `../../src/...` direto (ou converter o repo em pnpm workspace) e renderizar dados reais.
- **Rotas adicionais**: `/loja/:idCampanha`, `/admin/...` — adicionar em `pages/App.tsx` + criar componentes em `pages/`.
- **SPA navigation**: trocar `<a href>` por algo client-side se a UX precisar. Hoje é full page nav (mais simples, ok).
- **Outra plataforma**: copiar este folder pra `apps/eucasei-server/`, mesmo padrão.
