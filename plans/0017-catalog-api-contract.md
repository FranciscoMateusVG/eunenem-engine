# Catalog API contract — B2

Status: implementation contract for `aperture-d4pmw`.

Transport: tRPC over `/api/trpc`. Procedure names below are the stable client contract. Queries use
the tRPC query transport and mutations use the tRPC mutation transport; callers should use the
generated `AppRouter` client rather than assemble HTTP URLs.

## Shared conventions

- All inputs and outputs are validated with zod at the server boundary.
- UUID fields are canonical UUID strings.
- Money is an integer number of cents in admin procedures and a BRL decimal number in public
  projections.
- Timestamps are ISO-8601 strings.
- `imageUrl` is `null` or one of:
  - a root-relative path beginning with one `/`, such as `/products/558361.png`;
  - an absolute `https:` URL without embedded credentials.
  - a credential-free `http:` URL whose host is exactly `localhost`, `127.0.0.1` or `::1`, for
    the supported local MinIO development configuration only.
- Empty strings, protocol-relative URLs, paths containing a backslash, non-loopback `http:`,
  `data:`, `javascript:` and URLs with credentials are rejected. Root-relative paths must resolve
  against the application's own origin. The maximum URL length is 2,048 characters.
- `bgColor` is one of the six catalog tokens already present in the immutable seed:
  `var(--blue)`, `var(--blue-soft)`, `var(--cream-2)`, `var(--lilac-soft)`,
  `var(--pink-soft)` or `var(--yellow-soft)`. Arbitrary CSS is rejected.
- `position` is a non-negative integer. Product and list positions are server-owned in v1.
- Error envelope is the standard tRPC error response. Client code switches on `error.data.code`,
  not localized message text.

### Input bounds

| Field | Rule |
| --- | --- |
| product/list name | trimmed, 1..200 characters |
| category label | trimmed, 1..120 characters |
| category slug | 1..80 characters, lowercase kebab, not `personalizado` |
| emoji | trimmed, 1..32 characters |
| list description | `null` or trimmed string up to 2,000 characters |
| search | literal case-insensitive substring, up to 200 characters |
| price/quantity | positive safe integer |
| popularity/position | non-negative safe integer |
| pagination | page 1..100,000; page size 1..100 |
| list items | at most 1,000; product IDs and positions must each be unique |

Partial update mutations reject an input containing only `id`. Unknown object keys are rejected.

### Error codes

| Code | Meaning |
| --- | --- |
| `BAD_REQUEST` | zod validation failed or the request violates a catalog input invariant |
| `UNAUTHORIZED` | no valid session for an `admin.catalog.*` procedure |
| `FORBIDDEN` | valid session, but email is not in `ADMIN_ALLOWED_EMAILS` |
| `NOT_FOUND` | requested category, product, list or referenced product does not exist |
| `CONFLICT` | category is non-empty or a unique catalog value already exists |
| `INTERNAL_SERVER_ERROR` | unexpected repository/storage failure; never converted to empty data |

Example error:

```json
{
  "error": {
    "data": { "code": "FORBIDDEN" },
    "message": "Acesso restrito."
  }
}
```

### Traffic tiers

| Tier | Procedures | Application budget |
| --- | --- | --- |
| `admin-allowlist-unthrottled` | every `admin.catalog.*` procedure | no application counter in B2; session + allowlist authorization is mandatory |
| `public-read-unthrottled` | `catalogo.listSections`, `catalogo.listListasProntas` | no application counter in B2; read-only |

These are explicitly unthrottled application tiers, not rate limits disguised as authorization.
Both inherit deployment-level request/body limits. B2 adds no in-memory limiter. A production
request budget requires a durable multi-instance adapter and a separately reviewed contract; do
not add an instance-local counter.

## DTOs

### `ProdutoAdminDTO`

```ts
{
  id: string;
  idLegado: string | null;
  nome: string;
  precoCents: number;             // positive safe integer
  quantidadeSugerida: number;     // positive integer
  emoji: string;
  bgColor: string;
  idCategoria: string;
  position: number;               // non-negative, read-only in v1
  imageUrl: string | null;
  popularidade: number | null;    // non-negative integer
  ativo: boolean;
  criadoEm: string;
  atualizadoEm: string;
}
```

### `CategoriaAdminDTO`

```ts
{
  id: string;
  slug: string;
  label: string;
  position: number;
  quantidadeProdutos: number;     // includes inactive products
  criadoEm: string;
}
```

### `ListaAdminDTO`

```ts
{
  id: string;
  slug: string | null;
  nome: string;
  descricao: string | null;
  imageUrl: string | null;
  position: number;
  ativo: boolean;
  quantidadeItens: number;        // includes inactive products
  criadoEm: string;
  atualizadoEm: string;
}
```

### `ListaAdminDetailDTO`

```ts
{
  ...ListaAdminDTO;
  items: {
    idProduto: string;
    quantidade: number;
    position: number;
  }[];
}
```

Items are ordered by persisted position and UUID tie-break. The detail read is the source of truth
before calling the whole-set `setListItems` mutation.

### Public catalog DTOs

```ts
type ListaCatalogItemDTO = {
  id: string;                     // product UUID
  name: string;
  price: number;                  // BRL
  suggestedQty: number;
  emoji: string;
  bgColor: string;
  category: string;               // data-driven category slug
  imageUrl: string | null;
  popularity?: number;            // omitted when null
};

type ListaCatalogSectionDTO = {
  category: string;
  label: string;
  items: ListaCatalogItemDTO[];
};

type ListaProntaItemDTO = Omit<ListaCatalogItemDTO, "category" | "popularity">;

type ListaProntaDetailDTO = {
  id: string;                     // legacy slug when present, otherwise list UUID
  title: string;
  description: string;
  imageUrl: string | null;
  items: ListaProntaItemDTO[];
};
```

`catalogo.listListasProntas` returns `Record<string, ListaProntaDetailDTO>`, keyed by the same value
as `detail.id`. Backfilled lists retain their legacy semantic keys; newly-created lists use UUID.
For curated-list items, `suggestedQty` comes from the list relation's `quantidade`, not the
product's catalog default.

## Admin procedures

Every procedure below uses `adminProcedure` and therefore belongs to traffic tier
`admin-allowlist-unthrottled`.

| Procedure | Kind | Input | Success |
| --- | --- | --- | --- |
| `admin.catalog.listProducts` | query | `{ search?: string(<=200), idCategoria?: uuid, includeInactive?: boolean=false, page?: int 1..100000=1, pageSize?: int 1..100=20 }` | `{ products: ProdutoAdminDTO[], total: int>=0 }` |
| `admin.catalog.createProduct` | mutation | `{ nome, precoCents, quantidadeSugerida?=1, emoji, bgColor, idCategoria, imageUrl?, popularidade? }` | `ProdutoAdminDTO` |
| `admin.catalog.updateProduct` | mutation | `{ id, nome?, precoCents?, quantidadeSugerida?, emoji?, bgColor?, idCategoria?, imageUrl?, popularidade? }` | `ProdutoAdminDTO` |
| `admin.catalog.setProductAtivo` | mutation | `{ id, ativo }` | `ProdutoAdminDTO` |
| `admin.catalog.listCategories` | query | no input | `CategoriaAdminDTO[]` |
| `admin.catalog.createCategory` | mutation | `{ slug, label, position }` | `CategoriaAdminDTO` |
| `admin.catalog.updateCategory` | mutation | `{ id, label?, position? }` | `CategoriaAdminDTO` |
| `admin.catalog.deleteCategory` | mutation | `{ id }` | `{ deleted: true }` |
| `admin.catalog.listLists` | query | `{ includeInactive?: boolean=false }` | `ListaAdminDTO[]` |
| `admin.catalog.getList` | query | `{ id }` | `ListaAdminDetailDTO` |
| `admin.catalog.createList` | mutation | `{ nome, descricao?, imageUrl? }` | `ListaAdminDTO` |
| `admin.catalog.updateList` | mutation | `{ id, nome?, descricao?, imageUrl? }` | `ListaAdminDTO` |
| `admin.catalog.setListAtivo` | mutation | `{ id, ativo }` | `ListaAdminDTO` |
| `admin.catalog.setListItems` | mutation | `{ idLista, items: [{ idProduto, quantidade, position }] }` | `{ updated: true }` |
| `admin.catalog.emitirUrlUploadImagemProduto` | mutation | `{ contentType: "image/jpeg" | "image/png" | "image/webp" }` | `{ uploadUrl, objectKey, publicUrl }` |

Mutation rules:

- `createProduct` appends at `max(position) + 1` in the target category.
- `updateProduct` preserves position unless `idCategoria` changes; a category change appends to the
  target category.
- `createList` appends at global `max(position) + 1`.
- `createCategory.slug` is a lowercase kebab slug and rejects the reserved value
  `personalizado`, which remains exclusive to user-authored contribution items.
- omitted nullable fields preserve their existing value; explicit `null` clears them.
- `setListItems` replaces the complete set transactionally. Empty input clears the list. Repeated
  equivalent input is idempotent. The array is capped at 1,000 entries; duplicate product IDs or
  duplicate positions return `BAD_REQUEST`.
- category deletion returns `CONFLICT` when active or inactive products reference it.
- upload keys are server-generated as `catalogo/produtos/<uuid>.<ext>`. The presign expires after
  300 seconds and locks the supplied `Content-Type`. The input does not accept a filename, key,
  path, product ID or admin identity.
- `listProducts` search is a case-insensitive literal substring match. Products, categories, lists
  and list-detail items have deterministic persisted-position/UUID ordering.

Example list request/response:

```json
{
  "input": {
    "search": "fralda",
    "includeInactive": false,
    "page": 1,
    "pageSize": 20
  },
  "output": {
    "products": [
      {
        "id": "5ee01433-f760-4fab-97dc-cd55154918ee",
        "idLegado": "558361",
        "nome": "Fralda RN",
        "precoCents": 2990,
        "quantidadeSugerida": 1,
        "emoji": "🧷",
        "bgColor": "var(--pink-soft)",
        "idCategoria": "96a4ec31-dfeb-438f-9c35-9bb0350fb360",
        "position": 0,
        "imageUrl": "/products/558361.png",
        "popularidade": 10,
        "ativo": true,
        "criadoEm": "2026-07-27T12:00:00.000Z",
        "atualizadoEm": "2026-07-27T12:00:00.000Z"
      }
    ],
    "total": 1
  }
}
```

Expected procedure-specific errors:

| Procedure class | Additional errors |
| --- | --- |
| create/update product | `NOT_FOUND` for missing target category |
| update/toggle product | `NOT_FOUND` for missing product |
| create category | `CONFLICT` for duplicate slug |
| update/delete category | `NOT_FOUND` for missing category |
| delete category | `CONFLICT` for non-empty category |
| get/update/toggle list | `NOT_FOUND` for missing list |
| set list items | `NOT_FOUND` for missing list or any referenced product |
| partial updates | `BAD_REQUEST` when no mutable field is supplied |
| set list items | `BAD_REQUEST` for more than 1,000 items or duplicate product IDs/positions |
| upload presign | `BAD_REQUEST` for any non-enumerated MIME type |

### Compact admin examples

The examples use shortened but schema-complete payloads. UUIDs and timestamps are illustrative.

```jsonc
// admin.catalog.createProduct
// input
{"nome":"Fralda RN","precoCents":2990,"emoji":"🧷","bgColor":"var(--pink-soft)","idCategoria":"96a4ec31-dfeb-438f-9c35-9bb0350fb360"}
// output: ProdutoAdminDTO
{"id":"5ee01433-f760-4fab-97dc-cd55154918ee","idLegado":null,"nome":"Fralda RN","precoCents":2990,"quantidadeSugerida":1,"emoji":"🧷","bgColor":"var(--pink-soft)","idCategoria":"96a4ec31-dfeb-438f-9c35-9bb0350fb360","position":12,"imageUrl":null,"popularidade":null,"ativo":true,"criadoEm":"2026-07-27T12:00:00.000Z","atualizadoEm":"2026-07-27T12:00:00.000Z"}

// admin.catalog.updateProduct
{"id":"5ee01433-f760-4fab-97dc-cd55154918ee","imageUrl":"/catalogo/produtos/a.png","popularidade":null}
// output: ProdutoAdminDTO with those fields updated

// admin.catalog.setProductAtivo
{"id":"5ee01433-f760-4fab-97dc-cd55154918ee","ativo":false}
// output: ProdutoAdminDTO with ativo=false

// admin.catalog.listCategories
// input: none
[{"id":"96a4ec31-dfeb-438f-9c35-9bb0350fb360","slug":"fraldas","label":"Fraldas","position":0,"quantidadeProdutos":82,"criadoEm":"2026-07-27T12:00:00.000Z"}]

// admin.catalog.createCategory
{"slug":"alimentacao","label":"Alimentação","position":8}
// output
{"id":"0d4cdb88-27ce-4c49-86c6-714eaab1352b","slug":"alimentacao","label":"Alimentação","position":8,"quantidadeProdutos":0,"criadoEm":"2026-07-27T12:00:00.000Z"}

// admin.catalog.updateCategory
{"id":"0d4cdb88-27ce-4c49-86c6-714eaab1352b","label":"Alimentação do bebê"}
// output: CategoriaAdminDTO with the updated label

// admin.catalog.deleteCategory
{"id":"0d4cdb88-27ce-4c49-86c6-714eaab1352b"}
// output
{"deleted":true}

// admin.catalog.listLists
{"includeInactive":true}
[{"id":"ad4aa121-550d-41df-a39b-697f7c2e54a2","slug":"cha-de-fralda","nome":"Chá de fralda","descricao":"Uma seleção prática","imageUrl":null,"position":0,"ativo":true,"quantidadeItens":20,"criadoEm":"2026-07-27T12:00:00.000Z","atualizadoEm":"2026-07-27T12:00:00.000Z"}]

// admin.catalog.getList
{"id":"ad4aa121-550d-41df-a39b-697f7c2e54a2"}
{"id":"ad4aa121-550d-41df-a39b-697f7c2e54a2","slug":"cha-de-fralda","nome":"Chá de fralda","descricao":"Uma seleção prática","imageUrl":null,"position":0,"ativo":true,"quantidadeItens":1,"criadoEm":"2026-07-27T12:00:00.000Z","atualizadoEm":"2026-07-27T12:00:00.000Z","items":[{"idProduto":"5ee01433-f760-4fab-97dc-cd55154918ee","quantidade":3,"position":0}]}

// admin.catalog.createList
{"nome":"Lista enxoval","descricao":null,"imageUrl":null}
// output: ListaAdminDTO with slug=null, ativo=true and a server-owned position

// admin.catalog.updateList
{"id":"ad4aa121-550d-41df-a39b-697f7c2e54a2","descricao":null}
// output: ListaAdminDTO with descricao=null

// admin.catalog.setListAtivo
{"id":"ad4aa121-550d-41df-a39b-697f7c2e54a2","ativo":false}
// output: ListaAdminDTO with ativo=false

// admin.catalog.setListItems
{"idLista":"ad4aa121-550d-41df-a39b-697f7c2e54a2","items":[{"idProduto":"5ee01433-f760-4fab-97dc-cd55154918ee","quantidade":3,"position":0}]}
// output
{"updated":true}

// admin.catalog.emitirUrlUploadImagemProduto
{"contentType":"image/png"}
{"uploadUrl":"https://storage.example/upload-signed","objectKey":"catalogo/produtos/50f01c31-e37f-45ac-b62b-3af7230663b4.png","publicUrl":"https://storage.example/catalog/catalogo/produtos/50f01c31-e37f-45ac-b62b-3af7230663b4.png"}
```

## Public procedures

Both procedures are queries, unauthenticated, read-only and belong to traffic tier
`public-read-unthrottled`.

### `catalogo.listSections`

Input: none.

Success: `ListaCatalogSectionDTO[]`. Only active products are returned. Sections are ordered by
category position and UUID tie-break; items are ordered by product position and UUID tie-break.
Categories with no active products are omitted.

Example:

```json
[
  {
    "category": "fraldas",
        "label": "Fraldas",
    "items": [
      {
        "id": "5ee01433-f760-4fab-97dc-cd55154918ee",
        "name": "Fralda RN",
        "price": 29.9,
        "suggestedQty": 1,
        "emoji": "🧷",
        "bgColor": "var(--pink-soft)",
        "category": "fraldas",
        "imageUrl": "/products/558361.png",
        "popularity": 10
      }
    ]
  }
]
```

### `catalogo.listListasProntas`

Input: none.

Success: `Record<string, ListaProntaDetailDTO>`. Only active lists and active products are
returned. An active list remains present with `items: []` when all assigned products are inactive.
List and item order follow persisted positions with UUID tie-breaks.

Example:

```json
{
  "cha-de-fralda": {
    "id": "cha-de-fralda",
    "title": "Chá de fralda",
    "description": "Uma seleção prática",
    "imageUrl": "/listas-prontas/lista-12.jpg",
    "items": [
      {
        "id": "5ee01433-f760-4fab-97dc-cd55154918ee",
        "name": "Fralda RN",
        "price": 29.9,
        "suggestedQty": 3,
        "emoji": "🧷",
        "bgColor": "var(--pink-soft)",
        "imageUrl": "/products/558361.png"
      }
    ]
  }
}
```

Unexpected repository failures propagate as `INTERNAL_SERVER_ERROR`; neither procedure converts an
error into `[]` or `{}`.

## Frontend migration requirements

- Catalog product IDs are UUIDs. The current `ListaPresentesBody` hashes legacy item IDs to invent
  quantities; F2 must remove that behavior and use each API item's `suggestedQty` for both display
  and persistence. Curated-list quantities come from the list-item relation.
- Ready-list tiles must be enumerated from the returned record. The fixed five-entry
  `LISTA_PRONTAS` array and closed `ListaProntaId` union are retired; client IDs become `string`.
  Lists without legacy presentation metadata use a documented neutral fallback emoji and tile
  token.
- Fetch failures remain errors. They are never translated to empty sections or empty ready-list
  records.
