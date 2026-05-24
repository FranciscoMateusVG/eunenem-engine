# Plan 0001 — Split Domain Layer into entities/ + value-objects/

**Status:** approved, in progress
**Decided:** 2026-05-24
**Scope:** All 5 bounded contexts (arrecadacao, taxas, pagamentos, financeiro, usuario)

## Goal

Make the domain folder structure visibly answer "what's an aggregate root vs entity vs value object?" by separating concerns at the filesystem level. The layout itself becomes a DDD teaching artifact: open a BC, see `entities/` and `value-objects/`, immediately know which is which. Each entity file declares whether it's an **aggregate root** or a plain **entity inside an aggregate** in its JSDoc header.

## Approach — Pragmatic Option B

Picked from three candidates:
- **A** Flat at BC root, just split files (no categorical signal).
- **B** `entities/` + `value-objects/` subfolders (DDD-textbook). **← chosen**
- **C** Aggregate-rooted subfolders (DDD-purist, most files).

Rules:
- Each BC gets `entities/` and `value-objects/` subfolders **when applicable**.
- Each entity file starts with a JSDoc header tagged `@aggregateRoot` or `@entity` (the latter for entities inside an aggregate that aren't the root).
- Identifier VOs share `ids.ts` per BC.
- Named non-trivial VOs get their own files in `value-objects/`.
- Tiny enum/literal schemas tightly bound to a parent entity/VO stay **inline** (don't fragment trivially).
- BCs with no aggregate roots (Taxas today) **skip** `entities/` entirely.

## Per-BC mapping

### Arrecadação (currently 5 files → 8 files)
**entities/**
- `campanha.ts` — `@aggregateRoot` Campanha + invariant predicates
- `contribuicao.ts` — `@aggregateRoot` Contribuição + `StatusContribuicao` inline + `NomeContribuicao` inline
- `recebedor.ts` — `@aggregateRoot` Recebedor + versioning factories

**value-objects/**
- `ids.ts` — IdCampanha, IdConta, IdContribuicao, IdOpcaoContribuicao, IdRecebedor
- `opcao-contribuicao.ts` — OpcaoContribuicao + TipoOpcaoContribuicao
- `ids-administradores.ts` — IdsAdministradoresSchema
- `dados-contribuinte.ts` — DadosContribuinte + NomeContribuinte inline
- `dados-recebedor.ts` — DadosRecebedor + TipoChavePix inline

### Taxas (currently 1 file → 3 files; no `entities/`)
**value-objects/**
- `ids.ts` — IdContribuicaoReferencia
- `regra-taxa.ts` — RegraTaxa + PercentualTaxaBps + ResponsavelTaxa + REGRA_TAXA_PADRAO + calcularValorTaxaPercentual + calcularTaxa + CalculoTaxa
- `composicao-valores.ts` — ComposicaoValores + DadosCalculoTaxa + comporComposicaoValores + calcularComposicaoValores

### Pagamentos (currently 1 file → 5 files)
**entities/**
- `pagamento.ts` — `@aggregateRoot` Pagamento + IntencaoPagamento (`@entity` inside agg) + TransacaoExterna (`@entity` inside agg) + status enums + factories

**value-objects/**
- `ids.ts` — IdPagamento, IdIntencaoPagamento, IdTransacaoExterna, IdContribuicaoPagamento
- `metodo-pagamento.ts` — MetodoPagamento
- `snapshot-composicao-valores.ts` — SnapshotComposicaoValores
- `evento-pagamento.ts` — EventoPagamento + TipoEventoPagamento + NomeProvedorPagamento

### Financeiro (currently 1 file → 7 files)
**entities/**
- `lancamento-financeiro.ts` — `@entity` (within implicit Livro Financeiro aggregate) + factories (`criarLancamentosParaPagamentoAprovado`, `validar...`)
- `repasse-recebedor.ts` — `@entity` + factory (`criarRepasseRecebedorSolicitado`)

**value-objects/**
- `ids.ts` — IdLancamentoFinanceiro, IdPagamentoReferencia, IdContribuicaoReferencia, IdRepasse
- `snapshot-composicao-valores-financeiro.ts`
- `saldo-recebedor.ts` — SaldoRecebedor + calcularSaldoRecebedor + SaldoCentavos inline
- `receita-plataforma.ts` — ReceitaPlataforma + calcularReceitaPlataforma
- `dados-recebedor-ativo.ts` — alias of DadosRecebedor

### Usuário (currently 1 file → 8 files)
**entities/**
- `usuario.ts` — `@aggregateRoot` Usuario + Conta (`@entity` inside agg) + CredencialSimulada (`@entity` inside agg) + `contaTemPermissao`
- `sessao.ts` — `@aggregateRoot` Sessao + `sessaoExpirada`

**value-objects/**
- `ids.ts` — IdUsuario, IdContaUsuario
- `email-usuario.ts`
- `nome-exibicao-usuario.ts`
- `senha-simulada.ts`
- `token-sessao.ts`
- `permissao.ts` — Permissao + PERMISSOES_PADRAO

## Annotation pattern

Every entity file starts with a single JSDoc header:

```ts
/**
 * @aggregateRoot Campanha (BC Arrecadação)
 * Owns: idsAdministradores, opcoes, projeção do recebedor ativo.
 * Persisted via: CampanhaRepository.
 */
```

or

```ts
/**
 * @entity Conta (within Usuario aggregate)
 * Persisted with: Usuario root via UsuarioRepository.saveRegistro.
 */
```

## Execution steps

1. Update `folder-structure.mjs` to allow `entities/` and `value-objects/` subfolders under each BC.
2. Move + split files BC by BC: arrecadação → taxas → pagamentos → financeiro → usuário.
3. Update imports across `src/`, `tests/`, and use-case files.
4. Update `src/index.ts` re-exports to point at the new paths.
5. Run `pnpm check` — must be green.

## Not in scope (deferred)

- Renaming any types
- Adding behavior to anemic VOs (deferred to Phase 0.5 — MoneyCents / ComposicaoValores enrichment)
- Cross-BC domain coupling cleanup (Financeiro still imports `IdCampanhaSchema` from Arrecadação)
- Splitting use-case input schemas further
- Splitting cat (placeholder) domain — leave as-is
