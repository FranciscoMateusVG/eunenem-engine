# Contextos da engine — documentação consolidada

Este arquivo reúne a documentação dos **bounded contexts** já implementados na engine de intermediação financeira (skeleton Frame). A **Plataforma** é o BC fundacional **multi-tenant**: todo Usuário, Campanha, Sessão e regra de Taxa pertence a exatamente uma plataforma (eunenem, eucasei, ...). A seguir vem o fluxo natural do negócio: arrecadação → taxas → pagamentos → financeiro, com **usuário** como contexto transversal de administração. Por fim, **Checkout** é um pseudo-BC de orquestração (apenas casos de uso + erros, sem domínio nem adaptadores próprios) que costura os BCs em sagas com compensação.

**Persistência hoje:** **Arrecadação** tem adaptadores em memória e **Postgres** (Kysely); **Plataforma**, **Taxas**, **Pagamentos**, **Financeiro** e **Usuário** usam adaptadores em memória e/ou Postgres conforme o BC; **Evento** (fase 1) usa **somente memória**.

---

## Índice

1. [BC Plataforma](#bc-plataforma--o-que-foi-implementado)
2. [BC Arrecadação](#bc-arrecadação--o-que-foi-implementado)
3. [BC Taxas](#bc-taxas--o-que-foi-implementado)
4. [BC Pagamentos](#bc-pagamentos--o-que-foi-implementado)
5. [BC Financeiro](#bc-financeiro--o-que-foi-implementado)
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
3. O administrador cria **itens de contribuição** dentro de uma opção (`nome`, `valor` em centavos), com status `disponivel` e sem contribuinte.
4. Um **contribuinte visitante** (sem conta) escolhe um item e associa seus dados (`nome`, **email obrigatório**); a contribuição passa a `indisponivel`. Taxas e pagamentos usam o `idContribuicao` e o valor do item.

Nada disso cobra pagamento nem calcula taxa — isso fica em outros bounded contexts.

---

## Schema Postgres

| Tabela | Colunas principais | Notas |
|--------|-------------------|--------|
| `campanhas` | `id`, `titulo`, `criada_em` | Metadados da campanha |
| `recebedores` | `id`, `campanha_id`, dados PIX, `is_active`, `criada_em` | Histórico de recebedores; 1 ativo por campanha |
| `campanha_administradores` | `campanha_id`, `id_usuario` | PK composta; `id_usuario` ↔ `IdConta` no domínio |
| `opcoes_contribuicao` | `id`, `campanha_id`, `tipo` | Sacola por `tipo`: `presente` \| `rifa` \| `convite` |
| `contribuicoes` | `id`, `campanha_id`, `id_opcao_contribuicao`, `nome`, `valor`, `status`, `criada_em`, `contribuinte_*` | `status`: `disponivel` \| `indisponivel`; contribuinte NULL até associação; FKs `ON DELETE RESTRICT` |

Migrations: [`migrations/20260519_001_create_arrecadacao.ts`](migrations/20260519_001_create_arrecadacao.ts), [`migrations/20260520_002_alter_arrecadacao_sacola_itens.ts`](migrations/20260520_002_alter_arrecadacao_sacola_itens.ts), [`migrations/20260521_003_recebedores_versionados.ts`](migrations/20260521_003_recebedores_versionados.ts), [`migrations/20260522_004_drop_recebedores_id_carteira.ts`](migrations/20260522_004_drop_recebedores_id_carteira.ts).

Adaptadores Postgres exportados também pelo subpath `frame/adapters/postgres` (não no `src/index.ts` público).

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Montante em centavos (evitar `number` em reais) | [`src/domain/money.ts`](src/domain/money.ts) — `MoneyCentsSchema` |
| Campanha, administradores, projeção do recebedor ativo (`dadosRecebedor`), opção de contribuição | [`src/domain/arrecadacao/campanha.ts`](src/domain/arrecadacao/campanha.ts) — `Campanha`, `DadosRecebedor`, `OpcaoContribuicao` |
| Recebedor (PIX auditável) | [`src/domain/arrecadacao/recebedor.ts`](src/domain/arrecadacao/recebedor.ts) — `Recebedor`, `criarNovoRecebedor` |
| Persistência Postgres do recebedor | [`src/adapters/arrecadacao/recebedor-repository.postgres.ts`](src/adapters/arrecadacao/recebedor-repository.postgres.ts) — `RecebedorRepositoryPostgres` |
| Procurar opção na campanha (função pura) | [`src/domain/arrecadacao/campanha.ts`](src/domain/arrecadacao/campanha.ts) — `encontrarOpcaoContribuicao` |
| Anexar opção de forma imutável | [`src/domain/arrecadacao/campanha.ts`](src/domain/arrecadacao/campanha.ts) — `campanhaComOpcao` |
| Contribuição, dados do visitante, input de criação | [`src/domain/arrecadacao/contribuicao.ts`](src/domain/arrecadacao/contribuicao.ts) |
| Persistência em memória da campanha | [`src/adapters/arrecadacao/campanha-repository.memory.ts`](src/adapters/arrecadacao/campanha-repository.memory.ts) |
| Persistência Postgres da campanha | [`src/adapters/arrecadacao/campanha-repository.postgres.ts`](src/adapters/arrecadacao/campanha-repository.postgres.ts) — `CampanhaRepositoryPostgres` |
| Persistência em memória das contribuições | [`src/adapters/arrecadacao/contribuicao-repository.memory.ts`](src/adapters/arrecadacao/contribuicao-repository.memory.ts) |
| Persistência Postgres das contribuições | [`src/adapters/arrecadacao/contribuicao-repository.postgres.ts`](src/adapters/arrecadacao/contribuicao-repository.postgres.ts) — `ContribuicaoRepositoryPostgres` |
| Schema relacional (migrations) | [`migrations/20260519_001_create_arrecadacao.ts`](migrations/20260519_001_create_arrecadacao.ts) — `campanhas`, `campanha_administradores` (`id_usuario`), `opcoes_contribuicao` (`tipo`), `contribuicoes` |
| Testes de integração Postgres | [`tests/integration/campanha-repository.postgres.test.ts`](tests/integration/campanha-repository.postgres.test.ts), [`tests/integration/contribuicao-repository.postgres.test.ts`](tests/integration/contribuicao-repository.postgres.test.ts) |
| Portas (interfaces) | [`src/adapters/arrecadacao/campanha-repository.ts`](src/adapters/arrecadacao/campanha-repository.ts) — `CampanhaRepository`; [`src/adapters/arrecadacao/contribuicao-repository.ts`](src/adapters/arrecadacao/contribuicao-repository.ts) — `ContribuicaoRepository` |
| Caso de uso: criar campanha | [`src/use-cases/arrecadacao/criar-campanha.ts`](src/use-cases/arrecadacao/criar-campanha.ts) — `criarCampanha` |
| Caso de uso: adicionar administrador | [`src/use-cases/arrecadacao/adicionar-administrador-campanha.ts`](src/use-cases/arrecadacao/adicionar-administrador-campanha.ts) — `adicionarAdministradorCampanha` |
| Caso de uso: remover administrador | [`src/use-cases/arrecadacao/remover-administrador-campanha.ts`](src/use-cases/arrecadacao/remover-administrador-campanha.ts) — `removerAdministradorCampanha` |
| Caso de uso: alterar dados do recebedor (desativa + novo recebedor) | [`src/use-cases/arrecadacao/alterar-dados-recebedor-campanha.ts`](src/use-cases/arrecadacao/alterar-dados-recebedor-campanha.ts) — `alterarDadosRecebedorCampanha` |
| Caso de uso: adicionar opção (sacola) | [`src/use-cases/arrecadacao/adicionar-opcao-contribuicao.ts`](src/use-cases/arrecadacao/adicionar-opcao-contribuicao.ts) — `adicionarOpcaoContribuicao` |
| Caso de uso: criar item de contribuição (admin) | [`src/use-cases/arrecadacao/criar-contribuicao.ts`](src/use-cases/arrecadacao/criar-contribuicao.ts) — `criarContribuicao` |
| Caso de uso: associar contribuinte (visitante) | [`src/use-cases/arrecadacao/associar-contribuinte-contribuicao.ts`](src/use-cases/arrecadacao/associar-contribuinte-contribuicao.ts) — `associarContribuinteContribuicao` |
| Caso de uso: alterar valor do item | [`src/use-cases/arrecadacao/alterar-valor-contribuicao.ts`](src/use-cases/arrecadacao/alterar-valor-contribuicao.ts) — `alterarValorContribuicao` |
| Erros de domínio / aplicação | [`src/errors/arrecadacao/`](src/errors/arrecadacao) |
| API pública do pacote (re-exports) | [`src/index.ts`](src/index.ts) |
| Testes unitários | [`tests/unit/money.test.ts`](tests/unit/money.test.ts), [`tests/unit/arrecadacao/campanha.test.ts`](tests/unit/arrecadacao/campanha.test.ts), [`tests/unit/arrecadacao/contribuicao.test.ts`](tests/unit/arrecadacao/contribuicao.test.ts), [`tests/unit/arrecadacao/casos-de-uso.test.ts`](tests/unit/arrecadacao/casos-de-uso.test.ts) |

---

## DDD

- **Bounded context (contexto delimitado):** arquivos na subpasta `arrecadacao/` em domínio, adaptadores, erros e casos de uso. Toda a linguagem (campanha, opção, contribuição, visitante) vive aqui; não aparecem “pagamentos” ou “taxas” neste BC.

- **Ubiquitous language (linguagem ubíqua):** os nomes em TypeScript (`Campanha`, `OpcaoContribuicao`, `criarContribuicao`) alinham com a conversa de produto em [`ENGINE-DDD.md`](ENGINE-DDD.md).

- **Value object:** `MoneyCents` (via schema) e o perfil do contribuinte são valores validados nas fronteiras, sem identidade própria.

- **Entidade:** `Campanha` e `Contribuicao` têm **id** estável e ciclo de vida; a campanha **muda** quando se adicionam opções (nova versão imutável do agregado).

- **Agregado:** a **Campanha** é a raiz com **opções** (sacolas por `tipo`). Cada **Contribuição** é um item persistido à parte, referenciando `idCampanha` e `idOpcaoContribuicao` (herda o `tipo` da sacola sem duplicar no domínio).

- **Repositório (padrão):** `CampanhaRepository` e `ContribuicaoRepository` são portas; Postgres faz upsert de campanha/opções e upsert de contribuições. Administradores usam coluna `id_usuario` ↔ `IdConta`.

- **Caso de uso / serviço de aplicação:** validação Zod, invariantes (opção duplicada, item só `disponivel` para associação/alteração de valor) e persistência.

- **Invariantes:** opção com `id` único na campanha; item nasce `disponivel` sem contribuinte; associação de visitante exige `disponivel` e resulta em `indisponivel`; valor do item definido pelo admin e alterável só enquanto `disponivel`.

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
- **Regra de Taxa:** `src/domain/taxas/taxas.ts` — `RegraTaxa`, `REGRA_TAXA_PADRAO`
- **Responsável pela Taxa:** `src/domain/taxas/taxas.ts` — `ResponsavelTaxa`, por enquanto apenas `contribuinte`
- **Cálculo de Taxa:** `src/domain/taxas/taxas.ts` — `calcularValorTaxaPercentual` e `calcularTaxa`
- **Composição de Valores:** `src/domain/taxas/taxas.ts` — `ComposicaoValores`, `comporComposicaoValores` e `calcularComposicaoValores` (domínio; exportado como `calcularComposicaoValoresDominio` no pacote)
- **Porta para regra ativa:** `src/adapters/taxas/regra-provider.ts` — `ProvedorRegraTaxa`
- **Regra em memória:** `src/adapters/taxas/regra-provider.memory.ts` — `ProvedorRegraTaxaMemory`
- **Caso de uso:** `src/use-cases/taxas/calcular-composicao-valores.ts` — `calcularComposicaoValores`
- **Erro tipado:** `src/errors/taxas/input-invalido.error.ts` — `TaxasInputInvalidoError`
- **API pública:** `src/index.ts`
- **Testes unitários:** `tests/unit/taxas/taxas.test.ts`, `tests/unit/taxas/regra-provider.memory.test.ts`, `tests/unit/taxas/calcular-composicao-valores.test.ts`

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

Este documento descreve a primeira fatia do **bounded context Pagamentos** na engine de intermediação financeira: pagamento em memória, com provedor fake, sem Postgres e sem integração real com Stripe, Mercado Pago, PagSeguro ou similares.

## Resumo em linguagem simples

1. O contexto **Pagamentos** recebe uma composição de valores já calculada por **Taxas**.
2. Ele cria uma **intenção de pagamento** cobrando exatamente o `totalPaidCents`.
3. O pagamento nasce com status `pendente`.
4. Um **provedor fake** simula a resposta externa e pode aprovar ou rejeitar.
5. O pagamento muda para `aprovado` ou `rejeitado` e um evento é publicado em memória.

Exemplo canônico:

- Valor da contribuição: R$ 80,00 (`8000` centavos)
- Taxa: R$ 4,00 (`400` centavos)
- Total pago pelo contribuinte: R$ 84,00 (`8400` centavos)
- Valor destinado ao recebedor: R$ 80,00 (`8000` centavos)
- Valor cobrado por Pagamentos: R$ 84,00 (`8400` centavos)

Pagamentos não calcula taxa. Ele só confere se o valor a cobrar é igual ao total calculado por Taxas.

---

## Mapa conceito de negócio → código

- **Montante em centavos:** `src/domain/money.ts` — `MoneyCentsSchema`
- **Intenção de Pagamento:** `src/domain/pagamentos/pagamentos.ts` — `IntencaoPagamento`
- **Pagamento:** `src/domain/pagamentos/pagamentos.ts` — `Pagamento`
- **Método de Pagamento:** `src/domain/pagamentos/pagamentos.ts` — `MetodoPagamento`, por enquanto `pix` e `credit_card`
- **Status do Pagamento:** `src/domain/pagamentos/pagamentos.ts` — `StatusPagamento`, com `pendente`, `aprovado` e `rejeitado`
- **Composição de Valores recebida de Taxas:** `src/domain/pagamentos/pagamentos.ts` — `SnapshotComposicaoValores`
- **Transação Externa simulada:** `src/domain/pagamentos/pagamentos.ts` — `TransacaoExterna`
- **Evento de Pagamento:** `src/domain/pagamentos/pagamentos.ts` — `EventoPagamento`
- **Porta de persistência:** `src/adapters/pagamentos/repository.ts` — `PagamentoRepository`
- **Persistência em memória:** `src/adapters/pagamentos/repository.memory.ts` — `PagamentoRepositoryMemory`
- **Porta do provedor:** `src/adapters/pagamentos/provider.ts` — `PagamentoProvider`
- **Provedor fake:** `src/adapters/pagamentos/provider.fake.ts` — `PagamentoProviderFake`
- **Porta de eventos:** `src/adapters/pagamentos/event-publisher.ts` — `PagamentoEventPublisher`
- **Eventos em memória:** `src/adapters/pagamentos/event-publisher.memory.ts` — `PagamentoEventPublisherMemory`
- **Caso de uso: criar intenção:** `src/use-cases/pagamentos/criar-intencao-pagamento.ts` — `criarIntencaoPagamento`
- **Caso de uso: aprovar pagamento:** `src/use-cases/pagamentos/aprovar-pagamento.ts` — `aprovarPagamento`
- **Caso de uso: rejeitar pagamento:** `src/use-cases/pagamentos/rejeitar-pagamento.ts` — `rejeitarPagamento`
- **Caso de uso: consultar pagamento:** `src/use-cases/pagamentos/obter-pagamento-por-id.ts` — `obterPagamentoPorId`
- **Erros tipados:** `src/errors/pagamentos/`
- **API pública:** `src/index.ts`
- **Testes unitários:** `tests/unit/pagamentos/pagamentos.test.ts`, `tests/unit/pagamentos/repository.memory.test.ts`, `tests/unit/pagamentos/provider.fake.test.ts`, `tests/unit/pagamentos/event-publisher.memory.test.ts`, `tests/unit/pagamentos/casos-de-uso.test.ts`

---

## DDD

- **Bounded Context:** Pagamentos tem linguagem própria: intenção, pagamento, método, provedor, transação externa, status e evento. Ele não importa campanha, opção de contribuição, presente, rifa ou convite.

- **Contrato entre contextos:** Pagamentos recebe `idContribuicao` e um snapshot da composição de valores. Isso permite conversar com Arrecadação e Taxas por IDs e dados públicos, sem misturar modelos internos.

- **Agregado:** `Pagamento` concentra o ciclo de vida do pagamento. Nesta fase, ele só pode sair de `pendente` para `aprovado` ou `rejeitado`.

- **Value Object / Snapshot:** `SnapshotComposicaoValores` guarda os valores que vieram de Taxas no momento de criar a intenção. O pagamento não recalcula a taxa; ele preserva o que recebeu.

- **Portas e adapters:** `PagamentoRepository`, `PagamentoProvider` e `PagamentoEventPublisher` são portas. As versões `memory` e `fake` são adapters simples, trocáveis no futuro.

- **Eventos:** `EventoPagamento` registra fatos importantes, como `payment.intent_created`, `payment.approved` e `payment.rejected` (literais técnicos de integração). O BC Financeiro reage via caso de uso com DTO, sem acoplamento direto.

- **Invariantes:** o valor cobrado deve ser exatamente `totalPaidCents`; um pagamento aprovado não volta para pendente; um pagamento rejeitado não vira aprovado sem uma regra explícita futura.

---

## O que Pagamentos não conhece

Pagamentos não conhece:

- Campanha
- Opção de contribuição
- Presente simbólico
- Rifa
- Convite
- Detalhes da experiência de arrecadação
- Regras de taxa
- Lançamentos financeiros
- Saldo do recebedor
- Receita da plataforma

Ele conhece apenas o necessário para cobrar:

- ID da contribuição
- Composição de valores
- Valor total a cobrar
- Método de pagamento
- Status do pagamento
- Dados mínimos da transação externa simulada

---

# BC Financeiro — o que foi implementado

Este documento descreve a primeira fatia do **bounded context Financeiro** na engine de intermediação financeira: lançamentos em memória, sem Postgres, sem integração bancária real e sem substituir o domínio placeholder `Cat`.

## Resumo em linguagem simples

1. O contexto **Financeiro** recebe dados de um pagamento já aprovado.
2. Ele não cobra pagamento e não calcula taxa.
3. Ele registra dois efeitos financeiros: valor do recebedor no saldo do recebedor e taxa como receita da plataforma.
4. Ele permite consultar saldo pendente/disponível do recebedor e receita acumulada da plataforma.
5. Ele também permite iniciar um pedido de resgate/repasse em estado `solicitado`, sem executar Pix, banco ou gateway real.

Exemplo canônico:

- Valor da contribuição: R$ 80,00 (`8000` centavos)
- Taxa: R$ 4,00 (`400` centavos)
- Total pago pelo contribuinte: R$ 84,00 (`8400` centavos)
- Valor destinado ao recebedor: R$ 80,00 (`8000` centavos)

O Financeiro cria:

- Um lançamento de `8000` centavos para o **Saldo do Recebedor**
- Um lançamento de `400` centavos como **Receita da Plataforma**

O campo `idContribuicao` usado pelo Financeiro é o ID da **contribuição**, não o ID de quem contribuiu. O Financeiro não recebe nem armazena nome, email ou qualquer dado do contribuinte.

---

## Mapa conceito de negócio → código

- **Montante em centavos:** `src/domain/money.ts` — `MoneyCentsSchema`
- **Lançamento Financeiro:** `src/domain/financeiro/financeiro.ts` — `LancamentoFinanceiro`
- **Saldo do Recebedor:** `src/domain/financeiro/financeiro.ts` — `SaldoRecebedor`
- **Receita da Plataforma:** `src/domain/financeiro/financeiro.ts` — `ReceitaPlataforma`
- **Valor Pendente / Disponível:** `src/domain/financeiro/financeiro.ts` — `StatusLancamento` (`pendente`, `disponivel`)
- **Resgate / Repasse:** `src/domain/financeiro/financeiro.ts` — `RepasseRecebedor`
- **Status do Repasse:** `src/domain/financeiro/financeiro.ts` — `StatusRepasse`, por enquanto apenas `solicitado`
- **Snapshot de valores recebido:** `src/domain/financeiro/financeiro.ts` — `SnapshotComposicaoValoresFinanceiro`
- **Porta de persistência:** `src/adapters/financeiro/livro-repository.ts` — `LivroFinanceiroRepository`
- **Persistência em memória:** `src/adapters/financeiro/livro-repository.memory.ts` — `LivroFinanceiroRepositoryMemory`
- **Caso de uso: registrar efeitos:** `src/use-cases/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.ts` — `registrarEfeitosFinanceirosPagamentoAprovado`
- **Caso de uso: consultar saldo:** `src/use-cases/financeiro/obter-saldo-recebedor.ts` — `obterSaldoRecebedor`
- **Caso de uso: consultar receita:** `src/use-cases/financeiro/obter-receita-plataforma.ts` — `obterReceitaPlataforma`
- **Caso de uso: pedir repasse:** `src/use-cases/financeiro/solicitar-repasse-recebedor.ts` — `solicitarRepasseRecebedor`
- **Erros tipados:** `src/errors/financeiro/`
- **API pública:** `src/index.ts`
- **Testes unitários:** `tests/unit/financeiro/financeiro.test.ts`, `tests/unit/financeiro/livro-repository.memory.test.ts`, `tests/unit/financeiro/casos-de-uso.test.ts`

---

## DDD

- **Bounded Context:** Financeiro tem linguagem própria: lançamento, saldo, receita, valor pendente, valor disponível e repasse. Ele não conhece campanha, presente, rifa, convite, provedor de pagamento nem dados do contribuinte.

- **Contrato entre contextos:** Financeiro recebe IDs e um snapshot de valores já decidido por outros contextos. Ele usa `idPagamento`, `idContribuicao`, `idCampanha` (mesmo UUID que `Campanha.id` na orquestração) e composição de valores, sem importar entidades ricas de Arrecadação, Taxas ou Pagamentos. O livro financeiro pode resolver PIX vigente via `findRecebedorAtivoPorIdCampanha`.

- **Evento/fato de domínio:** a regra central é “pagamento aprovado gera efeitos financeiros”. Nesta fase, o caso de uso recebe um DTO enriquecido de pagamento aprovado; uma integração automática por eventos pode ser adicionada depois.

- **Entidade:** `LancamentoFinanceiro` tem identidade própria e representa um fato financeiro registrado. `RepasseRecebedor` também tem identidade e marca o início de um pedido de repasse.

- **Value Object / Snapshot:** `SnapshotComposicaoValoresFinanceiro` representa os valores recebidos. O Financeiro não recalcula taxa; ele usa exatamente `feeAmountCents` e `receiverAmountCents` que recebeu.

- **Porta e adapter:** `LivroFinanceiroRepository` é a porta; `LivroFinanceiroRepositoryMemory` é o adapter em memória para testes e aprendizado.

- **Idempotência:** o mesmo `idPagamento` não pode gerar lançamentos duplicados.

- **Invariantes:** só pagamento aprovado gera lançamentos; `receiverAmountCents + feeAmountCents` precisa bater com `totalPaidCents`; o valor do recebedor vira saldo do recebedor; a taxa vira receita da plataforma.

---

## O que Financeiro não conhece

Financeiro não conhece:

- Nome, email ou identidade do contribuinte
- Campanha
- Opção de contribuição
- Presente simbólico
- Rifa
- Convite
- Regra de taxa
- Provedor de pagamento
- Transação bancária real

Ele conhece apenas o necessário para registrar efeitos financeiros:

- ID do pagamento aprovado
- ID da contribuição que originou o pagamento
- ID do recebedor
- Composição de valores já calculada
- Status aprovado

---

# BC Usuário — o que foi implementado

Este documento descreve a primeira fatia do **bounded context Usuário** na engine didática: usuários que **administram campanhas**, com persistência **em memória**, **sem autenticação real** e **sem base de dados nova**. O **contribuinte** continua sem conta (isso pertence ao produto, não a este BC). O BC é **multi-tenant**: toda conta de administrador pertence a exatamente **uma Plataforma**, e o mesmo email pode coexistir em plataformas diferentes como contas distintas.

## Resumo em linguagem simples

1. Um **administrador** se cadastra **dentro de uma plataforma** (ex.: eunenem) com email, nome de exibição e uma **senha simulada** (não é segurança real). O sistema cria um **usuário** (com `idPlataforma`), uma **conta** (1:1), uma **credencial** em texto para demo e atribui a permissão padrão.
2. O cadastro **valida que a plataforma existe** consultando o `plataformaRepository.findById`. Se a plataforma não existir, o caso de uso falha com `UsuarioPlataformaNaoEncontradaError` antes de qualquer escrita.
3. O **email é único por plataforma**, não globalmente — a uniqueness é composta `(idPlataforma, email)`. A mesma pessoa pode registrar-se em `eunenem` e `eucasei` como duas contas separadas; cada `Usuario` é um registro distinto.
4. O **`idConta`** (UUID) da conta é o mesmo tipo de identificador que o BC **Arrecadação** usa em `idsAdministradores` — a ligação é por **ID**, sem importar modelos entre contextos.
5. É possível **atualizar o perfil** (nome de exibição).
6. É possível abrir uma **sessão fake**: email + senha simulada devolvem um **token opaco** em memória com expiração. A `Sessao` carrega `idPlataforma` diretamente (não derivado via Conta → Usuario) para que verificações de autorização downstream não precisem de múltiplos hops.
7. É possível **verificar uma permissão** com esse token; sessão inválida ou expirada não autoriza; falta de permissão devolve erro explícito.

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Usuário (raiz do agregado, com `idPlataforma`) | [`src/domain/usuario/entities/usuario.ts`](src/domain/usuario/entities/usuario.ts) — `Usuario`, `Conta`, `CredencialSimulada`, `contaTemPermissao` |
| Sessão (agregado separado, escopado por plataforma) | [`src/domain/usuario/entities/sessao.ts`](src/domain/usuario/entities/sessao.ts) — `Sessao`, `sessaoExpirada` |
| Identificadores (`IdUsuario`, `IdContaUsuario`, mirror VO `IdPlataformaReferencia`) | [`src/domain/usuario/value-objects/ids.ts`](src/domain/usuario/value-objects/ids.ts) |
| Demais value objects (email, nome de exibição, permissão, senha simulada, token de sessão) | [`src/domain/usuario/value-objects/`](src/domain/usuario/value-objects) |
| Porta de persistência de usuário/conta/credencial (uniqueness composta) | [`src/adapters/usuario/repository.ts`](src/adapters/usuario/repository.ts) — `UsuarioRepository` (`findUsuarioByEmail(idPlataforma, email)`) |
| Porta de sessões | [`src/adapters/usuario/sessao-repository.ts`](src/adapters/usuario/sessao-repository.ts) — `SessaoUsuarioRepository` |
| Implementações em memória | [`src/adapters/usuario/repository.memory.ts`](src/adapters/usuario/repository.memory.ts), [`src/adapters/usuario/sessao-repository.memory.ts`](src/adapters/usuario/sessao-repository.memory.ts) |
| Caso de uso: cadastro (gate de plataforma) | [`src/use-cases/usuario/registrar-conta-usuario.ts`](src/use-cases/usuario/registrar-conta-usuario.ts) — `registrarContaUsuario` (deps incluem `plataformaRepository`) |
| Caso de uso: atualizar perfil | [`src/use-cases/usuario/atualizar-perfil-usuario.ts`](src/use-cases/usuario/atualizar-perfil-usuario.ts) — `atualizarPerfilUsuario` |
| Caso de uso: sessão fake | [`src/use-cases/usuario/criar-sessao-usuario.ts`](src/use-cases/usuario/criar-sessao-usuario.ts) — `criarSessaoUsuario` |
| Caso de uso: autorizar permissão | [`src/use-cases/usuario/autorizar-permissao-usuario.ts`](src/use-cases/usuario/autorizar-permissao-usuario.ts) — `autorizarPermissaoUsuario` |
| Erros (inclui `UsuarioPlataformaNaoEncontradaError`) | [`src/errors/usuario/`](src/errors/usuario) |
| API pública do pacote | [`src/index.ts`](src/index.ts) |
| Testes unitários | [`tests/unit/usuario/`](tests/unit/usuario) — predicados de domínio, contrato do repositório em memória, 4 casos de uso (incluindo modos de falha) |

---

## DDD

- **Bounded context:** o vocabulário de usuário, conta, sessão e permissão vive aqui; **não** aparecem campanhas, contribuições, taxas ou pagamentos no domínio do Usuário.
- **Linguagem ubíqua:** nomes em código (`Usuario`, `Conta`, `registrarContaUsuario`) alinham com o produto descrito em [`ENGINE-DDD.md`](ENGINE-DDD.md).
- **Multi-tenant por design:** todo `Usuario` carrega `idPlataforma`; toda `Sessao` carrega `idPlataforma`; a uniqueness de email é **composta** `(idPlataforma, email)`, não global. O `IdPlataformaReferencia` é um **mirror VO** local (mesmo shape UUID que `IdPlataforma`) — o domínio do Usuário **não importa** de `src/domain/plataforma/`. A regra é enforçada pelo `dependency-cruiser`.
- **Agregados / invariantes (didático):** **uma conta pertence a um usuário** (1:1) e é persistida **atomicamente** com a credencial via `saveRegistro({usuario, conta, credencial})`; sessão inválida ou expirada **não autoriza**; sessão tem o **`idConta` como principal de autenticação** (não o `idUsuario`).
- **Value objects / validação na fronteira:** email normalizado, token de sessão opaco (`base64url(32)`), permissões enumeradas — validados com Zod nos inputs dos casos de uso.
- **Repositório (porta + adaptador):** interfaces em `adapters/` e `*.memory.ts` para testes e demos sem Postgres. `findUsuarioByEmail` recebe `(idPlataforma, email)` para refletir a uniqueness composta na assinatura.
- **Serviço de aplicação:** cada arquivo em `use-cases/` orquestra validação, leituras e persistência; a “autenticação” é **consciente de ser fake** (senha simulada, token opaco). `registrarContaUsuario` consulta `plataformaRepository.findById` antes de qualquer escrita — gate cross-BC explícito.
- **Integração com Plataforma:** dependência soft via `IdPlataformaReferencia` no domínio + gate explícito (`plataformaRepository.findById`) na aplicação. Cadastros com plataforma inexistente falham com `UsuarioPlataformaNaoEncontradaError`.
- **Integração com Arrecadação:** o BC Arrecadação guarda uma lista de UUIDs (`idsAdministradores`). O significado “conta registrada no Usuário” é responsabilidade da **aplicação** (orquestração) ou de testes que chamam primeiro `registrarContaUsuario` e depois `criarCampanha` com o mesmo `idConta` na lista — **sem** acoplar o domínio de campanhas ao de usuários.

---

# BC Evento (supporting) — fase 1

Bounded context de **suporte** ao produto (convites digitais, RSVP): fora do core Arrecadação → Taxas → Pagamentos → Financeiro. Nesta fase só o subdomínio **Evento** (agregado raiz) está implementado.

## Resumo em linguagem simples

1. Uma **campanha** pode ter **no máximo um evento** (relação 1:1 por `idCampanha`).
2. O evento guarda **tipo** (chá de bebê, chá de fraldas, …), **modalidade** (presencial ou online), **data/hora** e **endereço** opcional.
3. O agregado **não** guarda `idPlataforma` — o escopo de tenant vem da campanha; a app valida que o admin só opera na própria campanha.
4. **Convite** (texto, personalização) e **lista de convidados** (RSVP) estão **planejados** no mesmo BC, fase 2+.

## Mapa conceito → código

| Conceito | Onde está |
|----------|-----------|
| Evento (agregado raiz) | [`src/domain/evento/entities/evento.ts`](src/domain/evento/entities/evento.ts) |
| Identificadores | [`src/domain/evento/value-objects/ids.ts`](src/domain/evento/value-objects/ids.ts) |
| Tipo / modalidade / data-hora / endereço | [`src/domain/evento/value-objects/`](src/domain/evento/value-objects/) |
| Porta de persistência | [`src/adapters/evento/evento-repository.ts`](src/adapters/evento/evento-repository.ts) |
| Memória + índice 1:1 campanha | [`src/adapters/evento/evento-repository.memory.ts`](src/adapters/evento/evento-repository.memory.ts) |
| `criarEvento` | [`src/use-cases/evento/criar-evento.ts`](src/use-cases/evento/criar-evento.ts) |
| `atualizarEvento` | [`src/use-cases/evento/atualizar-evento.ts`](src/use-cases/evento/atualizar-evento.ts) |
| `obterEventoPorId` / `obterEventoPorIdCampanha` | [`src/use-cases/evento/obter-evento-por-id.ts`](src/use-cases/evento/obter-evento-por-id.ts), [`obter-evento-por-id-campanha.ts`](src/use-cases/evento/obter-evento-por-id-campanha.ts) |
| Erros | [`src/errors/evento/`](src/errors/evento/) |
| API pública | [`src/index.ts`](src/index.ts) — seção `Domain: Evento` |
| Testes | [`tests/unit/evento/`](tests/unit/evento/) |

## Planejado (mesmo BC)

- **Convite** — 1:1 com `IdEvento`; nome exibido, mensagem, paleta/fonte/modelo.
- **Lista de convidados** — convidados por evento; presença `sim` / `nao` / `talvez`; link de confirmação.
- **Postgres** — migration `eventos`, adapter, testes de integração.

---

# Orquestração — Checkout (pseudo-BC)

O **Checkout** é um **pseudo-bounded-context**: existe apenas como casos de uso em [`src/use-cases/checkout/`](src/use-cases/checkout) e erros tipados em [`src/errors/checkout/`](src/errors/checkout). **Não há `src/domain/checkout/` nem `src/adapters/checkout/`** — Checkout não tem entidades, value objects, agregados nem repositórios próprios. Sua única responsabilidade é **orquestrar BCs reais (Arrecadação, Taxas, Pagamentos, Financeiro)** em sagas multi-passo com **compensação explícita** quando algum passo falha.

## Resumo em linguagem simples

1. Quando o contribuinte clica “quero este item”, o sistema precisa: validar a plataforma da campanha, **reservar** a contribuição (Arrecadação), **calcular** a composição de valores (Taxas) e **criar** a intenção de pagamento (Pagamentos). Se qualquer passo a partir da reserva falhar, a contribuição precisa **voltar a `disponivel`**. Esse é o trabalho do Checkout.
2. Os passos vivem em BCs separados. O Checkout **não** estende o domínio de nenhum deles — apenas chama os casos de uso já existentes na ordem certa e desfaz o que precisar via casos de uso de **compensação** (`desassociarContribuinteContribuicao`, etc.).
3. Todas as sagas que cruzam plataformas (write-side e leituras pré-calculadas) **verificam coerência multi-tenant** comparando `input.idPlataforma` com `campanha.idPlataforma` e lançando `CheckoutPlataformaMismatchError` se houver mismatch. É o **guard cross-tenant** explícito no orquestrador.

---

## Casos de uso implementados

| Caso de uso | Responsabilidade |
|-------------|------------------|
| [`iniciarPagamentoContribuicao`](src/use-cases/checkout/iniciar-pagamento-contribuicao.ts) | Saga write-side principal: gate de plataforma → `associarContribuinteContribuicao` (Arrecadação) → `calcularComposicaoValores` (Taxas, plataforma + tipo escopados) → `criarIntencaoPagamento` (Pagamentos). **Compensa** com `desassociarContribuinteContribuicao` se passo 3 ou 4 falhar. Compensação falhar é logado mas não substitui o erro original. |
| [`finalizarPagamentoAprovado`](src/use-cases/checkout/finalizar-pagamento-aprovado.ts) | Saga de confirmação: `aprovarPagamento` (Pagamentos) → `registrarEfeitosFinanceirosPagamentoAprovado` (Financeiro). Devolve o pagamento atualizado + lançamentos criados. |
| [`finalizarPagamentoRejeitado`](src/use-cases/checkout/finalizar-pagamento-rejeitado.ts) | Saga de rejeição: `rejeitarPagamento` (Pagamentos) → `desassociarContribuinteContribuicao` (Arrecadação). Libera a contribuição para reuso. |
| [`iniciarRepasseRecebedor`](src/use-cases/checkout/iniciar-repasse-recebedor.ts) | Saga de repasse: gate de plataforma → resolve o recebedor ativo (Arrecadação) → `solicitarRepasseRecebedor` (Financeiro). |
| [`obterContribuicoesPrecalculadasCampanha`](src/use-cases/checkout/obter-contribuicoes-precalculadas-campanha.ts) | Read-side: gate de plataforma → lista contribuições disponíveis + aplica `calcularComposicaoValores` em cada uma. Pré-monta o snapshot para a UI sem efeitos colaterais. |

---

## DDD

- **Pseudo-BC, não BC real:** sem domínio próprio. Toda regra de negócio vive nos BCs orquestrados (Arrecadação, Taxas, Pagamentos, Financeiro). O Checkout adiciona **apenas** orquestração + um erro cross-tenant (`CheckoutPlataformaMismatchError`).

- **Padrão saga com compensação:** o write-side principal (`iniciarPagamentoContribuicao`) ilustra a disciplina: o **primeiro passo com efeito colateral** (associar contribuição) tem uma **compensação registrada explicitamente** num `try/catch` que envolve os passos subsequentes. Se qualquer passo posterior falha, a compensação é chamada antes de o erro original ser re-lançado.

- **Guard cross-tenant:** toda saga que recebe `idPlataforma` no input compara com o `campanha.idPlataforma` carregado do repositório e lança `CheckoutPlataformaMismatchError` se forem diferentes. Isso fecha a superfície de ataque “consigo um id de campanha de outra plataforma e tento pagá-la pela minha”. O erro tipado torna a intenção visível no call-site (vs. um 404 genérico) e o span registra o mismatch com atributos estruturados para auditoria.

- **Sem novos modelos:** Checkout não cria entidades, agregados, value objects nem ports. Ele consome os modelos públicos dos BCs (`Campanha`, `Contribuicao`, `Pagamento`, `LancamentoFinanceiro`, etc.) e devolve composições deles ao chamador.

- **Observabilidade:** cada saga abre um span próprio (`iniciarPagamentoContribuicao`, `finalizarPagamentoAprovado`, ...) com atributos `checkout.*` para correlacionar os passos. Eventos de compensação são logados em chave própria (`checkout.pagamento.compensado`, `checkout.pagamento.compensacao_falhou`).

---

## O que Checkout não conhece

Checkout não conhece detalhes internos de nenhum BC. Em particular, ele não conhece:

- A estrutura das opções de contribuição além de saber que existe um `tipo` que Taxas precisa para resolver a tarifa
- A política de cálculo de taxa (delega 100% a Taxas)
- O provedor de pagamento ou como aprovação acontece (chama os casos de uso de Pagamentos)
- A representação interna de lançamentos financeiros (recebe o array que Financeiro devolve e repassa)

Ele conhece apenas a **ordem dos passos**, as **deps necessárias para chamá-los**, e a **regra de compensação** quando um passo intermediário falha.

---

## Operação e qualidade (`pnpm check`)

### Comandos úteis (Postgres / Arrecadação)

```bash
pnpm db:up          # Postgres local (porta 54320)
pnpm db:migrate     # aplica migrations
pnpm db:codegen     # regenera src/adapters/db-types.generated.ts
```

O `pnpm check` completo exige **Docker** (Testcontainers nos testes de integração Postgres + `check:codegen-drift`). Os testes unitários dos BCs em memória não dependem de Docker.
