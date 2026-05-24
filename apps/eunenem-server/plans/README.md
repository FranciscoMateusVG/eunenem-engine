# eunenem-server — plans

Notes para revisitar depois que o app estiver mais carnudo. Cada arquivo descreve uma melhoria de infra/arquitetura que **não vale a pena fazer agora** mas vai valer quando o app crescer. A ideia é não esquecer das opções existentes nem dos trade-offs.

Convenção: mesmo formato dos `plans/` do engine, mas mais leve (não tem BC, não tem DDD, é só JS na ponta).

| #    | Plano                                                     | Quando revisitar                                        |
| ---- | --------------------------------------------------------- | ------------------------------------------------------- |
| 0001 | [code-splitting](./0001-code-splitting.md)                | Quando `public/client.js` minificado passar de ~300KB.  |
| 0002 | [html-streaming](./0002-html-streaming.md)                | Quando alguma página depender de dado lento (>200ms) ou TTFB virar métrica que importa. |
| 0003 | [trpc-react-query](./0003-trpc-react-query.md)            | Quando aparecer a 1ª mutação real (form que cria/edita dado via engine). Decisão de stack já tomada — só implementar. |

## Outros tópicos que provavelmente viram plano

Anotados aqui pra não esquecer; viram plano quando alguém quiser priorizar:

- **SPA navigation** — substituir full page nav por client-side routing (react-router ou hand-roll com History API). Útil quando navegação ficar perceptivelmente lenta.
- **HMR de verdade** — hoje tem watch+refresh, não HMR. Pra UX de dev em apps grandes, vale Vite ou esbuild + HMR runtime. Não compensa antes disso.
- **React Server Components** — outro modelo de renderização (componentes que só rodam no servidor, sem ir pro bundle). Só faz sentido depois que o bundle tá grande e tem partes claramente "só leitura". Tem interação forte com `0002-html-streaming.md`.
- **Engine integration** — importar `../../src/...` (ou via workspace) e ter páginas servindo dados reais. Vira plano quando começar a conectar.
- **Auth / sessão** — middleware do Hono antes das rotas, cookie HttpOnly, integração com plano 0010 do engine.
- **Deploy** — Docker, edge runtime (Cloudflare Workers via `@hono/cloudflare-workers`), ou Node puro. Depende do destino.
- **Observabilidade** — OTel no Hono + propagação pro engine quando integrar (trace ponta-a-ponta UI → use case).
- **Outras plataformas** — copiar este folder pra `apps/eucasei-server/`. Padrão repetível. Vira plano se mais de uma plataforma precisar.

## Quando criar um novo plano aqui

Quando uma decisão de arquitetura/infra surgir mas **não for a hora de fazer**, escreve aqui em vez de só lembrar. O texto deve responder:

1. Como funciona hoje?
2. Qual o problema futuro que isso evita?
3. Quando vale a pena fazer (threshold)?
4. Qual a implementação (passos curtos)?
5. Qual a parte difícil (o que sempre subestimamos)?
