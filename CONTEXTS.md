# Contextos da engine — documentação consolidada

Este ficheiro reúne a documentação dos **bounded contexts** já implementados na engine de intermediação financeira (skeleton Frame, em memória). A ordem segue o fluxo natural do negócio: arrecadação → taxas → pagamentos → financeiro, com **usuário** como contexto transversal de administração.

---

## Índice

1. [BC Arrecadação](#bc-arrecadação--o-que-foi-implementado)
2. [BC Taxas](#bc-taxas--o-que-foi-implementado)
3. [BC Pagamentos](#bc-pagamentos--o-que-foi-implementado)
4. [BC Financeiro](#bc-financeiro--o-que-foi-implementado)
5. [BC Usuário](#bc-usuário--o-que-foi-implementado)

---

# BC Arrecadação — o que foi implementado

Este documento descreve a primeira fatia da **engine de intermediação financeira** no repositório (skeleton Frame): o **bounded context Arrecadação**, em memória, sem base de dados nova e sem autenticação real. O objetivo é aprender DDD vendo o código.

## Resumo em linguagem simples

1. Um ou mais **administradores** (UUIDs de conta) abrem uma **campanha** com título e registam o **recebedor** externo (nome + chave PIX em `dadosRecebedor`); o sistema gera `idRecebedor` para o Financeiro.
2. A campanha começa sem **opções de contribuição**; depois podes acrescentar opções (cada uma com valor em **centavos** e rótulo opcional).
3. Um **contribuinte visitante** (sem conta) escolhe uma opção: o sistema regista uma **contribuição** com o valor **copiado da opção** naquele momento, estado `pendente_pagamento`, e dados mínimos do visitante (nome de exibição e email opcional).

Nada disto cobra pagamento nem calcula taxa — isso será outros bounded contexts.

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Montante em centavos (evitar `number` em reais) | [`src/domain/money.ts`](src/domain/money.ts) — `MoneyCentsSchema` |
| Campanha, administradores, recebedor (`dadosRecebedor`, `idRecebedor`), opção de contribuição | [`src/domain/arrecadacao/campanha.ts`](src/domain/arrecadacao/campanha.ts) — `Campanha`, `DadosRecebedor`, `OpcaoContribuicao` |
| Procurar opção na campanha (função pura) | [`src/domain/arrecadacao/campanha.ts`](src/domain/arrecadacao/campanha.ts) — `encontrarOpcaoContribuicao` |
| Anexar opção de forma imutável | [`src/domain/arrecadacao/campanha.ts`](src/domain/arrecadacao/campanha.ts) — `campanhaComOpcao` |
| Contribuição, dados do visitante, input de criação | [`src/domain/arrecadacao/contribuicao.ts`](src/domain/arrecadacao/contribuicao.ts) |
| Persistência em memória da campanha | [`src/adapters/arrecadacao/campanha-repository.memory.ts`](src/adapters/arrecadacao/campanha-repository.memory.ts) |
| Persistência em memória das contribuições | [`src/adapters/arrecadacao/contribuicao-repository.memory.ts`](src/adapters/arrecadacao/contribuicao-repository.memory.ts) |
| Portas (interfaces) | [`src/adapters/arrecadacao/campanha-repository.ts`](src/adapters/arrecadacao/campanha-repository.ts) — `CampanhaRepository`; [`src/adapters/arrecadacao/contribuicao-repository.ts`](src/adapters/arrecadacao/contribuicao-repository.ts) — `ContribuicaoRepository` |
| Caso de uso: criar campanha | [`src/use-cases/arrecadacao/criar-campanha.ts`](src/use-cases/arrecadacao/criar-campanha.ts) — `criarCampanha` |
| Caso de uso: adicionar administrador | [`src/use-cases/arrecadacao/adicionar-administrador-campanha.ts`](src/use-cases/arrecadacao/adicionar-administrador-campanha.ts) — `adicionarAdministradorCampanha` |
| Caso de uso: remover administrador | [`src/use-cases/arrecadacao/remover-administrador-campanha.ts`](src/use-cases/arrecadacao/remover-administrador-campanha.ts) — `removerAdministradorCampanha` |
| Caso de uso: adicionar opção | [`src/use-cases/arrecadacao/adicionar-opcao-contribuicao.ts`](src/use-cases/arrecadacao/adicionar-opcao-contribuicao.ts) — `adicionarOpcaoContribuicao` |
| Caso de uso: criar contribuição a partir da opção | [`src/use-cases/arrecadacao/criar-contribuicao.ts`](src/use-cases/arrecadacao/criar-contribuicao.ts) — `criarContribuicao` |
| Erros de domínio / aplicação | [`src/errors/arrecadacao/`](src/errors/arrecadacao) |
| API pública do pacote (re-exports) | [`src/index.ts`](src/index.ts) |
| Testes unitários | [`tests/unit/money.test.ts`](tests/unit/money.test.ts), [`tests/unit/arrecadacao/campanha.test.ts`](tests/unit/arrecadacao/campanha.test.ts), [`tests/unit/arrecadacao/contribuicao.test.ts`](tests/unit/arrecadacao/contribuicao.test.ts), [`tests/unit/arrecadacao/casos-de-uso.test.ts`](tests/unit/arrecadacao/casos-de-uso.test.ts) |

---

## DDD

- **Bounded context (contexto delimitado):** ficheiros na subpasta `arrecadacao/` em domínio, adaptadores, erros e casos de uso. Toda a linguagem (campanha, opção, contribuição, visitante) vive aqui; não aparecem “pagamentos” ou “taxas” neste BC.

- **Ubiquitous language (linguagem ubíqua):** os nomes em TypeScript (`Campanha`, `OpcaoContribuicao`, `criarContribuicao`) alinham com a conversa de produto em [`ENGINE-DDD.md`](ENGINE-DDD.md).

- **Value object:** `MoneyCents` (via schema) e o perfil do contribuinte são valores validados nas fronteiras, sem identidade própria.

- **Entidade:** `Campanha` e `Contribuicao` têm **id** estável e ciclo de vida; a campanha **muda** quando acrescentas opções (nova versão imutável do agregado).

- **Agregado:** nesta versão didática, a **Campanha** é a raiz que contém a lista de **opções**. A **Contribuição** é outra entidade guardada à parte, referenciando `idCampanha` e `idOpcaoContribuicao` — uma escolha de modelação para evitar uma lista gigante de contribuições dentro da campanha em memória; podes evoluir para agregado “mais fechado” mais tarde.

- **Repositório (padrão):** interfaces `CampanhaRepository` e `ContribuicaoRepository` são **portas**; as classes `*.memory.ts` são **adaptadores** para testes e demos sem Postgres.

- **Caso de uso / serviço de aplicação:** cada ficheiro em `src/use-cases/` orquestra validação (Zod), leituras do repositório, invariantes (ex.: opção duplicada) e persistência.

- **Invariantes:** exemplo — não podes adicionar duas opções com o mesmo `id` na mesma campanha (`ArrecadacaoOpcaoIdDuplicadoError`); o valor da contribuição **copia** o da opção para ficar fixo mesmo que a opção mude no futuro.

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

- **Contrato entre contextos:** Financeiro recebe IDs e um snapshot de valores já decidido por outros contextos. Ele usa `idPagamento`, `idContribuicao`, `idRecebedor` e composição de valores, sem importar entidades ricas de Arrecadação, Taxas ou Pagamentos.

- **Evento/fato de domínio:** a regra central é “pagamento aprovado gera efeitos financeiros”. Nesta fase, o caso de uso recebe um DTO enriquecido de pagamento aprovado; uma integração automática por eventos pode vir depois.

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

Este documento descreve a primeira fatia do **bounded context Usuário** na engine didática: utilizadores que **administram campanhas**, com persistência **em memória**, **sem autenticação real** e **sem base de dados nova**. O **contribuinte** continua sem conta (isso pertence ao produto, não a este BC).

## Resumo em linguagem simples

1. Um **administrador** regista-se com email, nome de exibição e uma **palavra-passe simulada** (não é segurança real). O sistema cria um **utilizador**, uma **conta** (1:1), uma **credencial** em texto para demo e atribui a permissão `campaign:admin`.
2. O **`idConta`** (UUID) da conta é o mesmo tipo de identificador que o BC **Arrecadação** usa em `idsAdministradores` — a ligação é por **ID**, sem importar modelos entre contextos.
3. Podes **atualizar o perfil** (nome de exibição).
4. Podes abrir uma **sessão fake**: email + palavra-passe simulada devolvem um **token opaco** em memória com expiração.
5. Podes **verificar uma permissão** com esse token; sessão inválida ou expirada não autoriza; falta de permissão devolve erro explícito.

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Utilizador, conta, email, perfil (nome de exibição), sessão, permissão, credencial simulada | [`src/domain/usuario/usuario.ts`](src/domain/usuario/usuario.ts) |
| Regras puras (sessão expirada?, tem permissão?) | [`src/domain/usuario/usuario.ts`](src/domain/usuario/usuario.ts) — `sessaoExpirada`, `contaTemPermissao` |
| Porta de persistência de utilizador/conta/credencial | [`src/adapters/usuario/repository.ts`](src/adapters/usuario/repository.ts) — `UsuarioRepository` |
| Porta de sessões | [`src/adapters/usuario/sessao-repository.ts`](src/adapters/usuario/sessao-repository.ts) — `SessaoUsuarioRepository` |
| Implementações em memória | [`src/adapters/usuario/repository.memory.ts`](src/adapters/usuario/repository.memory.ts), [`src/adapters/usuario/sessao-repository.memory.ts`](src/adapters/usuario/sessao-repository.memory.ts) |
| Caso de uso: registo | [`src/use-cases/usuario/registrar-conta-usuario.ts`](src/use-cases/usuario/registrar-conta-usuario.ts) — `registrarContaUsuario` |
| Caso de uso: atualizar perfil | [`src/use-cases/usuario/atualizar-perfil-usuario.ts`](src/use-cases/usuario/atualizar-perfil-usuario.ts) — `atualizarPerfilUsuario` |
| Caso de uso: sessão fake | [`src/use-cases/usuario/criar-sessao-usuario.ts`](src/use-cases/usuario/criar-sessao-usuario.ts) — `criarSessaoUsuario` |
| Caso de uso: autorizar permissão | [`src/use-cases/usuario/autorizar-permissao-usuario.ts`](src/use-cases/usuario/autorizar-permissao-usuario.ts) — `autorizarPermissaoUsuario` |
| Erros | [`src/errors/usuario/`](src/errors/usuario) |
| API pública do pacote | [`src/index.ts`](src/index.ts) |
| Testes unitários | [`tests/unit/usuario/usuario.test.ts`](tests/unit/usuario/usuario.test.ts), [`tests/unit/usuario/repository.memory.test.ts`](tests/unit/usuario/repository.memory.test.ts), [`tests/unit/usuario/casos-de-uso.test.ts`](tests/unit/usuario/casos-de-uso.test.ts) |

---

## DDD

- **Bounded context:** o vocabulário de utilizador, conta, sessão e permissão vive aqui; **não** aparecem campanhas, contribuições, taxas ou pagamentos no domínio do Usuário.
- **Linguagem ubíqua:** nomes em código (`Usuario`, `Conta`, `registrarContaUsuario`) alinham com o produto descrito em [`PROMTP-BASE.md`](PROMTP-BASE.md) e [`ENGINE-DDD.md`](ENGINE-DDD.md).
- **Agregado / invariantes (didático):** nesta fatia, **uma conta pertence a um utilizador** (relação 1:1); o email é **único**; sessão inválida ou expirada **não autoriza**.
- **Value objects / validação na fronteira:** email normalizado, token de sessão com comprimento mínimo, permissões enumeradas — validados com Zod nos inputs dos casos de uso.
- **Repositório (porta + adaptador):** interfaces em `adapters/` e `*.memory.ts` para testes e demos sem Postgres.
- **Serviço de aplicação:** cada ficheiro em `use-cases/` orquestra validação, leituras e persistência; a “autenticação” é **consciente de ser fake** (palavra-passe simulada, token opaco).
- **Integração com Arrecadação:** o BC Arrecadação guarda uma lista de UUIDs (`idsAdministradores`). O significado “conta registada no Usuário” é responsabilidade da **aplicação** (orquestração) ou de testes que chamam primeiro `registrarContaUsuario` e depois `criarCampanha` com o mesmo `idConta` na lista — **sem** acoplar o domínio de campanhas ao de utilizadores.
