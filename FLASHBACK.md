# FLASHBACK — Engine / EuNeném Session Context

> **Purpose:** Cold-start anchor for GLaDOS (or any agent) resuming work after a restart, compact, or context wipe. Read top to bottom. Update at session-close.
> **Last updated:** 2026-05-31
> **Active branch:** `staging`
> **Active worktree path:** `~/projects/engine` (main checkout — operator works here directly during dev)

> **2026-05-31 headline:** `aperture-aiipy` (visitor Stripe checkout) **CLOSED end-to-end** + `aperture-6g58e` (inline-success modal, kill the redirect-race) **CLOSED end-to-end**. Full Layer D verified by operator-walked test transactions. Lots banked — read §2 + §5.

---

## 1. What This Project Is

**Engine** = SDK package `frame` (multi-tenant, `idPlataforma` keyed). Lives in `~/projects/engine/src/`.
**EuNeném-server** = first consumer app, baby-gift-list product. Lives in `~/projects/engine/apps/eunenem-server/`.

Stack: Hono SSR + React 19 + esbuild + Tailwind v4 + tRPC + react-query + BetterAuth + PlanetScale-Postgres (`frame-postgres:54320` for local dev).

**Bounded contexts (DDD):** Arrecadação (campanhas + contribuicoes), Usuario, Plataforma, Checkout.

**Key architectural rule:** Engine is **consumer-agnostic**. EuNeném-specific concepts (the word "list", same-origin product paths, listas prontas templates) do NOT belong in `src/`. Consumers enforce their shape at their API edge (`apps/eunenem-server/server/trpc/*`).

---

## 2. The End-to-End Feature We Just Shipped — "lista de presentes"

User flow: signup → modal → `/painel/<slug>/lista` → browse catalog (chip-filtered + infinite scroll) → add gift → persists as real `contribuicao` in postgres.

Chain that made it work (in commit order, all merged to staging):

| Commit | What landed |
|---|---|
| `526ccc0` | ListaPresentesBody wired to contribuicao adapter (mock-first) |
| `8c55d19` | Bulk insert via `criarContribuicoesEmLote` + `saveBulk` (one INSERT, not N) |
| `25d3aba` | findByAdministrador restored + p8i01 saga adapted |
| `8618ebd` | Hotfix: missing `ArrecadacaoLimiteOpcaoExcedidoError` barrel export |
| `29dce2f` | Swap mock adapter for real tRPC (`trpc.contribuicao.*.useQuery/useMutation`) |
| `6ac42ee` | Stop sending emoji as imagemUrl (was `it.emoji`, now `undefined`) |
| `ca4a600` | Real eunenem catalog (355 items) + 5 listas prontas, 304 images downloaded to `public/products/` |
| `1fee1ef` | Catalog modal UX — category chips + infinite scroll + native lazy images |
| `7805fc5` | tRPC schema: `ImagemUrlSchema` accepts same-origin paths via `/^(\/|https?:\/\/)/` regex |
| `9512b4a` | **Engine domain:** 3 use-cases relaxed `z.url()` → `z.string().min(1).max(500)` — engine is shape-agnostic on imagemUrl |

**Verified working:** `curl -X POST /api/trpc/contribuicao.createBulk` with `imagemUrl: "/products/240252.png"` returned `{"ids":["aa96b401-..."]}` ✓

---

### 2.5. 2026-05-31 — aiipy + 6g58e ship + cascade

| Commit | What |
|---|---|
| `cd0a63f` | **Engine domain:** `IdTransacaoExternaSchema` loosened from `z.uuid()` to `z.string().min(1).max(200)` — Stripe `pi_xxx` ids aren't UUIDs. Unblocked aiipy. (aperture-43p4y record bead.) |
| `f6a2dde` | **Inline-success state machine** on `GiftCheckoutModal` (aperture-6g58e). Engine port `CheckoutSessionProvider` gains optional `redirectOnCompletion`. Stripe adapter passes `redirect_on_completion: 'if_required'`. tRPC pagina-router passes it through. Frontend state machine: `idle → checkout → completed_pending → completed_confirmed → completed_slow`. Kills the redirect to `/sucesso` + the post-redirect race. |
| `88bf36d` | **Financeiro domain validator** — `validarComposicaoFinanceiraPagamentoAprovado` was missing `surchargeCents` from the invariant equation. Every card payment 500'd at saga step 3 (`registrarEfeitosFinanceirosPagamentoAprovado`). Schema was updated for aperture-uyw8i but validator was left stale. Classic. (aperture-3kr4g record bead.) |
| `75cc09f` | Test fixtures catch-up for the validator fix (3 fixtures gain `surchargeCents: 0`). |
| `3c5bc43` | `useInvalidarListaPresentes` hook + Marketplace cache invalidation on `completed_confirmed` — gift grid was staying stale until manual refresh after a purchase. Pushed `--no-verify` (operator-OK'd) because of a pre-existing testcontainers flake — see §6. |

**Verified end-to-end (operator-walked 2026-05-31 22:20 BRT):**
Card payment on /pagina/francisco → Stripe iframe → inline ✓ modal with polaroid + recadinho + PRESENTEADO stamp → CTAs enabled in ~1s. `stripe listen` showed `checkout.session.completed → 200` (vs 500 pre-fix). DB: pagamento aprovado, transacao_externa populated, contribuicao indisponivel, contribuinte stamped, saga `lancamentosCount: 2`. Full Layer D table banked on aiipy + 6g58e bead notes.

**Stripe sandbox standup (this session):**
- Created fresh sandbox "Violet Carousel" (account `acct_1TdJJxKIu0136XVg`). Replaces the old `acct_51R28Bb…` keys.
- Stripe CLI installed via `brew install stripe/stripe-cli/stripe` → `stripe login` → `stripe listen --forward-to localhost:3001/api/webhooks/stripe`
- `pk_test_` / `sk_test_` / `whsec_` all live in `apps/eunenem-server/.env` (gitignored)
- `whsec_` is per-CLI-session — re-run `stripe listen` after restart, paste new whsec, bounce `pnpm dev`

---

## 3. Files To Know

### Engine domain (consumer-agnostic — be careful editing)
- `src/use-cases/arrecadacao/criar-contribuicao.ts` — single create; **canonical rationale comment lives here** (lines 31–36)
- `src/use-cases/arrecadacao/criar-contribuicoes-em-lote.ts` — bulk create; references criar-contribuicao for rationale
- `src/use-cases/arrecadacao/atualizar-contribuicao.ts` — patch existing; cross-tenant guard via `idCampanhaEsperada`
- `src/index.ts` — barrel. Watch for missing exports (already burned us once on `ArrecadacaoLimiteOpcaoExcedidoError`)

### EuNeném-server (consumer)
- `apps/eunenem-server/server/trpc/contribuicao-router.ts` — `ImagemUrlSchema` lives here, accepts `^(\/|https?:\/\/)` paths
- `apps/eunenem-server/pages/lib/contribuicao.ts` — 7 hooks, all use real tRPC + `useUtils().contribuicao.list.invalidate()`
- `apps/eunenem-server/pages/components/eunenem/painel/ListaPresentesBody.tsx` — catalog UI, chip selector + infinite scroll
- `apps/eunenem-server/lib/seed-data/catalog.json` — 355 real eunenem products, flat array
- `apps/eunenem-server/lib/seed-data/listas-prontas.json` — 5 real DB listas (cha-de-fralda 33 items, cha-de-rifa 30, etc.)
- `apps/eunenem-server/public/products/<id>.{jpg|png|webp}` — 304 product images, served same-origin

### Scripts
- `scripts/p8i01-backfill-campanhas.ts` — idempotent. Creates Campanha + 'presentes' opcao for existing usuarios.
  Operator's slug=`francisco`, Campanha id=`e6404b49-82b6-4d99-9e80-224fbedda701`.
  Run: `DATABASE_URL='postgresql://frame:frame@localhost:54320/frame' pnpm tsx scripts/p8i01-backfill-campanhas.ts`

### Local dev env (NOT in git)
- `apps/eunenem-server/.env` — has BETTER_AUTH_SECRET, BETTER_AUTH_URL=http://localhost:3001, DATABASE_URL=postgresql://frame:frame@localhost:54320/frame
- Dev server: `pnpm dev` from `apps/eunenem-server/` (tsx watch + esbuild watch concurrent)

---

## 4. Architectural Decisions Made This Session (don't re-litigate)

1. **Engine has no concept of "list".** A list is just a grouping of contribuicoes for batch-select UX. Lives in eunenem only.
2. **Contribuicoes are unit-level in engine.** UI groups by name (Pacote de Fraldas qty=8 → 8 rows).
3. **Templates live as static JSON in eunenem-server.** No CDN. `public/products/` serves images same-origin.
4. **8 catalog categories** (hand-picked, not enum-bound): fraldas, higiene, roupa, soninho, alimentacao, passeio, brinquedo, outros.
5. **`personalizado` is RESERVED** for user-created items. `outros` is the catch-all (operator caught me using personalizado wrong — don't repeat).
6. **Engine is consumer-agnostic on imagemUrl shape.** Length-bounded string only. Consumers enforce URL/path shape at their API edge.
7. **Campanha can exist without recebedor.** No-recebedor blocks `receber o saldo`, not creating the campaign.
8. **Bulk insert is mandatory.** "Pacote qty=8" or 10-item lista pronta = ONE INSERT, not 8/30 round-trips. Use `criarContribuicoesEmLote`.

---

## 5. Outstanding Work (BEADS — project:engine label)

**Shipped 2026-05-30:** uc2ix + 3pqt7 + swmpm + 3chj2 + much more (PRs #79–#90). Listed in §2 of earlier flashback rev.

**Shipped 2026-05-31:** aiipy + 6g58e (both CLOSED) + 43p4y + 3kr4g (record beads).

### Currently open (P1)

| Bead | Assignee | What |
|---|---|---|
| `aperture-id3ay` | **rex** | Wire `LivroFinanceiroRepository` to postgres (lancamentos written to RAM, lost on restart — same wire-the-adapter gap aiipy had for Pagamentos). Blocks the lancamentos leaf of the admin-trace epic. |
| `aperture-m4xaj` | **rex** | Testcontainers integration tests time out under v8 coverage instrumentation. Pre-push gate flake. 4 proposed fixes on bead; globalSetup with shared container probably cleanest. |
| `aperture-rsidz` | **wheatley** (epic) | Admin DDD-trace drill-down page: user → campanhas → contribuicoes → pagamentos → lancamentos. Operator-direct request 2026-05-31. Hard-blocked-by id3ay for the leaf step (W5); W0–W4 can scope + start in parallel. 5 open questions for operator on the bead. |
| `aperture-pgqih` | glados | [EPIC] BetterAuth integration on engine (Pattern A) + eunenem-server consumer wiring. Not touched this session. |

### Currently open (P2)

| Bead | Assignee | What |
|---|---|---|
| `aperture-haakf` | rex (Cipher) | auth-router hardening bundle (M1+M2+M4) |
| `aperture-wshvw` | rex (Cipher) | Freshness gate (M3) on alterarSenha |
| `aperture-85n6u` | peppy (Cipher) | Prod security headers (L1) |

### Currently open (P3 + record)

| Bead | Assignee | What |
|---|---|---|
| `aperture-d52he` | unassigned | `/sucesso` direct-URL race condition (inline modal mitigates most paths; rare edge cases still hit it) |
| `aperture-1y1os` | rex | Wrong-creds → UNAUTHORIZED domain cleanup |
| `aperture-u2y3x` | vance | Collapse op-aware error mapper (blocked-by 1y1os) |
| `aperture-kwvyk` | rex | Content-length equality regression test on blocked-auth-handler |
| `aperture-jxul` | vance | Bank zod URL validator recursive gotcha into a skill |
| `aperture-grxsh` | unassigned | Hero.tsx avatar paths bug |
| `aperture-6fwq3` | unassigned | P4 — split tailwind.css EOF appends into modules |
| `aperture-6ay8k` | unassigned | P4 — orphan CSS sweep |

**Rex and Wheatley were both pinged via send_message at 2026-05-31 ~22:30 BRT with full context for their P1s.**

---

## 6. Live Failure Modes To Watch For

### Death pattern (recurring)
3+ waves of agent deaths this session. Some memory-pressure (resolved by killing Chrome+WhatsApp). Some happened with healthy memory (15% free) — clean exits, no kernel kill, no crash logs. Operator may restart the PC to see if it kills the pattern.

**When you resume after a restart:** check `bd list --status=in_progress -l project:engine` first to see what's claimed but stalled. Re-dispatch with cold-start brief.

### z.string().url() vs paths
**Already bit us twice.** Zod's `z.url()` rejects relative paths (`/products/240252.png`). If you see "Invalid URL" in a BAD_REQUEST, grep for `.url(` in the call chain — likely a stale validator we missed.

### z.uuid() vs provider-native ids (banked 2026-05-31)
**Same shape as the z.url() footgun.** External payment provider ids are NOT UUIDs (Stripe = `pi_xxx`, `cs_test_xxx`; Pagarme = numeric tid). `IdTransacaoExternaSchema = z.uuid()` rejected Stripe pi_xxx ids and 500'd every webhook before cd0a63f fixed it. If a new adapter is being wired and you see `Invalid UUID` at path:[] in a webhook log, grep for `z.uuid()` on whatever the adapter is trying to thread through.

### Stale validator next to updated schema (banked 2026-05-31)
`SnapshotComposicaoValoresFinanceiroSchema` was correctly updated for aperture-uyw8i (added `surchargeCents` field + documented invariant in JSDoc), but the pure-function validator `validarComposicaoFinanceiraPagamentoAprovado` colocated with the entity was left stale — checked `receiverAmountCents + feeAmountCents !== totalPaidCents` without surchargeCents. Every card payment 500'd. When updating a domain schema's invariant, grep for every site that asserts it.

### Testcontainers parallelism flake on pre-push (banked 2026-05-31)
`pnpm check` runs `pnpm test:coverage` which spins up postgres containers per integration test file. Under v8 coverage instrumentation + default vitest parallelism, 15+ concurrent container starts overwhelm OrbStack/Docker → `beforeAll` times out at 60s → every `afterAll` fails on `testDb.teardown()` undefined. Symptom is misleading; root cause is in the test log. Filed as aperture-m4xaj for Rex with 4 proposed fixes. **Workaround:** `git push --no-verify` is operator-approved for engine when the failing test files are integration-only AND pass on isolated runs.

### Stacked-PR aftermath
The p8i01/d6atj stacked-PR conflicts taught us: when rebasing a stacked branch after the parent squash-merges, use `git rebase --onto origin/main <last-parent-sha>` not plain `git rebase origin/main`. See `aperture:worktree-discipline` §8.1.

### Missing barrel exports
d6atj added a new error class and forgot the export → dev server crashed at boot post-merge. Fixed in `8618ebd`. Smoke test bead is `aperture-3chj2`.

---

## 7. Quick Resume Checklist (read on restart)

```bash
# 1. Where am I
cd ~/projects/engine && git status && git log -5 --oneline

# 2. Is the dev server running?
lsof -i :3001 || echo "Server down — start with: cd apps/eunenem-server && pnpm dev"

# 3. Is postgres up?
docker ps | grep frame-postgres || echo "Postgres down"

# 4. What's the current beads state?
bd list --status=in_progress
bd ready

# 5. Read this file. Re-read §2 (the chain) and §6 (failure modes).

# 6. Sanity-check the lista flow still works:
curl -s -b /tmp/test-cookies.txt -X POST http://localhost:3001/api/trpc/contribuicao.list \
  -H 'content-type: application/json' -d '{}'
# Should return a `result.data` array, not an error.
```

---

## 8. Operator Context You Should Know

- Speaks PT-BR and English, often switches mid-sentence. Code/UI is PT-BR.
- Operator's user: `franciscomateusvg@gmail.com` / slug=`francisco` / Campanha id=`e6404b49-82b6-4d99-9e80-224fbedda701`
- Operator catches you fast on naming and category mistakes — engage seriously, don't paper over.
- Hotfixes on staging directly are OK during emergencies (operator has explicitly relaxed worktree-discipline for these).
- Operator gives short approvals ("yeah", "yep") — that's a real green light, not noise.

---

## 9. Pointers Outside This Repo

- Aperture (orchestrator): `~/projects/aperture/` — where GLaDOS, specialists, BEADS, MCP server live
- Legacy eunenem (PlanetScale MySQL, data source for migration): SSH host `mini`
- Image dump from migration: `~/.claude/aperture-eunenem-dump/` (catalog-final.json, listas-prontas-final.json, classifier scripts)
- BEADS: `bd prime` for command reference; `aperture:beads` skill for filing discipline

---

**End of flashback.** Update §2 (the chain) and §5 (outstanding work) on session close. Keep §1, §3, §4, §6 stable unless architecture shifts.
