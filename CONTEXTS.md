# Contextos da engine — documentação consolidada

Este arquivo reúne a documentação dos **bounded contexts** já implementados na engine de intermediação financeira (skeleton Frame). A **Plataforma** é o BC fundacional **multi-tenant**: todo Usuário, Campanha, Sessão e regra de Taxa pertence a exatamente uma plataforma (eunenem, eucasei, ...). A seguir vem o fluxo natural do negócio: arrecadação → taxas → pagamentos (com o **módulo Financeiro** aninhado dentro), com **usuário** como contexto transversal de administração. Por fim, **Checkout** é um pseudo-BC de orquestração (apenas casos de uso + erros, sem domínio nem adaptadores próprios) que costura os BCs em sagas com compensação.

**Mudanças estruturais recentes (junho/2026):**

- **Plan 0015 — colapso Contribuição/Pagamento/Financeiro:** Contribuição virou *slot puro* (sem `status` enum, sem snapshot do contribuinte); Pagamento ganhou FSM de 5 estados (`pendente | processing | aprovado | rejeitado | estornado`); LancamentoFinanceiro perdeu o FSM e passou a usar **colunas de data observada** (`transferidoEm`, `canceladoEm`) — os "estados" pendente/transferido/cancelado viraram predicados de consulta. **Financeiro** deixou de ser BC top-level e virou **módulo aninhado dentro de Pagamentos** (`src/domain/pagamentos/financeiro/`). Plano-fonte: [`plans/0015-contribuicao-pagamento-financeiro-collapse.md`](plans/0015-contribuicao-pagamento-financeiro-collapse.md).
- **BetterAuth (Pattern A — Infrastructure Adapter):** o domínio Usuário recebeu uma porta `AuthService` (`src/adapters/usuario/auth-service.ts`) com dois adaptadores — `AuthServiceMemoria` (testes/dev) e `AuthServiceBetterAuth` (produção). A uniqueness composta `(idPlataforma, email)` foi preservada tanto no domínio quanto no schema BetterAuth. `eunenem-server` monta `auth.handler` (Hono) + procedures tRPC (`signUp / signIn / signOut / me`).
- **RepasseRecebedor (aperture-s03dr):** FSM de 2 estados (`solicitado → aprovado`, forward-only), com índice único parcial garantindo no máximo 1 repasse `solicitado` por campanha.

**Persistência hoje:** **Arrecadação**, **Pagamentos** (incluindo o módulo **Financeiro**), **Plataforma**, **Taxas**, **Usuário** e **Evento** têm adaptadores em memória; **Arrecadação**, **Pagamentos / Financeiro**, **Usuário** (incluindo as 5 tabelas BetterAuth) têm também adaptadores **Postgres** (Kysely). **Evento** segue só em memória na fase 1.

---

## Índice

1. [BC Plataforma](#bc-plataforma--o-que-foi-implementado)
2. [BC Arrecadação](#bc-arrecadação--o-que-foi-implementado)
3. [BC Taxas](#bc-taxas--o-que-foi-implementado)
4. [BC Pagamentos](#bc-pagamentos--o-que-foi-implementado)
5. [Módulo Financeiro (dentro de Pagamentos)](#módulo-financeiro-dentro-de-pagamentos--o-que-foi-implementado)
6. [BC Usuário](#bc-usuário--o-que-foi-implementado)
7. [BC Evento (supporting)](#bc-evento-supporting--fase-1)
8. [Orquestração — Checkout (pseudo-BC)](#orquestração--checkout-pseudo-bc)

---

# BC Plataforma — o que foi implementado

Este documento descreve o **bounded context Plataforma** — a fronteira **multi-tenant** da engine. Cada plataforma (eunenem, eucasei, ...) é um produto white-label rodando sobre a mesma engine, com **sua própria base de usuários, suas próprias campanhas e sua própria política de taxas**. Os demais BCs trazem a referência por **mirror VO** (`IdPlataformaReferencia`); o domínio deles nunca importa de `src/domain/plataforma/`.

## Resumo em linguagem simples

1. Uma **Plataforma** representa um produto white-label (ex.: `eunenem`, `eucasei`). Tem `id` (UUID), `slug` (identificador legível, único), `nome` (exibição) e `criadaEm`.
2. O ciclo de vida (criar, suspender, arquivar) é **deferido** — hoje as plataformas são **seedadas** em memória e o repositório expõe apenas leitura (`findById`, `findBySlug`, `listAtivas`).
3. Duas plataformas seed estão disponíveis para desenvolvimento e testes: **EuNenem** (`ID_PLATAFORMA_EUNENEM`) e **EuCasei** (`ID_PLATAFORMA_EUCASEI`), com UUIDs determinísticos para reprodutibilidade entre runs.
4. Outros BCs **não importam** `Plataforma` nem `IdPlataforma`. Eles trazem um **mirror VO** local — `IdPlataformaReferencia` — com o mesmo shape (UUID). A separação é enforçada pelo `dependency-cruiser`.
5. O BC valida referências: quando Arrecadação cria uma campanha ou Usuário registra uma conta, o caso de uso consulta `plataformaRepository.findById` e falha com erro tipado se a plataforma não existir.

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Plataforma (agregado raiz) | [`src/domain/plataforma/entities/plataforma.ts`](src/domain/plataforma/entities/plataforma.ts) — `Plataforma`, `criarPlataforma` |
| Identificador da Plataforma (UUID) | [`src/domain/plataforma/value-objects/ids.ts`](src/domain/plataforma/value-objects/ids.ts) — `IdPlataforma`, `IdPlataformaSchema` |
| Slug da Plataforma (legível, único) | [`src/domain/plataforma/value-objects/slug-plataforma.ts`](src/domain/plataforma/value-objects/slug-plataforma.ts) — `SlugPlataforma`, `SlugPlataformaSchema` |
| Porta de persistência (read-only por enquanto) | [`src/adapters/plataforma/repository.ts`](src/adapters/plataforma/repository.ts) — `PlataformaRepository` |
| Adaptador em memória + plataformas seed | [`src/adapters/plataforma/repository.memory.ts`](src/adapters/plataforma/repository.memory.ts) — `PlataformaRepositoryMemory`, `PLATAFORMAS_SEED`, `ID_PLATAFORMA_EUNENEM`, `ID_PLATAFORMA_EUCASEI` |
| Erro tipado (plataforma não encontrada) | [`src/errors/plataforma/nao-encontrada.error.ts`](src/errors/plataforma/nao-encontrada.error.ts) — `PlataformaNaoEncontradaError` |
| API pública do pacote | [`src/index.ts`](src/index.ts) — seção `// --- Domain: Plataforma ---` |

---

## DDD

- **Bounded context:** o vocabulário `Plataforma`, `IdPlataforma`, `SlugPlataforma` vive aqui; não há campanhas, taxas, pagamentos ou usuários no domínio da Plataforma.

- **Agregado:** `Plataforma` é uma raiz **sem entidades-filhas internas**. O ciclo de vida é minimalista (criar + ler) porque o BC funciona hoje como um catálogo seedado.

- **Value Objects:** `IdPlataforma` (UUID) e `SlugPlataforma` (regex `[a-z][a-z0-9-]{2,29}`, único). O slug é o que aparece em URLs, config e conversas humanas; o id é a referência persistente.

- **Repositório (porta + adaptador):** `PlataformaRepository` expõe apenas leitura — `findById`, `findBySlug`, `listAtivas`. `PlataformaRepositoryMemory` carrega `PLATAFORMAS_SEED` no construtor (sobrescritível em testes).

- **Mirror VOs cross-BC:** Arrecadação, Taxas e Usuário definem cada um o seu `IdPlataformaReferencia` (mesmo shape UUID), garantindo que nenhum domínio importe do outro. A regra é enforçada pelo `.dependency-cruiser.cjs`.

- **Integração:** casos de uso de outros BCs que dependem da existência de uma plataforma (ex.: `registrarContaUsuario`, `criarCampanha`) recebem `plataformaRepository` nas deps e consultam `findById` como gate de validação, lançando um erro tipado próprio se a plataforma não existir (`UsuarioPlataformaNaoEncontradaError`, `ArrecadacaoPlataformaNaoEncontradaError`).

- **Invariantes (didático):** plataformas seedadas têm UUIDs determinísticos para evitar drift entre testes; o slug é único entre plataformas ativas.

---

## O que Plataforma não conhece

Plataforma não conhece:

- Usuário, conta, sessão, permissão
- Campanha, contribuição, recebedor
- Regra de taxa, composição de valores
- Pagamento, intenção, provedor
- Lançamento financeiro, repasse

Ela conhece apenas o necessário para servir de **referência multi-tenant**:

- `id`, `slug`, `nome`, `criadaEm`

Tudo que diz respeito ao que cada plataforma **faz** (suas campanhas, seus usuários, sua taxa) vive nos BCs respectivos, ligado por `IdPlataformaReferencia`.

---

# BC Arrecadação — o que foi implementado

Este documento descreve a primeira fatia da **engine de intermediação financeira** no repositório (skeleton Frame): o **bounded context Arrecadação**, com adaptadores em memória e **Postgres** (Kysely), sem autenticação real. O objetivo é aprender DDD vendo o código.

## Resumo em linguagem simples

1. Um ou mais **administradores** (UUIDs de conta) abrem uma **campanha** com título e registram o **recebedor** externo (nome + chave PIX em `dadosRecebedor`); o saldo no Financeiro agrega por `id` da campanha (`idCampanha`). Alterações de PIX desativam o recebedor ativo e criam nova linha em `recebedores` (`is_active`).
2. A campanha começa sem **opções de contribuição** (sacolas); o administrador adiciona opções só com `tipo`: `presente`, `rifa` ou `convite`.
3. O administrador cria **itens de contribuição** dentro de uma opção (`nome`, `valor` em centavos, `quantidade` em unidades — inteiro positivo, default 1). Pós-Plan 0015 + Plan 0016, **Contribuição é um slot puro com cardinalidade**: campos `id, idCampanha, idOpcaoContribuicao, nome, valor, imagemUrl, grupo, quantidade, criadaEm` — **sem `status` enum e sem snapshot do contribuinte**.
4. Uma slot com `quantidade > 1` representa **N exemplares fungíveis da mesma coisa** (5 taças de vinho, 12 convites VIP). Antes do Plan 0016 o workaround era criar 5 rows idênticas; agora a cardinalidade é um campo. O badge **`esgotada`** é derivado da soma de `quantidade` em items de pagamentos aprovados — não é estado armazenado.
5. Um **contribuinte visitante** (sem conta) monta um **carrinho** com um ou mais itens e segue para o checkout. Os dados do contribuinte (`nome`, **email obrigatório**, mensagem opcional) vivem no **snapshot `contribuinte` da `IntencaoPagamento`** (BC Pagamentos), não na Contribuição. Cada linha do carrinho vira um `ItemDoPagamento` dentro da IntencaoPagamento, carregando `idContribuicao` + `quantidade` + composição por-linha.
6. **"Indisponível" virou um par de predicados derivados** (Plan 0016 substituiu o predicado boolean único de 0015):
   - [`quantidadeRestante(idContribuicao)`](src/use-cases/arrecadacao/quantidade-restante.ts) — `contribuicao.quantidade − SUM(item.quantidade)` sobre items em pagamentos `aprovado`. Pode retornar **≤ 0** (overshoot é aceito por design: se 5 taças listadas viraram 7 vendidas em corrida concorrente, `restante = -2`, ninguém é estornado, operador embolsa o +dinheiro).
   - [`esgotada(idContribuicao)`](src/use-cases/arrecadacao/quantidade-restante.ts) — derivado: `quantidadeRestante(c) ≤ 0`. Usado pelo gate da saga `iniciarPagamentoCarrinho` (ver Checkout).
   Relação **1:N** contribuição→pagamentos permitida com concorrência otimista (mesma postura do Plan 0015, agora aplicada por-item via `SUM(quantidade)`).

Nada disso cobra pagamento nem calcula taxa — isso fica em outros bounded contexts.

---

## Schema Postgres

| Tabela | Colunas principais | Notas |
|--------|-------------------|--------|
| `campanhas` | `id`, `titulo`, `criada_em` | Metadados da campanha |
| `recebedores` | `id`, `campanha_id`, dados PIX, `is_active`, `criada_em` | Histórico de recebedores; 1 ativo por campanha |
| `campanha_administradores` | `campanha_id`, `id_usuario` | PK composta; `id_usuario` ↔ `IdConta` no domínio |
| `opcoes_contribuicao` | `id`, `campanha_id`, `tipo` | Sacola por `tipo`: `presente` \| `rifa` \| `convite` |
| `contribuicoes` | `id`, `campanha_id`, `id_opcao_contribuicao`, `nome`, `valor`, `imagem_url`, `grupo`, `quantidade`, `criada_em` | **Pós-Plan 0015 + Plan 0016**: sem `status`, sem colunas `contribuinte_*`. Slot puro com cardinalidade — `quantidade INTEGER NOT NULL DEFAULT 1 CHECK (quantidade >= 1)`. Esgotada é predicado de consulta `SUM(intencao_items.quantidade) >= contribuicao.quantidade` sobre items de pagamentos aprovados. FKs `ON DELETE RESTRICT`. |

Migrations: [`migrations/20260519_001_create_arrecadacao.ts`](migrations/20260519_001_create_arrecadacao.ts), [`migrations/20260520_002_alter_arrecadacao_sacola_itens.ts`](migrations/20260520_002_alter_arrecadacao_sacola_itens.ts), [`migrations/20260521_003_recebedores_versionados.ts`](migrations/20260521_003_recebedores_versionados.ts), [`migrations/20260522_004_drop_recebedores_id_carteira.ts`](migrations/20260522_004_drop_recebedores_id_carteira.ts).

Adaptadores Postgres exportados também pelo subpath `frame/adapters/postgres` (não no `src/index.ts` público).

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Montante em centavos (evitar `number` em reais) | [`src/domain/money.ts`](src/domain/money.ts) — `MoneyCentsSchema` |
| Campanha, administradores, projeção do recebedor ativo (`dadosRecebedor`), opção de contribuição | [`src/domain/arrecadacao/entities/campanha.ts`](src/domain/arrecadacao/entities/campanha.ts) — `Campanha`, `DadosRecebedor`, `OpcaoContribuicao` |
| Recebedor (PIX auditável, versionado) | [`src/domain/arrecadacao/entities/recebedor.ts`](src/domain/arrecadacao/entities/recebedor.ts) — `Recebedor`, `criarRecebedorInicial`, `criarNovoRecebedor`, `desativarRecebedor` |
| Persistência Postgres do recebedor | [`src/adapters/arrecadacao/recebedor-repository.postgres.ts`](src/adapters/arrecadacao/recebedor-repository.postgres.ts) — `RecebedorRepositoryPostgres` |
| Procurar opção na campanha (função pura) | [`src/domain/arrecadacao/entities/campanha.ts`](src/domain/arrecadacao/entities/campanha.ts) — `campanhaComOpcao` |
| Contribuição (slot puro com cardinalidade, pós-0015/0016) | [`src/domain/arrecadacao/entities/contribuicao.ts`](src/domain/arrecadacao/entities/contribuicao.ts) — `Contribuicao` (carrega `quantidade: number`), `criarContribuicao`, `contribuicaoAtualizada` |
| Dados do contribuinte (compartilhado com Pagamentos) | [`src/domain/pagamentos/value-objects/dados-contribuinte.ts`](src/domain/pagamentos/value-objects/dados-contribuinte.ts) — `DadosContribuinte`. **Mudou de BC** no Plan 0015; re-export deprecado em `src/domain/arrecadacao/value-objects/dados-contribuinte.ts`. |
| Persistência em memória da campanha | [`src/adapters/arrecadacao/campanha-repository.memory.ts`](src/adapters/arrecadacao/campanha-repository.memory.ts) |
| Persistência Postgres da campanha | [`src/adapters/arrecadacao/campanha-repository.postgres.ts`](src/adapters/arrecadacao/campanha-repository.postgres.ts) — `CampanhaRepositoryPostgres` |
| Persistência em memória das contribuições | [`src/adapters/arrecadacao/contribuicao-repository.memory.ts`](src/adapters/arrecadacao/contribuicao-repository.memory.ts) |
| Persistência Postgres das contribuições | [`src/adapters/arrecadacao/contribuicao-repository.postgres.ts`](src/adapters/arrecadacao/contribuicao-repository.postgres.ts) — `ContribuicaoRepositoryPostgres` |
| Schema relacional (migrations) | [`migrations/20260519_001_create_arrecadacao.ts`](migrations/20260519_001_create_arrecadacao.ts) — `campanhas`, `campanha_administradores` (`id_usuario`), `opcoes_contribuicao` (`tipo`), `contribuicoes` |
| Testes de integração Postgres | [`tests/integration/campanha-repository.postgres.test.ts`](tests/integration/campanha-repository.postgres.test.ts), [`tests/integration/contribuicao-repository.postgres.test.ts`](tests/integration/contribuicao-repository.postgres.test.ts) |
| Portas (interfaces) | [`src/adapters/arrecadacao/campanha-repository.ts`](src/adapters/arrecadacao/campanha-repository.ts) — `CampanhaRepository`; [`src/adapters/arrecadacao/contribuicao-repository.ts`](src/adapters/arrecadacao/contribuicao-repository.ts) — `ContribuicaoRepository` |
| Caso de uso: criar campanha | [`src/use-cases/arrecadacao/criar-campanha.ts`](src/use-cases/arrecadacao/criar-campanha.ts) — `criarCampanha` |
| Caso de uso: adicionar/remover administrador | [`adicionar-administrador-campanha.ts`](src/use-cases/arrecadacao/adicionar-administrador-campanha.ts), [`remover-administrador-campanha.ts`](src/use-cases/arrecadacao/remover-administrador-campanha.ts) |
| Caso de uso: alterar dados do recebedor (desativa + cria nova linha versionada) | [`src/use-cases/arrecadacao/alterar-dados-recebedor-campanha.ts`](src/use-cases/arrecadacao/alterar-dados-recebedor-campanha.ts) — `alterarDadosRecebedorCampanha` |
| Caso de uso: adicionar opção (sacola) | [`src/use-cases/arrecadacao/adicionar-opcao-contribuicao.ts`](src/use-cases/arrecadacao/adicionar-opcao-contribuicao.ts) — `adicionarOpcaoContribuicao` |
| Caso de uso: criar item de contribuição (admin) | [`src/use-cases/arrecadacao/criar-contribuicao.ts`](src/use-cases/arrecadacao/criar-contribuicao.ts) — `criarContribuicao` |
| Caso de uso: criar contribuições em lote (admin) | [`src/use-cases/arrecadacao/criar-contribuicoes-em-lote.ts`](src/use-cases/arrecadacao/criar-contribuicoes-em-lote.ts) — `criarContribuicoesEmLote` |
| Caso de uso: atualizar contribuição (admin) | [`src/use-cases/arrecadacao/atualizar-contribuicao.ts`](src/use-cases/arrecadacao/atualizar-contribuicao.ts) — `atualizarContribuicao` (substitui `alterar-valor-contribuicao` parcialmente) |
| Caso de uso: remover contribuição (admin) | [`src/use-cases/arrecadacao/remover-contribuicao.ts`](src/use-cases/arrecadacao/remover-contribuicao.ts) — `removerContribuicao` |
| Caso de uso: predicados de cardinalidade (substitui o predicado boolean único de 0015) | [`src/use-cases/arrecadacao/quantidade-restante.ts`](src/use-cases/arrecadacao/quantidade-restante.ts) — `quantidadeRestante(idContribuicao)` retorna `contribuicao.quantidade − SUM(item.quantidade WHERE pagamento.status='aprovado')` (pode ser ≤ 0, overshoot aceito); `esgotada(idContribuicao)` retorna `quantidadeRestante ≤ 0`. Consulta `pagamentoRepository.somarQuantidadesContribuicoesEmPagamentosAprovados`. |
| Caso de uso: listar contribuições da opção (admin) | [`src/use-cases/arrecadacao/listar-contribuicoes-de-opcao.ts`](src/use-cases/arrecadacao/listar-contribuicoes-de-opcao.ts) |
| Caso de uso: transação atômica multi-aggregate | [`src/use-cases/arrecadacao/executar-transacao-arrecadacao.ts`](src/use-cases/arrecadacao/executar-transacao-arrecadacao.ts) |
| Erros de domínio / aplicação | [`src/errors/arrecadacao/`](src/errors/arrecadacao) |

**Casos de uso deletados pelo Plan 0015** (não pesquise por eles; foram removidos): `associar-contribuinte-contribuicao.ts`, `desassociar-contribuinte-contribuicao.ts`. A associação contribuinte→contribuição deixou de existir como estado armazenado; o snapshot do contribuinte agora vive na `IntencaoPagamento` (BC Pagamentos), populado pelo webhook `checkout.session.completed`.
| API pública do pacote (re-exports) | [`src/index.ts`](src/index.ts) |
| Testes unitários | [`tests/unit/money.test.ts`](tests/unit/money.test.ts), [`tests/unit/arrecadacao/campanha.test.ts`](tests/unit/arrecadacao/campanha.test.ts), [`tests/unit/arrecadacao/contribuicao.test.ts`](tests/unit/arrecadacao/contribuicao.test.ts), [`tests/unit/arrecadacao/casos-de-uso.test.ts`](tests/unit/arrecadacao/casos-de-uso.test.ts) |

---

## DDD

- **Bounded context (contexto delimitado):** arquivos na subpasta `arrecadacao/` em domínio, adaptadores, erros e casos de uso. Toda a linguagem (campanha, opção, contribuição) vive aqui; não aparecem “pagamentos” ou “taxas” neste BC. **O snapshot do contribuinte** deixou de ser cidadão deste BC no Plan 0015 — vive agora em Pagamentos (`IntencaoPagamento.contribuinte`).

- **Ubiquitous language (linguagem ubíqua):** os nomes em TypeScript (`Campanha`, `OpcaoContribuicao`, `criarContribuicao`) alinham com a conversa de produto em [`ENGINE-DDD.md`](ENGINE-DDD.md).

- **Value object:** `MoneyCents` (via schema). Os value objects da pasta `value-objects/` cobrem `DadosRecebedor`, `OpcaoContribuicao` e os identificadores. `DadosContribuinte` sobrevive aqui como re-export deprecado apontando para `src/domain/pagamentos/value-objects/dados-contribuinte.ts`.

- **Entidade:** `Campanha`, `Recebedor` e `Contribuicao` têm **id** estável. Pós-0015, **`Contribuicao` é stateless**: não tem ciclo de vida (sem `status` enum, sem transições), só patches de admin (nome, valor, imagemUrl, grupo). A campanha continua tendo ciclo de vida (adicionar opções, alterar recebedor ativo).

- **Agregado:** a **Campanha** é a raiz com **opções** (sacolas por `tipo`). Cada **Contribuição** é um slot persistido à parte, referenciando `idCampanha` e `idOpcaoContribuicao` (herda o `tipo` da sacola sem duplicar no domínio). **`Recebedor`** é uma raiz versionada própria (uma linha por versão, `is_active` marcando o atual).

- **Repositório (padrão):** `CampanhaRepository`, `ContribuicaoRepository` e `RecebedorRepository` são portas; Postgres faz upsert de campanha/opções e upsert de contribuições. Administradores usam coluna `id_usuario` ↔ `IdConta`.

- **Caso de uso / serviço de aplicação:** validação Zod, invariantes (opção duplicada, exatamente um recebedor ativo por campanha) e persistência.

- **Invariantes (pós-Plan 0015 + Plan 0016):** opção com `id` único na campanha; contribuição nasce e permanece como slot (sem estado próprio); `quantidade ≥ 1` enforçada por schema + CHECK no DB; "esgotada" é predicado de consulta (`quantidadeRestante ≤ 0`, derivado de `SUM(item.quantidade)` em items aprovados); 1:N contribuição→pagamentos permitido (concorrência otimista por-item, sem reserva de slot, overshoot aceito).

---

# BC Taxas — o que foi implementado

Este documento descreve a primeira fatia do **bounded context Taxas** na engine de intermediação financeira: cálculo em memória, sem base de dados nova, sem integração real com pagamentos e sem substituir o domínio placeholder `Cat`.

## Resumo em linguagem simples

1. O contexto **Taxas** recebe uma referência pública de contribuição e o valor da contribuição em centavos.
2. A regra ativa nesta fase é uma taxa percentual fixa de **5%**, paga pelo **contribuinte**.
3. O domínio calcula a taxa e devolve uma **composição de valores**: contribuição, taxa, total pago, valor destinado ao recebedor e responsável pela taxa.

Exemplo canônico:

- Valor da contribuição: R$ 80,00 (`8000` centavos)
- Taxa de 5%: R$ 4,00 (`400` centavos)
- Total pago pelo contribuinte: R$ 84,00 (`8400` centavos)
- Valor destinado ao recebedor: R$ 80,00 (`8000` centavos)

Como a taxa é paga pelo contribuinte, ela é somada ao total cobrado e não é descontada do recebedor.

---

## Mapa conceito de negócio → código

- **Montante em centavos:** `src/domain/money.ts` — `MoneyCentsSchema`
- **Regra de Taxa (raiz do agregado):** [`src/domain/taxas/entities/regra-taxa.ts`](src/domain/taxas/entities/regra-taxa.ts) — `RegraTaxa`, `criarRegraTaxa`, `obterTarifaPorTipo`. Cada plataforma tem exatamente uma RegraTaxa ativa; estrutura é um record `tarifasPorTipo` keyed por `presente | rifa | convite`.
- **Tarifa por tipo (VO):** [`src/domain/taxas/value-objects/tarifa-tipo.ts`](src/domain/taxas/value-objects/tarifa-tipo.ts) — `TarifaTipo` (percentage em basis points + fixed amount; `responsavelTaxa: contribuinte`)
- **Cálculo de Taxa (função pura):** [`src/domain/taxas/value-objects/calculo-taxa.ts`](src/domain/taxas/value-objects/calculo-taxa.ts) — `calcularValorTaxaPercentual`, `calcularTaxa`
- **Composição de Valores:** [`src/domain/taxas/value-objects/composicao-valores.ts`](src/domain/taxas/value-objects/composicao-valores.ts) — `ComposicaoValores`, `comporComposicaoValores` (domínio); o use-case exportado como `calcularComposicaoValores` compõe contribuição + tarifa.
- **Identificadores:** [`src/domain/taxas/value-objects/ids.ts`](src/domain/taxas/value-objects/ids.ts) — `IdRegraTaxa`, mirror `IdPlataformaReferencia`
- **Porta para regra ativa:** [`src/adapters/taxas/regra-provider.ts`](src/adapters/taxas/regra-provider.ts) — `ProvedorRegraTaxa` (resolve por plataforma)
- **Regra em memória:** [`src/adapters/taxas/regra-provider.memory.ts`](src/adapters/taxas/regra-provider.memory.ts) — `ProvedorRegraTaxaMemory`
- **Caso de uso:** [`src/use-cases/taxas/calcular-composicao-valores.ts`](src/use-cases/taxas/calcular-composicao-valores.ts) — `calcularComposicaoValores`
- **Erro tipado:** `src/errors/taxas/input-invalido.error.ts` — `TaxasInputInvalidoError`
- **API pública:** `src/index.ts`
- **Testes unitários:** `tests/unit/taxas/`

---

## DDD

- **Bounded Context:** Taxas tem vocabulário próprio e não importa entidades ricas de Arrecadação. A contribuição entra apenas como `idContribuicao` e `contributionAmountCents`.

- **Linguagem Ubíqua:** os nomes `RegraTaxa`, `CalculoTaxa`, `ComposicaoValores`, `responsavelTaxa` e `receiverAmountCents` refletem diretamente a conversa de produto.

- **Value Object:** a composição de valores é um conjunto imutável de valores calculados. Dinheiro continua representado em centavos para evitar problemas de ponto flutuante em reais.

- **Função pura de domínio:** `calcularComposicaoValores` calcula a composição sem banco, HTTP, logs ou efeitos colaterais.

- **Porta e adapter:** `ProvedorRegraTaxa` é a porta; `ProvedorRegraTaxaMemory` é um adapter em memória que entrega a regra ativa de 5%.

- **Caso de uso / serviço de aplicação:** `calcularComposicaoValores` valida a entrada, busca a regra ativa, chama o domínio e registra observabilidade.

- **Invariantes:** com taxa paga pelo contribuinte, `totalPaidCents = contributionAmountCents + feeAmountCents` e `receiverAmountCents = contributionAmountCents`.

---

## Arredondamento

A taxa percentual é representada em **basis points** (`500` = 5%) para evitar `number` decimal como `0.05`.

Quando o cálculo gera fração de centavo, a implementação arredonda para cima com `Math.ceil`. Assim, uma contribuição de `101` centavos com taxa de 5% gera taxa de `6` centavos.

---

# BC Pagamentos — o que foi implementado

Este documento descreve o **bounded context Pagamentos** pós-Plan 0015 + Plan 0016: FSM de 5 estados ao nível Pagamento, **intenção de pagamento como carrinho multi-item** (`items: ItemDoPagamento[]` com discriminated union `contribuicao | passthrough_surcharge`), snapshot do contribuinte populado por webhook, provedores reais (Stripe, Pagarme, Fake) atrás de uma porta, persistência **em memória + Postgres**, e o **módulo Financeiro aninhado** (`src/domain/pagamentos/financeiro/`) que itera per-item para emitir lançamentos. Inclui o **módulo Financeiro** em capítulo separado abaixo.

## Resumo em linguagem simples

1. O contexto **Pagamentos** recebe um **carrinho** (lista de items + composição agregada já calculada por **Taxas**) e o `idCampanha` do carrinho (BC Arrecadação).
2. Ele cria uma **`IntencaoPagamento`** carregando `items: ItemDoPagamento[]` (≥ 1 item, contribuição items primeiro + surcharge item por último em flows de cartão) + `composicaoValoresAggregate` (soma das linhas), e abre uma **sessão de checkout** no provedor (Stripe/Pagarme/Fake), cobrando exatamente o `totalPaidCents` agregado.
3. O pagamento nasce com status `pendente`.
4. Webhooks do provedor avançam o FSM em 5 estados (o FSM opera sobre o Pagamento como um todo, **não por item**):
   - **`pendente → processing`** (PIX): `payment_intent.processing` (QR escaneado, aguardando confirmação bancária)
   - **`pendente → aprovado`** (cartão happy path) ou **`processing → aprovado`** (PIX confirmado pelo banco)
   - **`pendente|processing → rejeitado`** (falha cedo ou no meio do fluxo)
   - **`aprovado → estornado`** (refund total via `charge.refunded`; whole-pagamento only, sem refund por-item)
5. No webhook `checkout.session.completed`, o **snapshot do contribuinte** (nome, email, mensagem) é gravado em `IntencaoPagamento.contribuinte` (raiz da intencão, não por-item — uma checkout-session tem um contribuinte) — esse é o ponto onde os dados do visitante entram no sistema.
6. Quando o pagamento vai a `aprovado`, o **módulo Financeiro** (próxima seção) **itera sobre os items** para emitir lançamentos contábeis na mesma transação.

Pagamentos não calcula taxa. Ele só confere se o `totalPaidCents` agregado bate com a soma das linhas dos items.

---

## FSM de Pagamento (Plan 0015)

```
                       pendente
                          │
              ┌───────────┼───────────┐
              │           │           │
              ▼           ▼           ▼
         processing   aprovado    rejeitado    (terminal)
              │           │
              │           ▼
              │       estornado    (terminal)
              ▼
        aprovado / rejeitado
```

Definido em [`src/domain/pagamentos/entities/pagamento.ts`](src/domain/pagamentos/entities/pagamento.ts) (`StatusPagamentoSchema`). Funções puras de transição:

- `iniciarProcessamentoPagamento` (`pendente → processing`, PIX-only, idempotente)
- `aprovarPagamentoPendente` (`pendente|processing → aprovado`)
- `rejeitarPagamentoPendente` (`pendente|processing → rejeitado`)
- `estornarPagamentoAprovado` (`aprovado → estornado`; gateada por pré-check "nenhum lançamento já transferido")

`charge.refunded` parcial **não** muda o estado (decisão travada pela operação); `charge.dispute.created` é auditado mas não transiciona.

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Montante em centavos | [`src/domain/money.ts`](src/domain/money.ts) — `MoneyCentsSchema` |
| **Pagamento (agregado raiz)** | [`src/domain/pagamentos/entities/pagamento.ts`](src/domain/pagamentos/entities/pagamento.ts) — `Pagamento`, `criarPagamentoPendente`, transições FSM, predicados (`podeAprovarPagamento`, `podeRejeitarPagamento`) |
| **IntencaoPagamento** (entidade aninhada — raiz do carrinho) | [`src/domain/pagamentos/entities/pagamento.ts`](src/domain/pagamentos/entities/pagamento.ts) — `IntencaoPagamento`. Campos pós-0016: `id, idCampanha` (hoisted — invariante "todos os items do carrinho na mesma campanha"), `items: readonly ItemDoPagamento[]` (≥ 1, contribuição items primeiro + surcharge por último em cartão), `composicaoValoresAggregate` (soma das linhas + `idCampanha` + `responsavelTaxa`), `metodo, externalRef` (Stripe checkout session), `paymentIntentExternalRef` (`pi_xxx`), `chargeExternalRef` (`ch_xxx`), **`contribuinte: DadosContribuinte \| null`** (nullable na criação, populado pelo webhook `checkout.session.completed` — raiz, não por-item), `balanceTransactionAvailableOn: Date \| null` (data de liberação do Stripe — gate do módulo Financeiro para "marcar transferido") |
| **ItemDoPagamento** (entidade aninhada dentro de IntencaoPagamento, novo no Plan 0016) | [`src/domain/pagamentos/entities/item-do-pagamento.ts`](src/domain/pagamentos/entities/item-do-pagamento.ts) — **discriminated union** por `tipo`:<br/>• `tipo='contribuicao'` → carrega `idContribuicao, quantidade: number, composicaoValoresItem` (com per-unit + per-line denormalizado: `contributionUnitAmountCents` + `lineContributionAmountCents`, etc.)<br/>• `tipo='passthrough_surcharge'` → carrega `idContribuicao: null, quantidade: 1, composicaoValoresItem` com `amountCents` único.<br/>Ordem posição-estável: contribuição items primeiro (na ordem do chamador), surcharge **sempre por último** quando presente. Naming "Do" (vs no-connector como `EventoPagamento`) sinaliza entity-com-identidade-dentro-do-agregado — vide [`docs/ddd-conventions.md`](docs/ddd-conventions.md). |
| TransacaoExterna (entidade aninhada — settlement do provedor) | [`src/domain/pagamentos/entities/pagamento.ts`](src/domain/pagamentos/entities/pagamento.ts) — `TransacaoExterna` (`status`: `aprovado` \| `rejeitado`, com `statusBruto` do provedor) |
| Status FSM | [`src/domain/pagamentos/entities/pagamento.ts`](src/domain/pagamentos/entities/pagamento.ts) — `StatusPagamentoSchema` (`pendente \| processing \| aprovado \| rejeitado \| estornado`). FSM atua sobre Pagamento como um todo; items não têm FSM próprio. |
| Método de Pagamento | [`src/domain/pagamentos/value-objects/`](src/domain/pagamentos/value-objects/) — `MetodoPagamento` (`pix \| credit_card`) |
| Snapshot composição (por-item + agregada) | [`src/domain/pagamentos/value-objects/`](src/domain/pagamentos/value-objects/) — `SnapshotComposicaoValoresItem` (discriminated union espelhando o item tipo) + `SnapshotComposicaoValoresAggregate` (sum across items: `totalContributionCents`, `totalFeeCents`, `totalReceiverCents`, `totalSurchargeCents`, `totalPaidCents`, `idCampanha`, `responsavelTaxa`). Invariante de livro: `totalReceiverCents + totalFeeCents + totalSurchargeCents === totalPaidCents`. **O campo asymmetric de surcharge na raiz da IntencaoPagamento foi aposentado pelo Plan 0016** — surcharge agora é item próprio (`tipo='passthrough_surcharge'`). |
| **DadosContribuinte** (movido de Arrecadação pelo Plan 0015) | [`src/domain/pagamentos/value-objects/dados-contribuinte.ts`](src/domain/pagamentos/value-objects/dados-contribuinte.ts) — nome, email, mensagem (recadinho), … |
| Porta de persistência | [`src/adapters/pagamentos/repository.ts`](src/adapters/pagamentos/repository.ts) — `PagamentoRepository` (inclui `somarQuantidadesContribuicoesEmPagamentosAprovados` usado pelos predicados `quantidadeRestante`/`esgotada`) |
| Adaptador em memória | [`src/adapters/pagamentos/repository.memory.ts`](src/adapters/pagamentos/repository.memory.ts) |
| Adaptador Postgres | [`src/adapters/pagamentos/repository.postgres.ts`](src/adapters/pagamentos/repository.postgres.ts) |
| Porta do provedor de pagamento | [`src/adapters/pagamentos/provider.ts`](src/adapters/pagamentos/provider.ts) — `PagamentoProvider`, `CheckoutSessionProvider` |
| Adaptadores de provedor | `provider.fake.ts`, `provider.stripe.ts`, `provider.pagarme.ts` em `src/adapters/pagamentos/` |
| Webhook handler Stripe (consumer) | [`apps/eunenem-server/server/webhooks/stripe-webhook.ts`](apps/eunenem-server/server/webhooks/stripe-webhook.ts) — mapa de evento Stripe → transição FSM |
| Caso de uso: criar intenção | [`src/use-cases/pagamentos/criar-intencao-pagamento.ts`](src/use-cases/pagamentos/criar-intencao-pagamento.ts) — `criarIntencaoPagamento` |
| Caso de uso: aprovar pagamento | [`src/use-cases/pagamentos/aprovar-pagamento.ts`](src/use-cases/pagamentos/aprovar-pagamento.ts) — `aprovarPagamento` |
| Caso de uso: rejeitar pagamento | [`src/use-cases/pagamentos/rejeitar-pagamento.ts`](src/use-cases/pagamentos/rejeitar-pagamento.ts) — `rejeitarPagamento` |
| Caso de uso: consultar pagamento | [`src/use-cases/pagamentos/obter-pagamento-por-id.ts`](src/use-cases/pagamentos/obter-pagamento-por-id.ts) |
| Caso de uso: estornar pagamento (orquestrador) | [`src/use-cases/checkout/estornar-pagamento.ts`](src/use-cases/checkout/estornar-pagamento.ts) — vive em Checkout pois cruza Pagamentos + Financeiro (cascata em `canceladoEm`) |
| Erros tipados | [`src/errors/pagamentos/`](src/errors/pagamentos) |
| API pública | [`src/index.ts`](src/index.ts) — seção `Domain: Pagamentos` |

---

## DDD

- **Bounded Context:** Pagamentos tem linguagem própria: pagamento, intenção, transação externa, status FSM, provedor, evento. Ele não importa campanha, opção de contribuição, presente, rifa ou convite. A partir do Plan 0015, **também é o lar do `DadosContribuinte`** — o snapshot do contribuinte vive dentro da `IntencaoPagamento`, populado pelo webhook do provedor.

- **Contrato entre contextos:** Pagamentos recebe um **carrinho** (`{idCampanha, items: [...]}` com `items` carregando per-line `idContribuicao + quantidade + composiçãoItem`) e a composição agregada de Taxas. Devolve um `Pagamento` com FSM próprio + items posição-estáveis. O módulo Financeiro nested (próxima seção) reage à transição `→ aprovado` na **mesma transação DB** iterando per-item.

- **Agregado (nesting 3-níveis):** `Pagamento` (raiz) → `IntencaoPagamento` (entidade aninhada — carrinho + metadata do provedor + snapshot contribuinte) → `ItemDoPagamento[]` (entidades aninhadas — as linhas do carrinho). Toda a árvore é carregada e persistida como unidade pelo `PagamentoRepository`. Vide [`docs/ddd-conventions.md`](docs/ddd-conventions.md) seção "Aggregate Root vs nested Entity" para a justificativa do nesting (items não têm lifecycle independente, born + dies com a intencão; vocabulário não forka).

- **Value Object / Snapshot (per-item + agregado):** `SnapshotComposicaoValoresItem` é discriminated union espelhando `tipo`; `SnapshotComposicaoValoresAggregate` é a soma das linhas (denormalizada à criação para o ledger não recomputar). `DadosContribuinte` é VO que entra via webhook (não revalida nada da Arrecadação).

- **Portas e adapters:** `PagamentoRepository` (memória + Postgres), `PagamentoProvider` + `CheckoutSessionProvider` (Stripe, Pagarme, Fake) atrás de portas separadas.

- **Webhooks como driver do FSM:** os adaptadores HTTP do webhook lidam com idempotência (Stripe envia o mesmo evento N vezes em retries) — as transições FSM são guardadas por predicados (`podeAprovarPagamento` aceita `pendente|processing` mas é no-op se já está aprovado).

- **Invariantes:** carrinho deve ter ≥ 1 item; todos os items contribuição compartilham `idCampanha` (idêntico ao `IntencaoPagamento.idCampanha` raiz — backstop dual no factory + use-case); soma per-line bate com `totalPaidCents` agregado; um pagamento `estornado` é terminal (whole-pagamento only, sem refund per-item em v1); `rejeitado` é terminal; `processing` só existe para PIX; `IntencaoPagamento.contribuinte` é nullable até `checkout.session.completed` chegar; surcharge item, quando existe, é **sempre o último** da array de items.

---

## O que Pagamentos não conhece

Pagamentos não conhece:

- Campanha
- Opção de contribuição (presente / rifa / convite)
- Regras de taxa
- Detalhes da experiência de arrecadação

Ele conhece apenas o necessário para cobrar + arquivar settlement:

- `idCampanha` (raiz do carrinho)
- `items[]` (linhas com `idContribuicao` + `quantidade` por item contribuição; surcharge ítem standalone)
- Composição agregada (sum-of-lines)
- Método de pagamento
- Status FSM
- Metadados do provedor (`externalRef`, `paymentIntentExternalRef`, `chargeExternalRef`, `balanceTransactionAvailableOn`)
- Snapshot do contribuinte (após webhook)

---

# Módulo Financeiro (dentro de Pagamentos) — o que foi implementado

Este documento descreve o **módulo Financeiro**, **aninhado dentro do BC Pagamentos** desde o Plan 0015 (antes era BC top-level). O módulo registra os efeitos contábeis após `Pagamento → aprovado`, gerencia o saldo do recebedor, expõe a receita da plataforma e modela `RepasseRecebedor` como agregado próprio (FSM `solicitado → aprovado` introduzido em **aperture-s03dr**).

**Por que módulo e não BC?** A regra de teste de independência de ciclo de vida (vide [`docs/ddd-conventions.md`](docs/ddd-conventions.md)): nenhum `LancamentoFinanceiro` existe sem um `Pagamento` que o causa; a escrita do lançamento acontece na **mesma transação DB** que aprova o pagamento. Não há "ciclo de vida financeiro" paralelo ao do pagamento. O módulo nasce dentro de Pagamentos para refletir isso. `RepasseRecebedor`, ao contrário, tem ciclo de vida próprio (solicitação do recebedor, aprovação do admin) — é o único agregado-membro com lifecycle real do módulo.

## Resumo em linguagem simples

1. Quando um `Pagamento` vai a `aprovado`, o módulo Financeiro **itera sobre `intencao.items`** e emite lançamentos na mesma transação — emissão uniforme per-item, sem branch "+1 se cartão":
   | `item.tipo`             | Lançamentos emitidos                                                                  |
   | ----------------------- | -------------------------------------------------------------------------------------- |
   | `contribuicao`          | 2 — `credito_saldo_recebedor` (= `lineReceiverAmountCents`) + `credito_receita_plataforma` (= `lineFeeAmountCents`) |
   | `passthrough_surcharge` | 1 — `credito_passthrough_surcharge` (= `amountCents`)                                 |

   **Total por pagamento = 2N + S** (N items contribuição + S items surcharge). PIX flows: S = 0. Cartão flows: S = 1 (locked decision #11 do Plan 0016).

2. **Contabilidade do saldo do banco:** `credito_saldo_recebedor` + `credito_receita_plataforma` contam para o saldo. **`credito_passthrough_surcharge` é audit-only** — representa dinheiro que passou pela plataforma para Stripe, nunca foi propriedade dela. Exemplo: contrib 100 + tarifa 10 + surcharge 5 → comprador paga 115 → Stripe deduz 5 → banco recebe 110 = `credito_saldo_recebedor` (100) + `credito_receita_plataforma` (10). O lançamento de surcharge existe para reconciliação contra payouts Stripe mas é silencioso em qualquer query de "quanto está no banco".

3. **`LancamentoFinanceiro` não tem FSM** (Plan 0015). Os "estados" são predicados de consulta sobre colunas de **data observada**:
   - `pending` → `transferidoEm IS NULL AND canceladoEm IS NULL`
   - `transferred` → `transferidoEm IS NOT NULL AND canceladoEm IS NULL`
   - `cancelado` → `canceladoEm IS NOT NULL`

4. `transferidoEm` é setado em lote pelo caso de uso `marcarLancamentoTransferido`, gateado por `balanceTransactionAvailableOn` (a data que o Stripe libera o dinheiro). `canceladoEm` é cascateado pelo `estornarPagamento` (whole-pagamento) quando o lançamento ainda estava pendente — atinge todos os 2N + S lançamentos do pagamento.

5. **`RepasseRecebedor`** é um agregado dentro do módulo com **FSM de 2 estados forward-only**: `solicitado → aprovado`. Um repasse `aprovado` carimba `transferidoEm = aprovadoEm` em todos os lançamentos linkados na mesma transação atômica. Índice único parcial garante no máximo 1 repasse `solicitado` por campanha.

6. O módulo expõe consultas: `obterSaldoRecebedor`, `obterReceitaPlataforma`.

O módulo não recebe nem armazena nome/email do contribuinte — essa info vive em `IntencaoPagamento.contribuinte` no agregado Pagamento.

---

## FSM de RepasseRecebedor (aperture-s03dr)

```
solicitado ──────────► aprovado    (terminal, forward-only)
```

Definido em [`src/domain/pagamentos/financeiro/entities/repasse-recebedor.ts`](src/domain/pagamentos/financeiro/entities/repasse-recebedor.ts) (`StatusRepasseSchema`).

- `solicitado` — o recebedor pediu o repasse via Checkout (`iniciarRepasseRecebedor`); lançamentos linkados carregam `id_repasse` mas continuam com `transferidoEm IS NULL`.
- `aprovado` — admin confirmou a transferência (PIX/TED externo); `aprovadoEm` é setado; todos os lançamentos linkados ficam `transferidoEm = aprovadoEm`. Opcionalmente carrega `bankTransferRef` (E2E PIX id, número TED).
- **Sem rejeição:** v1 não modela `rejeitado` — se o admin precisa recusar, é conversa fora de banda.
- **Concorrência:** migration `20260604_021` adiciona índice único parcial `repasses_um_solicitado_por_campanha` em `(id_campanha) WHERE status = 'solicitado'` — dois pedidos simultâneos para a mesma campanha geram `FinanceiroRepasseJaPendenteError`.

---

## Mapa conceito → código

| Conceito | Onde está |
|----------|-----------|
| Montante em centavos | [`src/domain/money.ts`](src/domain/money.ts) — `MoneyCentsSchema` |
| **LancamentoFinanceiro** (entidade, sem FSM) | [`src/domain/pagamentos/financeiro/entities/lancamento-financeiro.ts`](src/domain/pagamentos/financeiro/entities/lancamento-financeiro.ts). Campos: `id, idPagamento, idItemPagamento` (Plan 0016 — link 1:N para o item que originou esta linha), `idContribuicao` (nullable; null em `credito_passthrough_surcharge`), `idCampanha, tipo, amountCents, criadoEm, transferidoEm, canceladoEm, idRepasse` (nullable) |
| **RepasseRecebedor** (entidade, FSM 2-estados) | [`src/domain/pagamentos/financeiro/entities/repasse-recebedor.ts`](src/domain/pagamentos/financeiro/entities/repasse-recebedor.ts) — `StatusRepasse`, `criarRepasseRecebedorSolicitado`, `aprovarRepasse` |
| Tipos de lançamento | [`src/domain/pagamentos/financeiro/value-objects/`](src/domain/pagamentos/financeiro/value-objects/) — `TipoLancamentoFinanceiro` (`credito_saldo_recebedor`, `credito_receita_plataforma`, `credito_passthrough_surcharge`) |
| Saldo do Recebedor / Receita da Plataforma (VOs derivados) | mesmo diretório — `SaldoRecebedor`, `ReceitaPlataforma`, `SnapshotComposicaoValoresFinanceiro` |
| Porta de persistência | [`src/adapters/pagamentos/financeiro/livro-repository.ts`](src/adapters/pagamentos/financeiro/livro-repository.ts) — `LivroFinanceiroRepository` (inclui `saveRepasse`, `aprovarRepasseTransaction` atômico) |
| Adaptador em memória | [`src/adapters/pagamentos/financeiro/livro-repository.memory.ts`](src/adapters/pagamentos/financeiro/livro-repository.memory.ts) |
| Adaptador Postgres | [`src/adapters/pagamentos/financeiro/livro-repository.postgres.ts`](src/adapters/pagamentos/financeiro/livro-repository.postgres.ts) |
| Migrations chave | `migrations/019_*` (índices parciais para predicados de estado), `migrations/020_*` (`balanceTransactionAvailableOn`), `migrations/20260604_021_extend_repasse_recebedor_fsm.ts` (índice único parcial + coluna `aprovado_em`) |
| Caso de uso: registrar efeitos do pagamento aprovado | [`src/use-cases/pagamentos/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.ts`](src/use-cases/pagamentos/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.ts) |
| Caso de uso: consultar saldo | [`src/use-cases/pagamentos/financeiro/obter-saldo-recebedor.ts`](src/use-cases/pagamentos/financeiro/obter-saldo-recebedor.ts) |
| Caso de uso: consultar receita | [`src/use-cases/pagamentos/financeiro/obter-receita-plataforma.ts`](src/use-cases/pagamentos/financeiro/obter-receita-plataforma.ts) |
| Caso de uso: solicitar repasse (recebedor) | [`src/use-cases/pagamentos/financeiro/solicitar-repasse-recebedor.ts`](src/use-cases/pagamentos/financeiro/solicitar-repasse-recebedor.ts) |
| Caso de uso: aprovar repasse (admin) | [`src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.ts`](src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.ts) — transição FSM atômica com carimbo de `transferidoEm` |
| Caso de uso: marcar lançamento transferido (admin) | [`src/use-cases/pagamentos/financeiro/marcar-lancamento-transferido.ts`](src/use-cases/pagamentos/financeiro/marcar-lancamento-transferido.ts) — gate por `balanceTransactionAvailableOn` (3 razões categóricas: `pagamento_nao_aprovado`, `aguardando_liberacao_sem_data`, `aguardando_liberacao_ate`) |
| Erros tipados | [`src/errors/pagamentos/financeiro/`](src/errors/pagamentos/financeiro/) — inclui `FinanceiroRepasseJaPendenteError`, `MarcarLancamentoTransferidoBloqueadoError` |
| API pública | [`src/index.ts`](src/index.ts) — re-export sob seções `Domain: Pagamentos / Financeiro` |

---

## DDD

- **Módulo, não BC:** o módulo Financeiro **vive dentro** do BC Pagamentos. Importa livremente do agregado Pagamento (e do contrário: o registro de efeitos é parte da mesma transação de aprovação). A separação de pasta `pagamentos/financeiro/` é organizacional — facilita encontrar tudo que é ledger — não uma fronteira de contexto.

- **Substituição do FSM por colunas de data observada:** insight central do Plan 0015. **Datas observadas (o que aconteceu) substituem enums preditivos (o que achávamos que ia acontecer).** Eliminou um set de race conditions cross-aggregate; abriu espaço para idempotência simples no carimbo de data.

- **Agregado implícito "Livro Financeiro":** lançamentos não têm raiz dedicada — são persistidos via `LivroFinanceiroRepository` que carrega o agregado pelo escopo da campanha quando necessário. `RepasseRecebedor` é raiz própria (tem id, tem ciclo de vida).

- **Idempotência:** o caso de uso `registrarEfeitosFinanceirosPagamentoAprovado` é idempotente por `idPagamento` — um webhook reentrante não duplica lançamentos.

- **Atomicidade FSM + ledger:** `aprovarRepasseTransaction` faz, na mesma `BEGIN/COMMIT`: (a) UPDATE em `repasses_recebedor` para `aprovado`, (b) UPDATE em todos os `lancamentos_financeiros` linkados para carimbar `transferidoEm = aprovadoEm`. Se um falha, ambos rolam.

- **Invariantes:** `totalReceiverCents + totalFeeCents + totalSurchargeCents === totalPaidCents` na composição agregada (soma per-line); cada `LancamentoFinanceiro` carrega `idItemPagamento` apontando para a linha que o originou; `transferidoEm` só é setado em lançamento de pagamento `aprovado`; `canceladoEm` só é setado se `transferidoEm IS NULL` (não se cancela algo já transferido); RepasseRecebedor só sai de `solicitado` para `aprovado` (e somente uma vez).

---

## O que o módulo Financeiro não conhece

Nome, email ou identidade do contribuinte; provedor de pagamento; transação bancária real (não automatiza PIX/TED — o admin carimba manualmente).

---

# BC Usuário — o que foi implementado

Este documento descreve o **bounded context Usuário** pós-integração BetterAuth (Pattern A — Infrastructure Adapter, epic aperture-pgqih, shipado em 2026-05-30). Usuários são administradores de campanhas; **autenticação real** vive atrás da porta `AuthService` com dois adaptadores (memória para testes/dev, BetterAuth+Postgres para produção). O contribuinte continua **sem conta** (isso pertence ao produto, não a este BC). O BC é **multi-tenant**: toda conta de administrador pertence a exatamente **uma Plataforma**, e o mesmo email pode coexistir em plataformas diferentes como contas distintas (uniqueness composta `(idPlataforma, email)`).

## Decisão arquitetural: Pattern A — Infrastructure Adapter

A integração BetterAuth seguiu o Pattern A: o **domínio Usuário fica intacto**; BetterAuth vive **fora do agregado**, atrás de uma porta `AuthService`. O agregado Usuario continua sendo apenas a identidade do administrador (id, idPlataforma, email, nomeExibicao, slug, idConta); a **credencial** (hash de senha, sessão, rate-limit) é responsabilidade do `AuthService` adapter, não do domínio.

Trade-off: o domínio fica **auth-implementation-agnostic** (testes usam `AuthServiceMemoria` sem qualquer dependência de BetterAuth, Postgres ou crypto). A composta `(idPlataforma, email)` é preservada em **duas camadas independentes**: no schema do domínio (`usuarios_plataforma_email_uniq` em `usuarios`) e no schema BetterAuth (`users_plataforma_email_uniq` em `users` da BetterAuth) — a invariante é replicada porque cada camada tem um dado próprio (registro de domínio vs. credencial), e nenhuma pode confiar na outra.

## Resumo em linguagem simples

1. Um **administrador** se cadastra **dentro de uma plataforma** (ex.: eunenem) com email, nome de exibição e senha. O caso de uso `registrarContaUsuario`:
   - Valida que a plataforma existe (`plataformaRepository.findById` → `UsuarioPlataformaNaoEncontradaError` se não).
   - Cria o registro de domínio: `Usuario` + `Conta` 1:1 + slug derivado do nome de exibição, persistido via `saveRegistroDomain({usuario, conta})`.
   - Chama `authService.criarConta({idPlataforma, idUsuario, email, senha})` para criar o principal BetterAuth com `idUsuario` controlado pelo chamador (não-padrão para BetterAuth — vide `AuthServiceBetterAuth` para o workaround via Kysely direto).
   - **Compensação T3:** se a escrita BetterAuth falha após o registro de domínio ter sido persistido, o caso de uso rola o domínio para trás (best-effort) e levanta erro tipado. Cipher revisou isso na assinatura de segurança da epic.
2. **Login (`signIn`)** vai pela porta `authService.iniciarSessao({idPlataforma, email, senha})` que devolve um token de sessão BetterAuth (cookie em produção, opaco em memória nos testes).
3. **Sessão (`me`)** valida o token via `authService.validarSessao(token)` e devolve `{idUsuario, idPlataforma, idConta}`; sessão inválida ou expirada retorna `null`.
4. **Logout (`signOut`)** chama `authService.revogarSessao(token)` (idempotente).
5. **Alterar senha / remover conta** existem como métodos do port (`alterarSenha`, `removerConta`) e são exercidos por testes; rotas de admin não foram expostas em v1.
6. O **`idConta`** (UUID) da conta é o mesmo tipo de identificador que o BC **Arrecadação** usa em `idsAdministradores` — a ligação é por **ID**, sem importar modelos entre contextos.

A **uniqueness composta** `(idPlataforma, email)` é provada por teste de integração testcontainers (registrar mesmo email em duas plataformas distintas → ambos sucessos; mesmo email duas vezes na mesma plataforma → erro tipado).

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Usuário (raiz do agregado, com `idPlataforma`) | [`src/domain/usuario/entities/usuario.ts`](src/domain/usuario/entities/usuario.ts) — `Usuario`, `Conta`, `contaTemPermissao`. **Sem `CredencialSimulada`** — credencial saiu do agregado pelo Pattern A. |
| Identificadores (`IdUsuario`, `IdContaUsuario`, mirror VO `IdPlataformaReferencia`) | [`src/domain/usuario/value-objects/ids.ts`](src/domain/usuario/value-objects/ids.ts) |
| Demais value objects (email, nome de exibição, slug, permissão, token de sessão) | [`src/domain/usuario/value-objects/`](src/domain/usuario/value-objects) |
| **Porta `AuthService`** (credencial + sessão fora do agregado) | [`src/adapters/usuario/auth-service.ts`](src/adapters/usuario/auth-service.ts) — métodos: `criarConta`, `iniciarSessao`, `validarSessao`, `revogarSessao`, `alterarSenha`, `removerConta`. Cada método recebe `idPlataforma` como parâmetro para a uniqueness composta. |
| Adaptador `AuthServiceMemoria` (testes + dev) | [`src/adapters/usuario/auth-service.memory.ts`](src/adapters/usuario/auth-service.memory.ts) — maps in-process, chave `{idPlataforma}::{email}` |
| Adaptador `AuthServiceBetterAuth` (produção) | [`src/adapters/usuario/auth-service.better-auth.ts`](src/adapters/usuario/auth-service.better-auth.ts) — escreve direto em Kysely (bypass do pipeline HTTP da BetterAuth para preservar `idUsuario` controlado pelo chamador e pular rate-limit interno). Usa `hashPassword` / `verifyPassword` de `better-auth/crypto`. |
| Helper `criarAuth` (config BetterAuth) | [`src/adapters/usuario/criar-auth.ts`](src/adapters/usuario/criar-auth.ts) — pool Kysely compartilhado, casing snake, sessão 7 dias / refresh 1 dia / fresh 1 dia, rate-limit DB-backed (multi-instance safe), `additionalFields.idPlataforma` requerido, **email + senha only** (sem OAuth, sem magic link, sem admin plugin) |
| Migration BetterAuth (5 tabelas) | [`migrations/20260530_009_create_better_auth.ts`](migrations/20260530_009_create_better_auth.ts) — `users` (com `id_plataforma` + composta `(id_plataforma, email)`), `sessions`, `accounts` (com `account_id = {idPlataforma}::{email}` para evitar colisão cross-tenant), `verifications`, `rate_limit` |
| Porta de persistência do domínio | [`src/adapters/usuario/repository.ts`](src/adapters/usuario/repository.ts) — `UsuarioRepository.saveRegistroDomain({usuario, conta})`, `findUsuarioByEmail(idPlataforma, email)`, `findUsuarioById`, … |
| Adaptador em memória | [`src/adapters/usuario/repository.memory.ts`](src/adapters/usuario/repository.memory.ts) |
| Adaptador Postgres | [`src/adapters/usuario/repository.postgres.ts`](src/adapters/usuario/repository.postgres.ts) |
| Caso de uso: cadastro (gate de plataforma + Pattern A) | [`src/use-cases/usuario/registrar-conta-usuario.ts`](src/use-cases/usuario/registrar-conta-usuario.ts) — deps incluem `plataformaRepository` + `authService` |
| Caso de uso: atualizar perfil | [`src/use-cases/usuario/atualizar-perfil-usuario.ts`](src/use-cases/usuario/atualizar-perfil-usuario.ts) |
| Caso de uso: criar sessão (delega à porta) | [`src/use-cases/usuario/criar-sessao-usuario.ts`](src/use-cases/usuario/criar-sessao-usuario.ts) — chama `authService.iniciarSessao` |
| Caso de uso: autorizar permissão | [`src/use-cases/usuario/autorizar-permissao-usuario.ts`](src/use-cases/usuario/autorizar-permissao-usuario.ts) — chama `authService.validarSessao` |
| Consumer eunenem-server: mount handler | [`apps/eunenem-server/server/`](apps/eunenem-server/server/) — `auth.handler` montado no Hono entry (rota `/api/auth/**`) |
| Consumer eunenem-server: procedures tRPC | mesmo diretório — `auth.signUp`, `auth.signIn`, `auth.signOut`, `auth.me` |
| Erros tipados | [`src/errors/usuario/`](src/errors/usuario) — `UsuarioPlataformaNaoEncontradaError`, `UsuarioEmailJaCadastradoError`, … |
| API pública | [`src/index.ts`](src/index.ts) — seção `Domain: Usuario` + re-exports dos adapters BetterAuth |
| Testes unitários + integração | [`tests/unit/usuario/`](tests/unit/usuario), [`tests/integration/`](tests/integration) — incluindo conformance compartilhada Memória vs Postgres+BetterAuth via testcontainers (composta + saga T3) |

---

## DDD

- **Bounded context:** o vocabulário de usuário, conta, sessão e permissão vive aqui. Pós-Pattern A, **credencial** deixou de ser vocabulário do domínio (ficou na infraestrutura).
- **Linguagem ubíqua:** nomes em código (`Usuario`, `Conta`, `registrarContaUsuario`, `AuthService`) alinham com o produto e com a discussão de DDD em [`ENGINE-DDD.md`](ENGINE-DDD.md).
- **Multi-tenant por design:** todo `Usuario` carrega `idPlataforma`; uniqueness de email é **composta** `(idPlataforma, email)` tanto no domínio quanto no schema BetterAuth. O `IdPlataformaReferencia` é um **mirror VO** local — o domínio do Usuário **não importa** de `src/domain/plataforma/` (regra do `dependency-cruiser`).
- **Agregado:** Usuario carrega a Conta como entidade aninhada (1:1, mesma transação). **Credencial fica fora do agregado** atrás do `AuthService` port; o agregado em si é auth-implementation-agnostic.
- **Value objects / validação na fronteira:** email normalizado, slug derivado de nomeExibicao, permissões enumeradas — validados com Zod nos inputs dos casos de uso.
- **Saga T3 (compensação cross-port):** `registrarContaUsuario` escreve em duas portas (`usuarioRepository` + `authService`). Se a segunda falha, a primeira é compensada best-effort com log estruturado. Esse padrão veio do checklist de banked lessons T1-T12 (vide notes do epic aperture-pgqih).
- **Integração com Plataforma:** dependência soft via `IdPlataformaReferencia` no domínio + gate explícito (`plataformaRepository.findById`) na aplicação. Cadastros com plataforma inexistente falham com `UsuarioPlataformaNaoEncontradaError`.
- **Integração com Arrecadação:** o BC Arrecadação guarda uma lista de UUIDs (`idsAdministradores`). O significado "conta registrada no Usuário" é responsabilidade da **aplicação** (orquestração) — sem acoplar o domínio de campanhas ao de usuários.
- **Pontos de produção pendentes (status atual):** Cipher's review (aperture-ebspa) sinalizou 3 P2 prod-gates ainda em aberto que NÃO bloqueiam staging mas precisam fechar antes de prod: auth-router hardening (M1+M2+M4, aperture-haakf), freshAge gate (M3, aperture-wshvw), reverse-proxy security headers (L1, aperture-85n6u).

---

# BC Evento (supporting) — fase 1

Bounded context de **suporte** ao produto (convites digitais, RSVP): fora do core Arrecadação → Taxas → Pagamentos. Estado atual: três agregados shipados — **Evento** (raiz por campanha), **Convite** (1:1 com evento), **ListaDeConvidados** (RSVP por evento, com `Convidado` entity aninhada).

## Resumo em linguagem simples

1. Uma **campanha** pode ter **no máximo um evento** (relação 1:1 por `idCampanha`).
2. O evento guarda **tipo** (chá de bebê, chá de fraldas, chá-surpresa, chá-revelação, batizado, aniversário), **modalidade** (presencial ou online), **data/hora** e **endereço** opcional.
3. O **Convite** (1:1 com evento) guarda nome exibido, mensagem, e a personalização visual: `paleta`, `fonte`, `modelo` (ex.: `scrapbook`, `varal-de-mimos`, `balao-de-ar`, `jardim-romantico`, `lavanda`, `floresta-magica`, `roupinhas-e-coracoes`, `berco-floral`, `arco-iris-boho`, `margaridas`, `girafinha-bailarina`, `safari`, `elefantinho`).
4. A **ListaDeConvidados** (1:1 com evento) é um roster com `linkConfirmacao` e uma coleção de `Convidado` (entidade aninhada com nome, número de celular, `presenca: sim | nao | talvez`).
5. Os agregados **não** carregam `idPlataforma` — o escopo de tenant vem da campanha; a app valida que o admin só opera na própria campanha.
6. **Persistência:** todos os três agregados rodam só em memória na fase 1 (sem Postgres ainda; migration planejada).

## Mapa conceito → código

| Conceito | Onde está |
|----------|-----------|
| Evento (agregado raiz) | [`src/domain/evento/entities/evento.ts`](src/domain/evento/entities/evento.ts) — `Evento`, `criarEvento`, `eventoComCamposAtualizados` |
| Convite (agregado raiz, 1:1 com evento) | [`src/domain/evento/entities/convite.ts`](src/domain/evento/entities/convite.ts) — `Convite`, `criarConvite`, `conviteComCamposAtualizados` |
| ListaDeConvidados (agregado raiz, 1:1 com evento) | [`src/domain/evento/entities/lista-de-convidados.ts`](src/domain/evento/entities/lista-de-convidados.ts) — `ListaDeConvidados`, `Convidado` (entidade aninhada), `convidadoComPresencaAtualizada` |
| Identificadores | [`src/domain/evento/value-objects/ids.ts`](src/domain/evento/value-objects/ids.ts) — `IdEvento`, `IdConvite`, `IdListaDeConvidados`, `IdConvidado` + mirror VOs `IdCampanha` |
| Value objects do Evento (tipo, modalidade, data-hora, endereço) | [`src/domain/evento/value-objects/`](src/domain/evento/value-objects/) — `TipoEvento`, `ModalidadeEvento`, `DataHoraEvento`, `EnderecoEvento` |
| Value objects do Convite (paleta, fonte, modelo, mensagem) | mesmo diretório — `PaletaConvite`, `FonteConvite`, `ModeloConvite`, `MensagemConvite`, `NomeExibidoConvite` |
| Value objects da ListaDeConvidados | mesmo diretório — `LinkConfirmacaoLista`, `StatusPresencaConvidado`, `NumeroCelularConvidado` |
| Portas de persistência | [`src/adapters/evento/`](src/adapters/evento/) — `EventoRepository`, `ConviteRepository`, `ListaDeConvidadosRepository` |
| Adaptadores em memória + índices 1:1 | mesmo diretório — `.memory.ts` para os três |
| Casos de uso Evento | [`src/use-cases/evento/criar-evento.ts`](src/use-cases/evento/criar-evento.ts), [`atualizar-evento.ts`](src/use-cases/evento/atualizar-evento.ts), [`obter-evento-por-id.ts`](src/use-cases/evento/obter-evento-por-id.ts), [`obter-evento-por-id-campanha.ts`](src/use-cases/evento/obter-evento-por-id-campanha.ts) |
| Casos de uso Convite | [`criar-convite.ts`](src/use-cases/evento/criar-convite.ts), [`atualizar-convite.ts`](src/use-cases/evento/atualizar-convite.ts), [`obter-convite-por-id.ts`](src/use-cases/evento/obter-convite-por-id.ts), [`obter-convite-por-id-evento.ts`](src/use-cases/evento/obter-convite-por-id-evento.ts) |
| Casos de uso ListaDeConvidados | [`criar-lista-de-convidados.ts`](src/use-cases/evento/criar-lista-de-convidados.ts), [`atualizar-lista-de-convidados.ts`](src/use-cases/evento/atualizar-lista-de-convidados.ts), [`alterar-presenca-convidado.ts`](src/use-cases/evento/alterar-presenca-convidado.ts), [`obter-lista-de-convidados-por-id.ts`](src/use-cases/evento/obter-lista-de-convidados-por-id.ts), [`obter-lista-de-convidados-por-id-evento.ts`](src/use-cases/evento/obter-lista-de-convidados-por-id-evento.ts) |
| Erros | [`src/errors/evento/`](src/errors/evento/) |
| API pública | [`src/index.ts`](src/index.ts) — seção `Domain: Evento` |
| Testes | [`tests/unit/evento/`](tests/unit/evento/) |

## Pendente

- **Postgres** — migrations + adapters + testes de integração para os três agregados.

---

# Orquestração — Checkout (pseudo-BC)

O **Checkout** é um **pseudo-bounded-context**: existe apenas como casos de uso em [`src/use-cases/checkout/`](src/use-cases/checkout) e erros tipados em [`src/errors/checkout/`](src/errors/checkout). **Não há `src/domain/checkout/` nem `src/adapters/checkout/`** — Checkout não tem entidades, value objects, agregados nem repositórios próprios. Sua única responsabilidade é **orquestrar BCs reais (Arrecadação, Taxas, Pagamentos, módulo Financeiro)** em sagas multi-passo, com **guard multi-tenant** e (onde ainda faz sentido) compensação.

**Mudança no padrão de compensação (pós-Plan 0015 + Plan 0016):** como `Contribuicao` virou *slot puro com cardinalidade* (sem estado armazenado), **não há mais o que rolar atrás** quando uma intenção de pagamento falha — a contribuição nunca foi "reservada", os predicados `quantidadeRestante` + `esgotada` são checagens de leitura. As sagas pós-0015 são mais simples: validam, criam intenção (agora como carrinho multi-item), deixam o webhook avançar o FSM. A única compensação real hoje é o **`estornarPagamento`** (refund pós-aprovação, whole-pagamento) que cascateia em `canceladoEm` em todos os lançamentos linkados ainda não transferidos.

**Rename pós-Plan 0016:** o saga `iniciarPagamentoContribuicao` foi renomeada para **`iniciarPagamentoCarrinho`** — o novo nome reflete a forma multi-item (locked decision §Open items / Naming). Pure rename, sem re-export deprecado (greenfield staging).

## Resumo em linguagem simples

1. Quando o contribuinte clica "comprar carrinho", o Checkout: valida a plataforma da campanha; carrega cada contribuição do carrinho e checa **`esgotada(idContribuicao)`** por-item (gate per-item — qualquer slot esgotado → `ArrecadacaoContribuicaoIndisponivelError`); valida que todos os items compartilham `idCampanha` (`CarrinhoMultiplasCampanhasError` se não); calcula composição agregada (Taxas, sum-of-lines); se o método é cartão, calcula `calcularSurchargeParaCarrinho` + appenda como último item; cria a `IntencaoPagamento` carrinho + sessão de checkout no provedor (Pagamentos). O provedor avança o FSM por webhooks; o snapshot do contribuinte chega via `checkout.session.completed`.
2. Quando o webhook `payment_intent.succeeded` (ou `charge.succeeded`) chega, o Checkout finaliza: `aprovarPagamento` + `registrarEfeitosFinanceirosPagamentoAprovado` (que itera per-item) na mesma transação.
3. Quando o admin precisa estornar, `estornarPagamento` aciona o refund Stripe pelo `totalPaidCents` agregado, transiciona o FSM para `estornado`, e cascateia `canceladoEm` em todos os lançamentos pendentes do pagamento. Lançamentos já transferidos bloqueiam o estorno (`PagamentoEstornoLancamentoJaTransferidoError`). Whole-pagamento only — não há refund por-item em v1.
4. Todas as sagas cross-tenant comparam `input.idPlataforma` com `campanha.idPlataforma` e levantam `CheckoutPlataformaMismatchError` em mismatch — guard cross-tenant explícito.

---

## Casos de uso implementados

| Caso de uso | Responsabilidade |
|-------------|------------------|
| [`iniciarPagamentoCarrinho`](src/use-cases/checkout/iniciar-pagamento-carrinho.ts) | Saga write-side multi-item (renomeada de `iniciarPagamentoContribuicao` no Plan 0016): gate de plataforma → carrega campanha + cada contribuição (Arrecadação) → checa `esgotada(idContribuicao)` por-item → valida que todos os items compartilham `idCampanha` → `calcularComposicaoValores` agregada (Taxas) → opcionalmente `calcularSurchargeParaCarrinho` + appenda surcharge item como último → `criarPagamentoPendente` (Pagamentos, com `items[]`) → abre sessão de checkout no provedor. **Sem reserva de slot** — concorrência otimista; se duas pessoas pagarem o mesmo item, ambos pagamentos vão a `aprovado` (overshoot aceito). |
| [`finalizarPagamentoAprovado`](src/use-cases/checkout/finalizar-pagamento-aprovado.ts) | Saga de confirmação (driver: webhook do provedor): `aprovarPagamento` (Pagamentos) → `registrarEfeitosFinanceirosPagamentoAprovado` (módulo Financeiro). Mesma transação DB; idempotente por `idPagamento`. |
| [`finalizarPagamentoRejeitado`](src/use-cases/checkout/finalizar-pagamento-rejeitado.ts) | Saga de rejeição (driver: webhook): `rejeitarPagamento` (Pagamentos). **Não há mais compensação em Arrecadação** (pré-0015 fazia desassociar contribuinte — agora não há nada para rolar atrás). |
| [`estornarPagamento`](src/use-cases/checkout/estornar-pagamento.ts) | Saga de refund (admin-driven): valida que pagamento está `aprovado` → checa que nenhum lançamento linkado tem `transferidoEm` setado (senão `PagamentoEstornoLancamentoJaTransferidoError`) → dispara refund no provedor → `estornarPagamentoAprovado` (Pagamentos) → cascateia `canceladoEm = now()` em todos os lançamentos pendentes do pagamento. Tudo na mesma transação. |
| [`iniciarRepasseRecebedor`](src/use-cases/checkout/iniciar-repasse-recebedor.ts) | Saga de repasse (recebedor-driven): gate de plataforma → resolve o recebedor ativo (Arrecadação) → guard que campanha tem recebedor (`CheckoutCampanhaSemRecebedorError` se não) → `solicitarRepasseRecebedor` (módulo Financeiro). Gera bead `RepasseRecebedor` em `solicitado`. |
| [`obterContribuicoesPrecalculadasCampanha`](src/use-cases/checkout/obter-contribuicoes-precalculadas-campanha.ts) | Read-side: gate de plataforma → lista contribuições disponíveis (filtra por `esgotada` predicate) + aplica `calcularComposicaoValores` em cada uma. Pré-monta o snapshot para a UI sem efeitos colaterais. |

---

## Erros tipados

Apenas dois — todos os outros vêm dos BCs orquestrados:

- [`CheckoutPlataformaMismatchError`](src/errors/checkout/plataforma-mismatch.error.ts) — guard cross-tenant.
- [`CheckoutCampanhaSemRecebedorError`](src/errors/checkout/campanha-sem-recebedor.error.ts) — `iniciarRepasseRecebedor` chamado em campanha sem recebedor ativo. Criação de campanha + recebimento de contribuições funcionam sem recebedor; só o saque é gateado.

Carrinhos com items de campanhas diferentes levantam `CarrinhoMultiplasCampanhasError` (no BC Pagamentos / saga `iniciarPagamentoCarrinho`).

---

## DDD

- **Pseudo-BC, não BC real:** sem domínio próprio. Toda regra de negócio vive nos BCs orquestrados (Arrecadação, Taxas, Pagamentos + módulo Financeiro). O Checkout adiciona **apenas** orquestração + dois erros cross-BC.

- **Padrão saga simplificado pós-Plan 0015 + Plan 0016:** o write-side principal (`iniciarPagamentoCarrinho`) deixou de ter `try/catch` de compensação porque o primeiro passo de efeito colateral (`criarPagamentoPendente`) é o último que importa — não há reserva de slot para desfazer. A única compensação que sobreviveu é a cascata de `canceladoEm` dentro de `estornarPagamento`, que mora na mesma transação DB do `estornarPagamentoAprovado` — atomicidade em vez de saga. O nome antigo `iniciarPagamentoContribuicao` foi removido (pure rename, sem re-export deprecado).

- **Guard cross-tenant:** toda saga que recebe `idPlataforma` no input compara com o `campanha.idPlataforma` carregado do repositório e lança `CheckoutPlataformaMismatchError` se forem diferentes. Fecha a superfície "consigo um id de campanha de outra plataforma e tento pagá-la pela minha". O span registra o mismatch com atributos estruturados para auditoria.

- **Sem novos modelos:** Checkout não cria entidades, agregados, value objects nem ports. Ele consome os modelos públicos dos BCs (`Campanha`, `Contribuicao`, `Pagamento`, `ItemDoPagamento`, `LancamentoFinanceiro`, `RepasseRecebedor`) e devolve composições deles ao chamador.

- **Observabilidade:** cada saga abre um span próprio (`iniciarPagamentoCarrinho`, `finalizarPagamentoAprovado`, `estornarPagamento`, …) com atributos `checkout.*` para correlacionar os passos. O evento de domínio emitido pela criação carrega `numeroDeItens` + `idsContribuicoes` (não `idContribuicao` único — locked decision §Operator review #19 do Plan 0016).

---

## O que Checkout não conhece

Checkout não conhece detalhes internos de nenhum BC. Em particular, ele não conhece:

- A estrutura das opções de contribuição além de saber que existe um `tipo` que Taxas precisa para resolver a tarifa
- A política de cálculo de taxa (delega 100% a Taxas)
- O provedor de pagamento ou como aprovação acontece (chama os casos de uso de Pagamentos)
- A representação interna de lançamentos financeiros (recebe o array que o módulo Financeiro devolve e repassa)

Ele conhece apenas a **ordem dos passos**, as **deps necessárias para chamá-los**, e (no caso do estorno) a **regra de cascata** quando um pagamento aprovado precisa ser desfeito.

---

## Operação e qualidade (`pnpm check`)

### Comandos úteis (Postgres / Arrecadação)

```bash
pnpm db:up          # Postgres local (porta 54320)
pnpm db:migrate     # aplica migrations
pnpm db:codegen     # regenera src/adapters/db-types.generated.ts
```

O `pnpm check` completo exige **Docker** (Testcontainers nos testes de integração Postgres + `check:codegen-drift`). Os testes unitários dos BCs em memória não dependem de Docker.
