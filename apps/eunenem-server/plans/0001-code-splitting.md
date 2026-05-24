# Plan 0001 — Code splitting

> **Status**: 📝 deferido. Revisitar quando `public/client.js` minificado passar de ~300KB ou quando alguma página puxar dependências pesadas (charts, editor, mapa) que outras páginas não usam.

## Como funciona hoje

Um único bundle `public/client.js` (~195KB minificado, ~1MB com sourcemap em dev) contém **tudo**:

- React + ReactDOM
- Layout, App
- HomePage, ContadorPage, NotFoundPage
- todo e qualquer componente que `client.tsx` alcance via import estático

Visitar qualquer rota baixa o bundle inteiro. Se você só visita `/`, ainda assim baixa o código de `/contador` que nunca vai rodar.

Prova rápida (de dentro do app):

```bash
grep -oE 'HomePage|ContadorPage|NotFoundPage|useState|hydrateRoot' public/client.js | sort | uniq -c
```

Você vê todos os símbolos no mesmo arquivo.

## Por que **não estamos** code-splitting hoje

`build.mjs` chama esbuild com:

```js
{
  entryPoints: ['client.tsx'],
  bundle: true,
  outfile: 'public/client.js',   // 1 arquivo de saída
  format: 'esm',
  // sem splitting: true
}
```

Sem `splitting: true`, esbuild concatena tudo em um único arquivo. Sem `lazy()` no React, todo import é estático e sempre vai pro bundle principal.

Essa escolha foi consciente: em 3 páginas e 195KB, splitting não compensa a complexidade adicional (especialmente o problema de coordenação com SSR — ver abaixo).

## Quando vale a pena fazer

Regra de bolso:

- **`client.js` minificado < 300KB e todas as páginas usam código parecido**: não compensa. A coordenação custa mais que o ganho.
- **`client.js` minificado > 300KB e dá pra apontar páginas que não precisam de pedaços grandes**: compensa. Por exemplo, se a página `/admin` usar uma biblioteca de gráficos de 200KB que a `/loja` não usa.
- **Páginas heterogêneas (editor rico, mapa, video player, etc.)**: code-split essas páginas individualmente, mesmo se o total for menor.

Sintoma de "tá na hora": o Lighthouse reclama de "Avoid enormous network payloads" ou "Reduce unused JavaScript" em rotas específicas.

## Implementação (versão simples, sem coordenação com SSR)

Duas mudanças:

**1. `pages/App.tsx`** — trocar imports estáticos por `React.lazy`:

```tsx
import { lazy, Suspense } from 'react';
import { Layout } from './Layout.js';

const HomePage = lazy(() => import('./HomePage.js'));
const ContadorPage = lazy(() => import('./ContadorPage.js'));
const NotFoundPage = lazy(() => import('./NotFoundPage.js'));

export function App({ pathname }: { pathname: string }) {
  return (
    <Layout pathname={pathname}>
      <Suspense fallback={<div className="text-slate-400">carregando…</div>}>
        {pickPage(pathname)}
      </Suspense>
    </Layout>
  );
}
```

**2. `build.mjs`** — habilitar splitting no esbuild:

```js
const opts = {
  entryPoints: ['client.tsx'],
  bundle: true,
  outdir: 'public',          // troca outfile por outdir
  splitting: true,            // NOVO
  format: 'esm',              // já tá; obrigatório pra splitting
  target: ['es2022'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch,
  logLevel: 'info',
};
```

esbuild vai emitir:

```
public/
├── client.js           (~50KB — React + Layout + App switch)
├── chunks/
│   ├── HomePage-A1B2.js
│   ├── ContadorPage-C3D4.js
│   └── NotFoundPage-E5F6.js
```

`server.tsx` não precisa mudar — `<script type="module" src="/public/client.js">` continua sendo o ponto de entrada; o navegador resolve os chunks automaticamente via `import()`.

## A parte difícil — coordenação com SSR

Sem mais nada, vai acontecer isto:

1. Servidor renderiza `<ContadorPage />` → HTML chega com o contador visível ✅
2. Navegador parseia HTML, começa a baixar `client.js`
3. `client.js` roda, encontra `lazy(() => import('./ContadorPage.js'))`
4. Esse `import()` é **assíncrono** — vai numa segunda request buscar o chunk
5. Enquanto busca, Suspense mostra o fallback `<div>carregando…</div>`
6. **Hydration mismatch**: o DOM tem o contador, React quer renderizar "carregando…"
7. React desiste da hidratação, joga fora o HTML SSR'd, re-renderiza do zero no cliente

Resultado: flash visível + perda do benefício do SSR.

### Como resolver

O servidor precisa anunciar pro navegador *quais chunks a página SSR'd vai precisar*, **antes** de o `client.js` rodar. Isso se faz com `<link rel="modulepreload" href="...">` no `<head>`. O navegador baixa os chunks em paralelo com `client.js`, e quando o `lazy(() => import('./ContadorPage.js'))` executa, o chunk já tá em cache — resolve sincronamente — sem flash.

Implementação:

1. esbuild aceita `metafile: true` na config. Ele emite um JSON descrevendo qual chunk corresponde a qual entry/import.
2. `build.mjs` salva esse metafile (ex: `public/.metafile.json`).
3. `server.tsx` carrega o metafile na boot, monta um mapa `{ pathname → [chunks] }` (ou `{ componentName → chunks }`).
4. Antes de renderizar, descobre quais chunks a rota vai precisar e emite `<link rel="modulepreload">` no envelope HTML.

Esforço estimado: ~half-day pra fazer direito. O frameworks (Next, Remix) automatizam isso via "build manifest" e é por isso que "code splitting + SSR" parece complicado — porque é, mas é uma complicação resolvível, não mágica.

## Alternativas (se a coordenação parecer muita coisa)

- **Pre-bundle por rota inteira** (sem `lazy()` no React): em vez de um `client.js` único, ter um `client-home.js`, `client-contador.js` etc., cada um com a App.tsx + a página dele. Servidor escolhe qual `<script>` emitir. Sem Suspense, sem coordenação. **Custo**: cada rota duplica React + Layout (~50KB de overhead duplicado). Bom até 5-6 rotas; ruim depois.

- **Não fazer SSR pra páginas pesadas**: marcar `/editor` (por exemplo) como "client-only" — server emite shell vazio, client carrega o editor. Perde SEO/primeiro paint pra essa rota, mas evita a coordenação. Útil pra páginas atrás de auth onde SEO não importa.

- **Ir pra um framework**: Next.js e Remix resolvem isso por padrão. Se você acabar precisando de splitting + SSR + RSC + image opts, talvez seja a hora de migrar. **Mas** não migra por antecipação — migra quando a dor for real.

## Done definition

- `pnpm build` emite múltiplos arquivos em `public/` (não só `client.js`).
- Visitar `/` baixa só o chunk da home (verificável no Network tab do DevTools).
- Visitar `/contador` baixa só o chunk do contador.
- Sem hydration mismatch warning no console.
- Sem flash visível do fallback ao carregar a página.
- Lighthouse mostra "unused JavaScript" reduzido nas rotas que antes traziam tudo.
