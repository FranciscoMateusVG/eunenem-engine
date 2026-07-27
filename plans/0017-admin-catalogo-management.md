# 0017 — Administração do catálogo de presentes

**Status.** 🚧 em implementação (B1 — fundação de persistência)
**Depends on.** Plan 0010 (autenticação real e `adminProcedure`), catálogo estático atual em
`apps/eunenem-server/lib/seed-data/`
**Unblocks.** Administração de produtos/categorias/listas, leitura pública do catálogo via tRPC e
aposentadoria dos loaders JSON no cliente.

## Goal

Transformar o catálogo global de presentes, hoje versionado como JSON e embutido no bundle, em
dados persistidos e administráveis. O operador poderá ver, criar, editar, ativar e desativar
produtos; administrar categorias; e criar listas curadas de produtos. O fluxo público "Minha lista
de presentes" passará a ler a mesma fonte de dados, evitando o split-brain em que o admin altera uma
coisa e o cliente continua exibindo outra.

O primeiro deploy preserva integralmente os dados atuais: 8 categorias, 501 produtos e 5 listas
prontas. A migração é autossuficiente e carrega snapshots próprios, sem depender de caminhos sob
`apps/` que poderão ser removidos depois.

## Locked decisions

1. **"Listas de produtos" significa duas capacidades.** Categorias são administráveis e listas
   curadas (kits/templates) também. As 5 listas de `listas-prontas.json` são o conceito existente e
   tornam-se as primeiras 5 linhas administráveis; não haverá um segundo sistema paralelo de kits.

2. **Backfill 1:1 obrigatório.** O rollout não começa vazio. O catálogo atual é migrado com 8
   categorias, 501 produtos e 5 listas, incluindo os 77 vínculos lista-produto existentes.

3. **A migração é `20260727_045_catalogo_admin.ts`.** `042`, `043` e `044` já existem em staging.
   Migrações implantadas nunca são renomeadas. O novo arquivo deve ordenar depois de todo o conjunto
   já aplicado, inclusive no gate de migração em duas fases da CI.

4. **Snapshots pertencem à migração.** Os arquivos são copiados como
   `migrations/seed/20260727_045_catalog.json` e
   `migrations/seed/20260727_045_listas-prontas.json`. A migração importa somente esses snapshots.
   O backfill não lê `apps/eunenem-server/lib/seed-data/`, não chama loader de UI e não depende de
   código de aplicação.

5. **Referência ausente falha alto; não cria produto implícito.** O conjunto aprovado foi verificado:
   todos os 77 itens das listas apontam para um dos 501 `catalog.json.id`. Se um snapshot futuro
   contiver um item sem produto correspondente, `up()` lança erro nomeando lista e id legado, e a
   transação inteira falha. Não existe branch de fallback que sintetiza produto em `outros`; isso
   esconderia corrupção do snapshot.

6. **Remoção é soft.** Produto ou lista removido pelo admin recebe `ativo=false`. A linha fica
   visível e reversível no admin, mas some do picker e das listas públicas. Não há hard delete de
   produto/lista no v1.

7. **Categoria só é excluída quando vazia.** A aplicação verifica antes e a FK usa `RESTRICT`.
   Categoria com produto retorna `CONFLICT`; não há cascade nem realocação implícita.

8. **Preço é inteiro em centavos.** `preco_cents` é `bigint`, positivo. O backfill usa
   `Math.round(price * 100)`. DTO público converte para número BRL para manter o contrato
   `ListaCatalogItem.price`.

9. **Ordem de produto é dado persistido.** `catalogo_produtos.position` é obrigatório e preserva a
   ordem de exibição do JSON dentro de cada categoria. É um índice zero-based por categoria, obtido
   pela ordem em que os produtos daquela categoria aparecem no snapshot. A coluna não é unique:
   empates podem existir durante manutenção/reordenação e são resolvidos deterministicamente por
   UUID. Leituras públicas ordenam por
   `categoria.position, categoria.id, produto.position, produto.id`; nunca por nome ou ordem
   incidental do banco.
   No v1, `position` não cruza os inputs create/update. Create calcula
   `max(position) + 1` na categoria de destino; update que troca `idCategoria` move o produto para o
   fim da categoria nova pelo mesmo cálculo; update sem troca de categoria preserva a posição.

10. **Ordem das demais coleções também é explícita.** Categoria, lista e item de lista usam
    `position` zero-based conforme a ordem dos respectivos arrays no snapshot. Posições de
    categoria e lista não são unique: escritas concorrentes podem empatar e leituras resolvem o
    empate por `id`, sem exigir um protocolo de reorder que o v1 não oferece.
    `catalogo_lista_itens` impõe `UNIQUE(id_lista, position)` e
    `UNIQUE(id_lista, id_produto)`.

11. **URLs de imagem são opacas.** `image_url` armazena `string | null` sem normalizar host,
    extensão ou forma. Caminhos locais existentes como `/products/558361.png` e
    `/listas-prontas/lista-12.jpg` continuam válidos; URLs públicas absolutas emitidas pelo storage
    também são válidas. Repositório e domínio não prefixam origem, não exigem `.jpg` e não
    transformam URL remota em caminho local.

12. **IDs novos são UUIDs; o legado é somente rastreabilidade.** Produtos recebem `id uuid`.
    `id_legado text UNIQUE NULL` guarda o id string do JSON e é usado para ligar o backfill das
    listas. O DTO público usa o UUID. Consumidores atuais copiam valores do produto para
    `contribuicoes`; nenhum persiste o id do catálogo.

13. **Catálogo é global à plataforma no v1.** Não há `id_plataforma` nas tabelas. A escrita é
    admin-only e o produto atual opera como catálogo global. Multi-tenant real exigirá migração
    explícita no futuro; não modelamos essa cardinalidade antes de ela existir.

14. **Editar produto faz parte do v1.** Sem edição, corrigir nome/preço/imagem obrigaria
    desativar e recriar. O admin pode alterar os campos, preservando id e relações de listas.

15. **Alteração administrativa fica pública imediatamente.** Não há draft/publish no v1.
    Salvar ou ativar muda a leitura pública; desativar remove da leitura pública.

16. **O read-path público é parte do plano.** O trabalho não termina ao criar tabelas e admin.
    `ListaPresentesBody` precisa trocar loaders estáticos pelas queries públicas. Sem essa fase, a
    feature está funcional no admin e inútil para o cliente.

17. **Erros e vazio continuam distintos.** Falha de query não vira `[]`. A tela mostra erro e
    permite retry; estado vazio só aparece após resposta bem-sucedida sem linhas.

18. **Autorização real é server-side.** Todos os procedimentos `admin.catalog.*`, inclusive
    presign de imagem, usam `adminProcedure` e a allowlist `ADMIN_ALLOWED_EMAILS`. O `isAdmin` do
    cliente é somente UX. O router público expõe exclusivamente leituras.

19. **O upload de imagem do catálogo tem procedimento próprio.** Ele pode reutilizar
    `ObjectStorage`, mas não copia o gate session-only dos presigns atuais. O novo presign é
    admin-only e expira em 5 minutos.

20. **Uma lista substitui seus itens como conjunto.** `setListItems` recebe o conjunto completo e
    o grava transacionalmente. Repetir a mesma entrada é idempotente; não haverá API granular
    add/remove/reorder no v1.

## Data model

### `catalogo_categorias`

| Column | Shape | Notes |
| --- | --- | --- |
| `id` | `uuid PK` | gerado no backfill ou criação |
| `slug` | `text NOT NULL UNIQUE` | identificador público estável |
| `label` | `text NOT NULL` | vocabulário pt-BR exibido |
| `position` | `int NOT NULL CHECK >= 0` | ordem global, zero-based; empate usa `id` |
| `criado_em` | `timestamptz NOT NULL DEFAULT now()` | auditoria |

Excluir categoria é restrito enquanto houver produtos.

### `catalogo_produtos`

| Column | Shape | Notes |
| --- | --- | --- |
| `id` | `uuid PK` | identidade canônica |
| `id_legado` | `text UNIQUE NULL` | trace para `catalog.json.id` |
| `nome` | `text NOT NULL` | nome exibido |
| `preco_cents` | `bigint NOT NULL CHECK > 0` | centavos |
| `quantidade_sugerida` | `int NOT NULL DEFAULT 1 CHECK > 0` | default do picker |
| `emoji` | `text NOT NULL` | fallback visual |
| `bg_color` | `text NOT NULL` | token de cor existente |
| `id_categoria` | `uuid NOT NULL FK catalogo_categorias RESTRICT` | agrupamento |
| `position` | `int NOT NULL CHECK >= 0` | ordem dentro da categoria; empate usa `id` |
| `image_url` | `text NULL` | caminho local ou URL remota opaca |
| `popularidade` | `int NULL` | ranking legado opcional |
| `ativo` | `boolean NOT NULL DEFAULT true` | soft remove |
| `criado_em` | `timestamptz NOT NULL DEFAULT now()` | auditoria |
| `atualizado_em` | `timestamptz NOT NULL DEFAULT now()` | auditoria |

Índices: `id_categoria`, `ativo`. Não há unicidade em `(id_categoria, position)`; `id` é o
tie-break determinístico.

### `catalogo_listas`

| Column | Shape | Notes |
| --- | --- | --- |
| `id` | `uuid PK` | identidade canônica |
| `slug` | `text UNIQUE NULL` | ids legados das listas no backfill |
| `nome` | `text NOT NULL` | título exibido |
| `descricao` | `text NULL` | texto curatorial |
| `image_url` | `text NULL` | caminho local ou URL remota opaca |
| `position` | `int NOT NULL CHECK >= 0` | ordem global, zero-based; empate usa `id` |
| `ativo` | `boolean NOT NULL DEFAULT true` | soft remove |
| `criado_em` | `timestamptz NOT NULL DEFAULT now()` | auditoria |
| `atualizado_em` | `timestamptz NOT NULL DEFAULT now()` | auditoria |

### `catalogo_lista_itens`

| Column | Shape | Notes |
| --- | --- | --- |
| `id` | `uuid PK` | identidade da relação |
| `id_lista` | `uuid NOT NULL FK catalogo_listas ON DELETE CASCADE` | lista dona |
| `id_produto` | `uuid NOT NULL FK catalogo_produtos RESTRICT` | produto existente |
| `quantidade` | `int NOT NULL DEFAULT 1 CHECK > 0` | quantidade aplicada |
| `position` | `int NOT NULL CHECK >= 0` | ordem zero-based na lista |

Unicidades: `(id_lista, id_produto)` e `(id_lista, position)`.
Índices: `id_lista` e `id_produto`. Não há unicidade global em `catalogo_listas.position`;
leituras usam `position, id`.

## Backfill contract

1. Criar as 8 categorias na ordem canônica:
   `fraldas`, `higiene`, `roupa`, `soninho`, `alimentacao`, `passeio`, `brinquedo`,
   `outros`.
2. Usar os labels atuais:
   `fraldas`, `higiene`, `roupinhas`, `soninho`, `alimentação`, `passeio`,
   `brinquedos`, `outros`.
3. Inserir exatamente 501 produtos, todos ativos e com `id_legado` único.
4. Para cada categoria, atribuir `produto.position` pela ordem relativa do produto no snapshot.
5. Inserir exatamente 5 listas, na ordem do snapshot:
   `ilustrativa-especial`, `cha-de-fralda`, `cha-de-rifa`, `ilustrativa`, `carrinhos`.
6. Resolver cada item por `produto.id_legado`. Ausência ou duplicidade lança erro antes de qualquer
   estado parcial ser confirmado.
7. Inserir exatamente 77 relações lista-produto. Contagens por lista: 3, 33, 30, 5 e 6.
8. Usar `suggestedQty` como `quantidade` e o índice no array como `position`.
9. Preservar `name`, `price`, `suggestedQty`, `emoji`, `bgColor`, `imageUrl` e `popularity` conforme
   aplicável. URLs são copiadas byte a byte.

O teste de migração compara o banco com os snapshots, não apenas contagens. O join
`catalogo_lista_itens → catalogo_listas + catalogo_produtos` deve produzir os mesmos 77 tuples
`(lista.slug, produto.id_legado, quantidade, position)` do JSON.

## Backend contracts

The procedure-by-procedure wire contract, including validation, errors, examples and rate tiers,
lives in [`0017-catalog-api-contract.md`](./0017-catalog-api-contract.md).

### Repository port

`src/adapters/catalogo/repository.ts` define um `CatalogoRepository` único para o contexto,
seguindo a granularidade dos ports existentes. Ele cobre:

- listagem/paginação/criação/edição/ativação de produtos;
- listagem/criação/edição/exclusão segura de categorias;
- listagem/criação/edição/ativação de listas;
- alocação `max(position) + 1` para novos produtos/listas, incluindo linhas inativas;
- leitura e substituição transacional dos itens de lista;
- projeções públicas de seções e listas ativas.

Adapters:

- `repository.postgres.ts`: Kysely, usando o mesmo `Database` criado em `buildServerDeps`;
- `repository.memory.ts`: contrato equivalente para testes rápidos;
- `tests/helpers/catalogo-repository.conformance.ts`: suite compartilhada pelos dois adapters.

`ServerDeps.catalogoRepository` é obrigatório e `buildServerDeps` constrói
`CatalogoRepositoryPostgres(db)`. Um teste de composição prova que a dependência retornada é o
adapter real; injetá-la apenas em testes de router não conta como wiring.

### Admin tRPC

Sub-router `admin.catalog`, composto no admin router. Todo procedimento usa `adminProcedure`.

- `listProducts({ search?, idCategoria?, includeInactive?, page?, pageSize? })`
  → `{ products, total }`
- `createProduct({ nome, precoCents, quantidadeSugerida?, emoji, bgColor, idCategoria,
  imageUrl?, popularidade? })` — servidor atribui `max(position) + 1` na categoria
- `updateProduct({ id, nome?, precoCents?, quantidadeSugerida?, emoji?, bgColor?, idCategoria?,
  imageUrl?, popularidade? })` — sem `position`; trocar categoria move para o fim da nova categoria
- `setProductAtivo({ id, ativo })`
- `listCategories()`
- `createCategory({ slug, label, position })`
- `updateCategory({ id, label?, position? })`
- `deleteCategory({ id })` → `CONFLICT` quando não vazia
- `listLists({ includeInactive? })`
- `getList({ id })` → detalhe com itens ordenados; leitura necessária antes do replace completo
- `createList({ nome, descricao?, imageUrl? })`
- `updateList({ id, ...partial })`
- `setListAtivo({ id, ativo })`
- `setListItems({ idLista, items: [{ idProduto, quantidade, position }] })`
- `emitirUrlUploadImagemProduto({ contentType })`

`getList` is an implementation-time contract correction: the original sketch exposed only list
summaries plus a whole-set replacement mutation, which made editing an existing or inactive list
impossible without first reading its persisted item set.

`ProdutoAdminDTO` expõe a linha completa, inclusive `ativo`, `idLegado`, `precoCents` e `position`.
`position` é read-only no contrato admin v1. Schemas zod validam entrada e saída. Cada classe de
procedimento admin possui teste `FORBIDDEN` para caller fora da allowlist.

### Public tRPC

Router `catalogo`, somente leitura:

- `listSections()` → `ListaCatalogSection[]`, produtos ativos agrupados e ordenados por posições;
- `listListasProntas()` → shape compatível com o loader atual, somente listas ativas e somente
  produtos ativos.

Preço volta como número BRL; `imageUrl` volta sem transformação. O id público do produto passa a
ser UUID.

## Admin UI contract

O admin estende o shell atual:

- `AdminShell`: nav `Catálogo` apontando para `/admin/catalogo`;
- `App.tsx`: resolução explícita da rota SPA e `AdminCatalogoPage`;
- página com tabs `PRODUTOS | LISTAS | CATEGORIAS`;
- mesmo card chrome, headers mono e linguagem visual do admin existente;
- nenhum novo `DddBadge`;
- estados de erro explícitos; vazio factual ("Nenhum produto encontrado").

### Produtos

Tabela com nome, emoji/imagem, categoria, preço, ativo e popularidade. Busca, filtro de categoria e
toggle de inativos. Modal de criar/editar aceita upload presignado ou URL; ações de
ativar/desativar são reversíveis.

### Listas

Cards com nome, descrição, quantidade de itens e estado. Editor oferece busca/filtro de produtos,
quantidade e reordenação. Salva por `setListItems`.

### Categorias

Tabela compacta com slug, label, posição e contagem de produtos. Criação, rename e reorder.
Exclusão de categoria ocupada fica desabilitada na UI e continua protegida no servidor.

## Customer-flow swap

`ListaPresentesBody.tsx` troca:

- `loadCatalog()` por `trpc.catalogo.listSections.useQuery`;
- `loadListasProntas()` por `trpc.catalogo.listListasProntas.useQuery`.

Os DTOs preservam o shape visual. `ListaCategory` deixa de ser union fechada para categorias de
catálogo, enquanto `personalizado` continua reservado para item criado pelo usuário. O fluxo
`addCatalogItems` continua copy-by-value para `contribuicoes`; não há FK de contribuição para
catálogo.

Mocks de demo podem continuar file-based durante o bake. Loader e JSONs originais são marcados
deprecated e removidos em follow-up somente depois do read-path em staging estar validado.

O PR de swap não usa auto-merge antes de backend e routers estarem implantados. Em ausência do
router, a página mostra erro, nunca catálogo vazio.

## DDD concepts this plan teaches

1. **Uma fonte de verdade por capacidade.** Admin write e cliente read precisam convergir no mesmo
   repositório. Manter JSON como read path após criar admin DB é split-brain, não compatibilidade.

2. **Ordenação é estado quando a ordem é produto.** O JSON preservava ordem implicitamente. No
   banco, `position` torna a regra explícita e testável; sem ele, a UI dependeria de acaso do plano
   de execução.

3. **Identidade de migração não é identidade de domínio.** `id_legado` existe para rastreabilidade
   e backfill. UUID é a identidade canônica após a migração.

4. **Soft remove preserva relações.** Lista curada referencia produto. Desativação mantém histórico
   e reversibilidade sem inventar cascade destrutivo.

5. **Dados de migração devem sobreviver ao app atual.** Snapshot ao lado da migração é parte do
   artefato histórico. Código futuro pode apagar loaders sem tornar um bootstrap do zero impossível.

6. **Falhar alto é melhor que fabricar dado.** Uma referência inexistente em snapshot é corrupção.
   Criar silenciosamente um produto "outros" transformaria erro verificável em dado falso.

7. **URL pertence à borda.** O catálogo armazena um identificador público opaco. Storage/CDN/local
   path são estratégias de entrega, não variantes do domínio.

## Phases

### Phase 0 — Foundation (B1, Rex)

- migração 045 + snapshots + backfill;
- tipos Kysely regenerados;
- port + adapters memory/Postgres;
- conformance compartilhada;
- `ServerDeps` e composição real;
- round-trip de migração com prova 8/501/5/77;
- `pnpm check:catalogo-integrity` para smoke pós-deploy (mínimos, ativos e órfãos);
- este plano e índice do README.

**STOP:** migration, backfill integrity, adapters e composition smoke verdes.

### Phase 1 — Backend APIs (B2, Rex)

- routers admin e público;
- validação zod e mapeamento de erros;
- presign admin-only;
- proc tests, incluindo `FORBIDDEN` e `CONFLICT`.

**STOP:** contrato tRPC estável e publicado para frontend/QA.

### Phase 2 — Security review (S1, Cipher)

- verificar `adminProcedure` em todo write e presign;
- testar inputs adversariais;
- confirmar router público read-only;
- confirmar ausência de bypass/orphan write path.

**STOP:** sign-off ou findings bloqueadores resolvidos.

### Phase 3 — Admin UI (F1, Vance)

- nav + rota SPA + página;
- tabs de produtos/listas/categorias;
- upload, formulários, filtros e estados de erro;
- ações soft-remove/restore e edição de listas.

**STOP:** jornada admin funcional contra staging.

### Phase 4 — Customer read-path (F2, Vance)

- trocar loaders por queries;
- abrir categorias para slugs data-driven;
- manter copy-by-value para contribuições;
- deprecar loaders e seeds antigos.

**STOP:** catálogo e listas do admin aparecem no picker/curadoria.

### Phase 5 — E2E and staging verification (Q1, Izzy)

- jornada primária abaixo;
- verificação pós-migração de dados reais;
- cobertura de soft remove/restore;
- aplicação de lista com 3 produtos;
- link/direct-load/auth gates.

**STOP:** dados renderizáveis e efeitos persistidos; resposta 200 vazia não conta como verificação.

### Phase 6 — Cleanup (follow-up)

Após bake em staging, remover loaders e JSONs antigos sob `apps/`. Os snapshots em
`migrations/seed/` permanecem para sempre como parte da migração.

## Primary user journey

1. Entrar com email em `ADMIN_ALLOWED_EMAILS`; abrir `/admin`.
2. Clicar `Catálogo`; `/admin/catalogo` responde e mostra 501 produtos.
3. Buscar e filtrar por categoria.
4. Criar produto com nome, preço, emoji, categoria e imagem; confirmar no admin e no picker público.
5. Desativar produto; confirmar ausência pública e presença inativa no admin; reativar.
6. Criar lista "Enxoval básico teste" com 3 produtos/quantidades; confirmar contagem.
7. Abrir curadoria pública, aplicar a lista e confirmar 3 contribuições copy-by-value.
8. Criar categoria `teste-spec`, usá-la no formulário e removê-la enquanto vazia.
9. Tentar remover `roupa` com produtos; receber bloqueio claro/`CONFLICT`.

## Link and redirect validation

- `/admin` → nav `Catálogo` → `/admin/catalogo`;
- direct load de `/admin/catalogo` responde 200 para admin;
- não-admin é negado pelo backend e segue o comportamento fail-closed do shell;
- URL presignada aceita PUT e a URL pública salva renderiza no produto;
- `/painel/<slug>/lista` lê catálogo DB após Phase 4.

## Open questions

As ambiguidades originais foram resolvidas pelo operador:

- categorias e listas curadas entram juntas;
- backfill é 1:1;
- remoção é soft;
- edição de produto entra no v1;
- alteração publicada é imediata, sem draft/publish.

Questões futuras, deliberadamente não modeladas agora:

- catálogo por plataforma/tenant;
- workflow draft/publish;
- hard delete e retenção histórica formal;
- CDN ou normalização de URL;
- versionamento de listas.

Cada uma exige uma necessidade real e uma migração própria.

## Done definition

- [ ] `20260727_045_catalogo_admin.ts` aplica sobre staging já migrado e faz down limpo.
- [ ] Snapshots `20260727_045_catalog.json` e `20260727_045_listas-prontas.json` vivem em
      `migrations/seed/`; nenhum import da migração aponta para `apps/`.
- [ ] Banco recém-migrado contém exatamente 8 categorias, 501 produtos, 5 listas e 77 itens.
- [ ] Comparação completa prova labels/posições, conversão de preço e todos os FKs por id legado.
- [ ] Referência de preset ausente aborta a migração com erro descritivo.
- [ ] `CatalogoRepository` passa a mesma conformance em memory e Postgres.
- [ ] `buildServerDeps` entrega `CatalogoRepositoryPostgres` real.
- [ ] `src/adapters/db-types.generated.ts` foi regenerado e drift check passa.
- [ ] `pnpm check:catalogo-integrity` passa com `DATABASE_URL` de staging, exige ao menos uma
      categoria/lista/item, preserva os 501 produtos legados, reporta dados ativos e nenhum órfão.
- [ ] Todos os procedimentos admin são allowlist-gated e validados.
- [ ] Router público é read-only e retorna somente linhas ativas, em ordem de
      `categoria.position, categoria.id, produto.position, produto.id`.
- [ ] `/admin/catalogo` entrega os três workflows completos.
- [ ] Picker e curadoria públicos leem o banco e distinguem erro de vazio.
- [ ] Jornada primária passa em staging com dados reais, não arrays vazios.
- [ ] PRs nomeiam migração, novos endpoints, shapes e auth gates no runtime-contract section.
