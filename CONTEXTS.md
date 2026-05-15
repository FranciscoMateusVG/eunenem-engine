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

1. Um **criador** (identificado só por um UUID de “conta”, sem login) abre uma **campanha** com título e indica quem é o **recebedor** (também só um UUID).
2. A campanha começa sem **opções de contribuição**; depois podes acrescentar opções (cada uma com valor em **centavos** e rótulo opcional).
3. Um **contribuinte visitante** (sem conta) escolhe uma opção: o sistema regista uma **contribuição** com o valor **copiado da opção** naquele momento, estado `pending_payment`, e dados mínimos do visitante (nome de exibição e email opcional).

Nada disto cobra pagamento nem calcula taxa — isso será outros bounded contexts.

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Montante em centavos (evitar `number` em reais) | [`src/domain/money.ts`](src/domain/money.ts) — `MoneyCentsSchema` |
| Campanha, recebedor, criador, opção de contribuição | [`src/domain/fundraising-campaign.ts`](src/domain/fundraising-campaign.ts) — tipos `Campaign`, `ContributionOption`, schemas Zod |
| Procurar opção na campanha (função pura) | [`src/domain/fundraising-campaign.ts`](src/domain/fundraising-campaign.ts) — `findContributionOption` |
| Anexar opção de forma imutável | [`src/domain/fundraising-campaign.ts`](src/domain/fundraising-campaign.ts) — `campaignWithOption` |
| Contribuição, perfil do visitante, input de criação | [`src/domain/fundraising-contribution.ts`](src/domain/fundraising-contribution.ts) |
| Persistência em memória da campanha | [`src/adapters/fundraising-campaign-repository.memory.ts`](src/adapters/fundraising-campaign-repository.memory.ts) |
| Persistência em memória das contribuições | [`src/adapters/fundraising-contribution-repository.memory.ts`](src/adapters/fundraising-contribution-repository.memory.ts) |
| Portas (interfaces) | [`src/adapters/fundraising-campaign-repository.ts`](src/adapters/fundraising-campaign-repository.ts), [`src/adapters/fundraising-contribution-repository.ts`](src/adapters/fundraising-contribution-repository.ts) |
| Caso de uso: criar campanha | [`src/use-cases/create-fundraising-campaign.ts`](src/use-cases/create-fundraising-campaign.ts) |
| Caso de uso: adicionar opção | [`src/use-cases/add-fundraising-contribution-option.ts`](src/use-cases/add-fundraising-contribution-option.ts) |
| Caso de uso: criar contribuição a partir da opção | [`src/use-cases/create-fundraising-contribution.ts`](src/use-cases/create-fundraising-contribution.ts) |
| Erros de domínio / aplicação | [`src/errors/fundraising-*.error.ts`](src/errors) |
| API pública do pacote (re-exports) | [`src/index.ts`](src/index.ts) |
| Testes unitários | [`tests/unit/money.test.ts`](tests/unit/money.test.ts), [`tests/unit/fundraising-campaign.test.ts`](tests/unit/fundraising-campaign.test.ts), [`tests/unit/fundraising-contribution.test.ts`](tests/unit/fundraising-contribution.test.ts), [`tests/unit/fundraising-use-cases.test.ts`](tests/unit/fundraising-use-cases.test.ts) |

---

## DDD

- **Bounded context (contexto delimitado):** a pasta não se chama “arrecadação”, mas todos os ficheiros novos usam prefixo `fundraising-` ou nomes explícitos. Toda a linguagem (campanha, opção, contribuição, visitante) vive aqui; não aparecem “pagamentos” ou “taxas” neste BC.

- **Ubiquitous language (linguagem ubíqua):** os nomes em TypeScript (`Campaign`, `ContributionOption`, `createFundraisingContribution`) alinham com a conversa de produto.

- **Value object:** `MoneyCents` (via schema) e o perfil do contribuinte são valores validados nas fronteiras, sem identidade própria.

- **Entidade:** `Campaign` e `Contribution` têm **id** estável e ciclo de vida; a campanha **muda** quando acrescentas opções (nova versão imutável do agregado).

- **Agregado:** nesta versão didática, a **Campanha** é a raiz que contém a lista de **opções**. A **Contribuição** é outra entidade guardada à parte, referenciando `campaignId` e `contributionOptionId` — uma escolha de modelação para evitar uma lista gigante de contribuições dentro da campanha em memória; podes evoluir para agregado “mais fechado” mais tarde.

- **Repositório (padrão):** interfaces `FundraisingCampaignRepository` e `FundraisingContributionRepository` são **portas**; as classes `*.memory.ts` são **adaptadores** para testes e demos sem Postgres.

- **Caso de uso / serviço de aplicação:** cada ficheiro em `src/use-cases/` orquestra validação (Zod), leituras do repositório, invariantes (ex.: opção duplicada) e persistência.

- **Invariantes:** exemplo — não podes adicionar duas opções com o mesmo `optionId` na mesma campanha (`FundraisingDuplicateOptionIdError`); o valor da contribuição **copia** o da opção para ficar fixo mesmo que a opção mude no futuro.

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
- **Regra de Taxa:** `src/domain/fees.ts` — `FeeRule`, `DEFAULT_FEE_RULE`
- **Responsável pela Taxa:** `src/domain/fees.ts` — `FeePayer`, por enquanto apenas `contributor`
- **Cálculo de Taxa:** `src/domain/fees.ts` — `calculatePercentageFeeAmount` e `calculateFee`
- **Composição de Valores:** `src/domain/fees.ts` — `ValueComposition`, `composeValueComposition` e `calculateValueComposition`
- **Porta para regra ativa:** `src/adapters/fee-rule-provider.ts` — `FeeRuleProvider`
- **Regra em memória:** `src/adapters/fee-rule-provider.memory.ts` — `FeeRuleProviderMemory`
- **Caso de uso:** `src/use-cases/calculate-fee-composition.ts` — `calculateFeeComposition`
- **Erro tipado:** `src/errors/fees-invalid-input.error.ts` — `FeesInvalidInputError`
- **API pública:** `src/index.ts`
- **Testes unitários:** `tests/unit/fees.test.ts`, `tests/unit/fee-rule-provider.memory.test.ts`, `tests/unit/calculate-fee-composition.test.ts`

---

## DDD

- **Bounded Context:** Taxas tem vocabulário próprio e não importa entidades ricas de Arrecadação. A contribuição entra apenas como `contributionId` e `contributionAmountCents`.

- **Linguagem Ubíqua:** os nomes `FeeRule`, `FeeCalculation`, `ValueComposition`, `feePayer` e `receiverAmountCents` refletem diretamente a conversa de produto.

- **Value Object:** a composição de valores é um conjunto imutável de valores calculados. Dinheiro continua representado em centavos para evitar problemas de ponto flutuante em reais.

- **Função pura de domínio:** `calculateValueComposition` calcula a composição sem banco, HTTP, logs ou efeitos colaterais.

- **Porta e adapter:** `FeeRuleProvider` é a porta; `FeeRuleProviderMemory` é um adapter em memória que entrega a regra ativa de 5%.

- **Caso de uso / serviço de aplicação:** `calculateFeeComposition` valida a entrada, busca a regra ativa, chama o domínio e registra observabilidade.

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
3. O pagamento nasce com status `pending`.
4. Um **provedor fake** simula a resposta externa e pode aprovar ou rejeitar.
5. O pagamento muda para `approved` ou `rejected` e um evento é publicado em memória.

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
- **Intenção de Pagamento:** `src/domain/payments.ts` — `PaymentIntent`
- **Pagamento:** `src/domain/payments.ts` — `Payment`
- **Método de Pagamento:** `src/domain/payments.ts` — `PaymentMethod`, por enquanto `pix` e `credit_card`
- **Status do Pagamento:** `src/domain/payments.ts` — `PaymentStatus`, com `pending`, `approved` e `rejected`
- **Composição de Valores recebida de Taxas:** `src/domain/payments.ts` — `PaymentValueCompositionSnapshot`
- **Transação Externa simulada:** `src/domain/payments.ts` — `ExternalPaymentTransaction`
- **Evento de Pagamento:** `src/domain/payments.ts` — `PaymentEvent`
- **Porta de persistência:** `src/adapters/payment-repository.ts` — `PaymentRepository`
- **Persistência em memória:** `src/adapters/payment-repository.memory.ts` — `PaymentRepositoryMemory`
- **Porta do provedor:** `src/adapters/payment-provider.ts` — `PaymentProvider`
- **Provedor fake:** `src/adapters/payment-provider.fake.ts` — `PaymentProviderFake`
- **Porta de eventos:** `src/adapters/payment-event-publisher.ts` — `PaymentEventPublisher`
- **Eventos em memória:** `src/adapters/payment-event-publisher.memory.ts` — `PaymentEventPublisherMemory`
- **Caso de uso: criar intenção:** `src/use-cases/create-payment-intent.ts` — `createPaymentIntent`
- **Caso de uso: aprovar pagamento:** `src/use-cases/approve-payment.ts` — `approvePayment`
- **Caso de uso: rejeitar pagamento:** `src/use-cases/reject-payment.ts` — `rejectPayment`
- **Caso de uso: consultar pagamento:** `src/use-cases/get-payment-by-id.ts` — `getPaymentById`
- **Erros tipados:** `src/errors/payment-*.error.ts` e `src/errors/payments-invalid-input.error.ts`
- **API pública:** `src/index.ts`
- **Testes unitários:** `tests/unit/payments.test.ts`, `tests/unit/payment-repository.memory.test.ts`, `tests/unit/payment-provider.fake.test.ts`, `tests/unit/payment-event-publisher.memory.test.ts`, `tests/unit/payment-use-cases.test.ts`

---

## DDD

- **Bounded Context:** Pagamentos tem linguagem própria: intenção, pagamento, método, provedor, transação externa, status e evento. Ele não importa campanha, opção de contribuição, presente, rifa ou convite.

- **Contrato entre contextos:** Pagamentos recebe `contributionId` e um snapshot da composição de valores. Isso permite conversar com Arrecadação e Taxas por IDs e dados públicos, sem misturar modelos internos.

- **Agregado:** `Payment` concentra o ciclo de vida do pagamento. Nesta fase, ele só pode sair de `pending` para `approved` ou `rejected`.

- **Value Object / Snapshot:** `PaymentValueCompositionSnapshot` guarda os valores que vieram de Taxas no momento de criar a intenção. O pagamento não recalcula a taxa; ele preserva o que recebeu.

- **Portas e adapters:** `PaymentRepository`, `PaymentProvider` e `PaymentEventPublisher` são portas. As versões `memory` e `fake` são adapters simples, trocáveis no futuro.

- **Eventos:** `PaymentEvent` registra fatos importantes, como `payment.intent_created`, `payment.approved` e `payment.rejected`. O futuro BC Financeiro poderá reagir a estes fatos sem Pagamentos conhecer os lançamentos financeiros.

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
5. Ele também permite iniciar um pedido de resgate/repasse em estado `requested`, sem executar Pix, banco ou gateway real.

Exemplo canônico:

- Valor da contribuição: R$ 80,00 (`8000` centavos)
- Taxa: R$ 4,00 (`400` centavos)
- Total pago pelo contribuinte: R$ 84,00 (`8400` centavos)
- Valor destinado ao recebedor: R$ 80,00 (`8000` centavos)

O Financeiro cria:

- Um lançamento de `8000` centavos para o **Saldo do Recebedor**
- Um lançamento de `400` centavos como **Receita da Plataforma**

O campo `contributionId` usado pelo Financeiro é o ID da **contribuição**, não o ID de quem contribuiu. O Financeiro não recebe nem armazena nome, email ou qualquer dado do contribuinte.

---

## Mapa conceito de negócio → código

- **Montante em centavos:** `src/domain/money.ts` — `MoneyCentsSchema`
- **Lançamento Financeiro:** `src/domain/financial.ts` — `FinancialEntry`
- **Saldo do Recebedor:** `src/domain/financial.ts` — `ReceiverFinancialBalance`
- **Receita da Plataforma:** `src/domain/financial.ts` — `PlatformRevenue`
- **Valor Pendente / Disponível:** `src/domain/financial.ts` — `FinancialEntryStatus`
- **Resgate / Repasse:** `src/domain/financial.ts` — `ReceiverPayout`
- **Status do Repasse:** `src/domain/financial.ts` — `PayoutStatus`, por enquanto apenas `requested`
- **Snapshot de valores recebido:** `src/domain/financial.ts` — `FinancialValueCompositionSnapshot`
- **Porta de persistência:** `src/adapters/financial-ledger-repository.ts` — `FinancialLedgerRepository`
- **Persistência em memória:** `src/adapters/financial-ledger-repository.memory.ts` — `FinancialLedgerRepositoryMemory`
- **Caso de uso: registrar efeitos:** `src/use-cases/register-approved-payment-financial-effects.ts`
- **Caso de uso: consultar saldo:** `src/use-cases/get-receiver-financial-balance.ts`
- **Caso de uso: consultar receita:** `src/use-cases/get-platform-revenue.ts`
- **Caso de uso: pedir repasse:** `src/use-cases/request-receiver-payout.ts`
- **Erros tipados:** `src/errors/financial-*.error.ts`
- **API pública:** `src/index.ts`
- **Testes unitários:** `tests/unit/financial.test.ts`, `tests/unit/financial-ledger-repository.memory.test.ts`, `tests/unit/financial-use-cases.test.ts`

---

## DDD

- **Bounded Context:** Financeiro tem linguagem própria: lançamento, saldo, receita, valor pendente, valor disponível e repasse. Ele não conhece campanha, presente, rifa, convite, provedor de pagamento nem dados do contribuinte.

- **Contrato entre contextos:** Financeiro recebe IDs e um snapshot de valores já decidido por outros contextos. Ele usa `paymentId`, `contributionId`, `receiverId` e composição de valores, sem importar entidades ricas de Arrecadação, Taxas ou Pagamentos.

- **Evento/fato de domínio:** a regra central é “pagamento aprovado gera efeitos financeiros”. Nesta fase, o caso de uso recebe um DTO enriquecido de pagamento aprovado; uma integração automática por eventos pode vir depois.

- **Entidade:** `FinancialEntry` tem identidade própria e representa um fato financeiro registrado. `ReceiverPayout` também tem identidade e marca o início de um pedido de repasse.

- **Value Object / Snapshot:** `FinancialValueCompositionSnapshot` representa os valores recebidos. O Financeiro não recalcula taxa; ele usa exatamente `feeAmountCents` e `receiverAmountCents` que recebeu.

- **Porta e adapter:** `FinancialLedgerRepository` é a porta; `FinancialLedgerRepositoryMemory` é o adapter em memória para testes e aprendizado.

- **Idempotência:** o mesmo `paymentId` não pode gerar lançamentos duplicados.

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
2. O **`accountId`** (UUID) da conta é o mesmo tipo de identificador que o BC **Arrecadação** espera como `creatorAccountId` na criação da campanha — a ligação é por **ID**, sem importar modelos entre contextos.
3. Podes **atualizar o perfil** (nome de exibição).
4. Podes abrir uma **sessão fake**: email + palavra-passe simulada devolvem um **token opaco** em memória com expiração.
5. Podes **verificar uma permissão** com esse token; sessão inválida ou expirada não autoriza; falta de permissão devolve erro explícito.

---

## Mapa conceito de negócio → código

| Conceito | Onde está |
|----------|-----------|
| Utilizador, conta, email, perfil (nome de exibição), sessão, permissão, credencial simulada | [`src/domain/user.ts`](src/domain/user.ts) |
| Regras puras (sessão expirada?, tem permissão?) | [`src/domain/user.ts`](src/domain/user.ts) — `isUserSessionExpired`, `userAccountHasPermission` |
| Porta de persistência de utilizador/conta/credencial | [`src/adapters/user-repository.ts`](src/adapters/user-repository.ts) |
| Porta de sessões | [`src/adapters/user-session-repository.ts`](src/adapters/user-session-repository.ts) |
| Implementações em memória | [`src/adapters/user-repository.memory.ts`](src/adapters/user-repository.memory.ts), [`src/adapters/user-session-repository.memory.ts`](src/adapters/user-session-repository.memory.ts) |
| Caso de uso: registo | [`src/use-cases/register-user-account.ts`](src/use-cases/register-user-account.ts) |
| Caso de uso: atualizar perfil | [`src/use-cases/update-user-profile.ts`](src/use-cases/update-user-profile.ts) |
| Caso de uso: sessão fake | [`src/use-cases/create-user-session.ts`](src/use-cases/create-user-session.ts) |
| Caso de uso: autorizar permissão | [`src/use-cases/authorize-user-permission.ts`](src/use-cases/authorize-user-permission.ts) |
| Erros | [`src/errors/user-*.error.ts`](src/errors) |
| API pública do pacote | [`src/index.ts`](src/index.ts) |
| Testes unitários | [`tests/unit/user-domain.test.ts`](tests/unit/user-domain.test.ts), [`tests/unit/user-repository.memory.test.ts`](tests/unit/user-repository.memory.test.ts), [`tests/unit/user-use-cases.test.ts`](tests/unit/user-use-cases.test.ts) |

---

## DDD

- **Bounded context:** o vocabulário de utilizador, conta, sessão e permissão vive aqui; **não** aparecem campanhas, contribuições, taxas ou pagamentos no domínio do Usuário.
- **Linguagem ubíqua:** nomes em código (`User`, `UserAccount`, `registerUserAccount`) alinham com o produto descrito em [`PROMTP-BASE.md`](PROMTP-BASE.md) e [`ENGINE-DDD.md`](ENGINE-DDD.md).
- **Agregado / invariantes (didático):** nesta fatia, **uma conta pertence a um utilizador** (relação 1:1); o email é **único**; sessão inválida ou expirada **não autoriza**.
- **Value objects / validação na fronteira:** email normalizado, token de sessão com comprimento mínimo, permissões enumeradas — validados com Zod nos inputs dos casos de uso.
- **Repositório (porta + adaptador):** interfaces em `adapters/` e `*.memory.ts` para testes e demos sem Postgres.
- **Serviço de aplicação:** cada ficheiro em `use-cases/` orquestra validação, leituras e persistência; a “autenticação” é **consciente de ser fake** (palavra-passe simulada, token opaco).
- **Integração com Arrecadação:** o BC Arrecadação continua a usar só um UUID (`creatorAccountId`). O significado “conta registada no Usuário” é responsabilidade da **aplicação** (orquestração) ou de testes que chamam primeiro `registerUserAccount` e depois `createFundraisingCampaign` com o mesmo `accountId` — **sem** acoplar o domínio de campanhas ao de utilizadores.
