# FLASHBACK — Engine / EuNeném Session Context

> **Purpose:** Cold-start anchor for GLaDOS (or any agent) resuming work after a restart, compact, or context wipe. Read top to bottom. Update at session-close.
> **Last updated:** 2026-05-30
> **Active branch:** `staging`
> **Active worktree path:** `~/projects/engine` (main checkout — operator works here directly during dev)

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

**Operator's last test before context ran out:** screenshot of "Sapatinho Bebê Kit 2 Pares" showing "deu ruim na conexão" toast — that's what triggered the engine-domain fix (`9512b4a`). After the fix + tsx reload + curl verify, awaiting browser confirmation from operator.

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

| Bead | Assignee | Pri | What |
|---|---|---|---|
| `aperture-3chj2` | Rex | P3 | Boot-time barrel-export smoke test (post-d6atj footgun prevention) |
| `aperture-1y1os` | Rex | P3 | Wrong-creds → UNAUTHORIZED domain cleanup |
| `aperture-u2y3x` | Vance | P3 | Collapse op-aware error mapper (blocked-by 1y1os) |
| `aperture-uc2ix` | Rex | P1 (Cipher) | Rate-limiting |
| `aperture-3pqt7` | Rex | P1 (Cipher) | Structured failed-login + IP capture |
| `aperture-swmpm` | Rex | P1 (Cipher) | Timing leak |
| `aperture-haakf` | Rex | P2 (Cipher) | Hardening bundle |
| `aperture-wshvw` | Rex | P2 (Cipher) | Freshness gate |
| `aperture-85n6u` | Rex | P2 (Cipher) | Prod headers |
| `aperture-jxul` | Vance | P3 | Bank zod URL validator recursive gotcha into a skill |

Cipher's P1s on Rex are NOT blocking the lista feature — they're parallel security hardening.

---

## 6. Live Failure Modes To Watch For

### Death pattern (recurring)
3+ waves of agent deaths this session. Some memory-pressure (resolved by killing Chrome+WhatsApp). Some happened with healthy memory (15% free) — clean exits, no kernel kill, no crash logs. Operator may restart the PC to see if it kills the pattern.

**When you resume after a restart:** check `bd list --status=in_progress -l project:engine` first to see what's claimed but stalled. Re-dispatch with cold-start brief.

### z.string().url() vs paths
**Already bit us twice.** Zod's `z.url()` rejects relative paths (`/products/240252.png`). If you see "Invalid URL" in a BAD_REQUEST, grep for `.url(` in the call chain — likely a stale validator we missed.

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
