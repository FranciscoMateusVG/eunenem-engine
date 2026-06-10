# 0018 — First-time user tutorial coachmark (painel walkthrough)

**Status.** 📝 drafted 2026-06-09
**Depends on.** Plan 0010 (real authentication — shipped via aperture-pgqih: BetterAuth Pattern A), painel surface scaffolding (aperture-i01o, aperture-fx2iz)
**Unblocks.** First-time-user activation flow; AJUDA chip surface (open question).

## Goal

After this lands, a first-time user landing on `/painel/<slug>` gets a guided 9-step spotlight walkthrough of every interactive card on the painel. Each step dims the page, focuses a single card with a ring, and surfaces a popover (`passo N/9`, título, descrição, dot indicators, back arrow, PRÓXIMO CTA). The walkthrough completes server-side via a single `usuario.completarTutorial` mutation that stamps `tutorialCompletadoEm` on the usuario row, gating any re-show. Returning users see a floating `TUTORIAL` CTA bottom-right that re-triggers the overlay on demand.

**Trigger.** Operator dumped 18 reference screenshots (timestamped 2026-06-04, 12:55–12:57) at `/tmp/tutorial-screens/Prints Tutorial/` — 9 desktop + 9 mobile-narrow viewport pairs walking the same 9-step tutorial. This plan codifies the data contract + component contract so Rex and Vance can ship in parallel.

**Discrepancy with dispatch.** GLaDOS's dispatch said `passo N/17`. The actual screenshots show `passo N/9` (the dot indicators count 9; CTA is `CONCLUIR` on step 9). The reference is 9 steps in two viewport variants (= 18 PNGs), not 17 distinct steps. The plan scopes to 9 steps; the discrepancy is logged in §Open questions for operator confirmation.

## Locked decisions

These are inferred from the screenshots + operator dispatch + existing codebase shape. Open questions are listed separately at §Open questions.

1. **9 steps, not 17.** The tutorial walks through exactly 9 painel menu rows. See §Step config below for the verbatim transcription. Step count is fixed; adding/removing/reordering steps requires a follow-up bead, not a plan revision.

2. **Tutorial-completed state lives at the Usuario aggregate root.** Column `tutorial_completado_em TIMESTAMPTZ NULL` on `usuarios`. The timestamp shape (not boolean) is informational — operator audit can see exactly when each user finished. Null = never completed; non-null = completed at that timestamp.

3. **Single-write, idempotent completion.** `usuario.completarTutorial` mutation sets `tutorialCompletadoEm = now()` if currently null; no-op if already non-null. No "dismissed at step N" tracking, no per-step progress persistence. The tutorial is a one-shot — if a user closes the browser mid-walkthrough, they restart from step 1 on next page-load. Re-trigger via the floating TUTORIAL CTA always starts from step 1.

4. **Auth gate: session.idUsuario must match the target.** The mutation derives the target idUsuario from `ctx.session.idUsuario` — it's not an input parameter. Callers can't complete someone else's tutorial. The query (`usuario.tutorialStatus`) is also session-scoped (returns the current user's status).

5. **Re-trigger via floating CTA.** Bottom-right `TUTORIAL` button is visible to all users (completed or not). Clicking it opens the overlay starting at step 1 regardless of `tutorialCompletadoEm` state. The button is NOT visible during the active overlay (the page is dimmed, the button is part of the dimmed surface). Completed-user re-trigger does NOT toggle the timestamp back to null — once complete, always complete; re-triggers don't write to the DB.

6. **Dismissal path: ENCERRAR TUTORIAL.** Top-right button (visible during the active overlay only). Clicking it fires the same `usuario.completarTutorial` mutation as the final CONCLUIR step (treating "skip" as "complete" for state purposes — operator's call per common coachmark pattern; the user has been shown the entry-point, that's what the flag tracks). Closes the overlay immediately.

7. **Spotlight implementation: hand-rolled.** No `react-joyride`, no `shepherd.js`. The popover has very specific brand styling (rounded card, custom dot indicators, pink CONFIRMAR CTA matching the painel's existing button palette) and only 9 fixed steps — the library config overhead (~50–70kb gzipped) doesn't pay for itself. Tailwind + Framer Motion (already in the repo) cover the spotlight ring + popover animations. Estimated ~5kb of new component code.

8. **Step targeting: `data-tutorial-target` attribute on each `PainelMenuRow`.** Existing `painelDemo.ts` already gives each menu item a stable `id` (e.g. `presentes`, `lista`, `convite`, `preview`, `lista-convidados`, `mensagens`, `perfil`, `bancarios`, `suporte`). Vance threads the id through `PainelMenuRow` into a `data-tutorial-target={item.id}` attribute on the anchor; the overlay component reads positions via `document.querySelector` + `getBoundingClientRect`. No DOM-traversal magic; no portal complexity.

9. **Mobile shape: same selectors, same popover, repositioned.** The two viewport pairs in the screenshots show identical content. The overlay component reads viewport width and picks popover position (`bottom` of card for narrow viewport, `right` or `bottom` for wide). No separate mobile component, no separate mobile config — the popover positioning is data-derived from the focused card's bounding rect.

10. **No client-side state persistence.** The overlay's current step lives in React state only. Page reload restarts from step 1 (if the user hasn't completed). This matches the screenshot evidence — no "resume where you left off" UI surface is present. Operator can revisit if desired in a follow-up; v1 is dead simple.

11. **Out of the tutorial walkthrough:** hero block (página da Helena + countdown + RECEBIDO ATÉ AGORA + RESGATAR VALORES), LINK DO EVENTO row (COPIAR + COMPARTILHAR), NOVO/rifa card (em-breve disabled). None of these get a tutorial step per the screenshots. Operator's call — if they want one added, follow-up bead.

12. **TUTORIAL + AJUDA top-nav chips: OUT OF SCOPE for v1.** The screenshots show top-nav chips `MINHA PÁGINA / TUTORIAL / AJUDA` that don't exist in the current `PainelTopbar` (which has `MINHA ÁREA / EXTRATO / CONVIDADOS / CONVITE`). Plan 0018 ships the spotlight overlay + the floating re-trigger CTA + the ENCERRAR TUTORIAL button (visible only during active overlay). The chip-bar redesign is a separate concern. See §Open questions #1 for the operator clarification.

## Backend contract (Rex)

### Schema

**Migration: `migrations/20260609_024_add_tutorial_completado_em_to_usuarios.ts`**

```sql
ALTER TABLE usuarios ADD COLUMN tutorial_completado_em TIMESTAMPTZ NULL;
```

Single column, single statement. No index needed — the column is read only at session-creation time (and by `usuario.tutorialStatus` query, which already loads the usuario row by id). Plan 0016 reserves migration 020 + Plan 0015 derived-liberação reserves 021–023 (already shipped on staging); 024 is the next free slot.

### Domain entity

**`src/domain/usuario/entities/usuario.ts`** — `Usuario` interface gains:

```ts
export interface Usuario {
  // ... existing fields
  readonly slug: SlugUsuario;
  /** Plan 0018 — when this admin finished the painel tutorial. `null` = never
   *  completed. Idempotent at the use-case layer: re-calling `completarTutorial`
   *  on a non-null value is a no-op. */
  readonly tutorialCompletadoEm: Date | null;
  readonly criadoEm: Date;
}
```

No ItemDoPagamento-style entity surgery. Just a nullable timestamp on the aggregate root.

### Use-cases

**`src/use-cases/usuario/marcar-tutorial-completado.ts`** (NEW):

```ts
export interface MarcarTutorialCompletadoDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface MarcarTutorialCompletadoInput {
  readonly idUsuario: IdUsuario;
}

export async function marcarTutorialCompletado(
  deps: MarcarTutorialCompletadoDeps,
  input: MarcarTutorialCompletadoInput,
): Promise<Usuario> {
  // 1. Load usuario
  // 2. If tutorialCompletadoEm is already non-null → return as-is (idempotent)
  // 3. Else patch tutorialCompletadoEm = clock(); save; return
}
```

The use-case takes `idUsuario` as input rather than threading the auth session — keeping it auth-agnostic per the engine's existing pattern (the tRPC procedure resolves session → idUsuario before calling).

**`src/use-cases/usuario/obter-status-tutorial.ts`** (NEW):

```ts
export interface ObterStatusTutorialDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly observability: Observability;
}

export interface ObterStatusTutorialInput {
  readonly idUsuario: IdUsuario;
}

export interface StatusTutorial {
  readonly tutorialCompletadoEm: Date | null;
  readonly completado: boolean; // derived
}

export async function obterStatusTutorial(
  deps: ObterStatusTutorialDeps,
  input: ObterStatusTutorialInput,
): Promise<StatusTutorial>;
```

Both use-cases are pure read/write with no cross-BC concerns — they live entirely within the Usuario aggregate.

### Repository port + adapters

**`src/adapters/usuario/repository.ts`** — `UsuarioRepository` gains:

```ts
export interface UsuarioRepository {
  // ... existing methods
  /** Plan 0018. Patches tutorialCompletadoEm on an existing usuario. */
  marcarTutorialCompletado(input: {
    readonly idUsuario: IdUsuario;
    readonly tutorialCompletadoEm: Date;
  }): Promise<Usuario>;
}
```

Both `UsuarioRepositoryMemory` and `UsuarioRepositoryPostgres` implement. Conformance suite (already in place per aperture-xyhjr) gains parity tests.

### tRPC procedures

**`apps/eunenem-server/server/trpc/usuario-router.ts`** (extends existing usuario router):

```ts
export const usuarioRouter = router({
  // ... existing procedures (signUp / signIn / signOut / me from aperture-ht7sq)

  /** Plan 0018. Returns the current session's tutorial status. */
  tutorialStatus: authProcedure
    .output(TutorialStatusResponseSchema)
    .query(async ({ ctx }) => {
      const status = await obterStatusTutorial(ctx.deps, {
        idUsuario: ctx.session.idUsuario,
      });
      return {
        tutorialCompletadoEm: status.tutorialCompletadoEm?.toISOString() ?? null,
        completado: status.completado,
      };
    }),

  /** Plan 0018. Marks the current session's tutorial as completed.
   *  Idempotent — re-calling on a completed user is a no-op (returns the same
   *  status). Auth-scoped — callers can't complete someone else's tutorial. */
  completarTutorial: authProcedure
    .output(TutorialStatusResponseSchema)
    .mutation(async ({ ctx }) => {
      const usuario = await marcarTutorialCompletado(ctx.deps, {
        idUsuario: ctx.session.idUsuario,
      });
      return {
        tutorialCompletadoEm: usuario.tutorialCompletadoEm?.toISOString() ?? null,
        completado: usuario.tutorialCompletadoEm !== null,
      };
    }),
});
```

`authProcedure` (existing per aperture-ht7sq) enforces the session is present + valid. No new auth middleware.

### Idempotency

The mutation is idempotent at the use-case layer (the `if (usuario.tutorialCompletadoEm) return usuario` early-return is the gate). Re-calls from a misbehaving client during the same overlay session are silently absorbed. The procedure always returns the canonical `TutorialStatusResponseSchema` shape so the client can update its UI state from the response regardless of whether the write actually fired.

## Frontend contract (Vance)

### Component shape

**`apps/eunenem-server/pages/components/eunenem/painel/PainelTutorialOverlay.tsx`** (NEW):

```tsx
interface PainelTutorialOverlayProps {
  /** Renders nothing when false — controlled by the parent. */
  open: boolean;
  /** Called when the user clicks CONCLUIR on step 9 OR clicks ENCERRAR TUTORIAL.
   *  Parent fires the completarTutorial mutation. */
  onComplete: () => void;
  /** Called when the user clicks ENCERRAR TUTORIAL or hits Escape.
   *  Parent closes the overlay locally; the mutation still fires via onComplete. */
  onDismiss: () => void;
}

export function PainelTutorialOverlay({ open, onComplete, onDismiss }: Props) {
  // 1. Step state (1..9). Initial: 1. Back/forward via arrow / PRÓXIMO.
  // 2. Read target via document.querySelector(`[data-tutorial-target="${id}"]`)
  // 3. Compute spotlight ring position from target's getBoundingClientRect()
  // 4. Compute popover position from target rect + viewport width (bottom for narrow, right/bottom for wide)
  // 5. Render: dimmed background overlay + ring around target + popover card
  // 6. Lock body scroll while open
  // 7. Window resize listener → recompute target rect / popover position
}
```

The component owns all rendering + position math. Parent owns: when to show it (gated on tutorialStatus.completado === false on first paint OR re-trigger CTA click), and the mutation fire (on onComplete). State-of-truth split is clean.

**`apps/eunenem-server/pages/components/eunenem/painel/PainelTutorialTrigger.tsx`** (NEW):

The floating bottom-right TUTORIAL button. Visible whenever the overlay is NOT open. Clicking it opens the overlay (parent sets state). Single button, fixed position, ~30 lines.

### Step config

A static `STEPS` array in the overlay component (or in a sibling file `painelTutorialSteps.ts`). Each step is:

```ts
interface TutorialStep {
  readonly targetId: string;         // matches PainelMenuRow item.id + data-tutorial-target
  readonly titulo: string;           // displayed in popover
  readonly descricao: string;        // displayed in popover
  readonly defaultPosition: 'bottom' | 'right' | 'top' | 'left'; // popover preferred side
}

const STEPS: readonly TutorialStep[] = [
  {
    targetId: 'presentes',
    titulo: 'presentes recebidos',
    descricao: 'Acompanhe cada presente em dinheiro que chega e abra o extrato completo, com datas e quem enviou.',
    defaultPosition: 'bottom',
  },
  {
    targetId: 'lista',
    titulo: 'minha lista de presentes',
    descricao: 'Monte e edite a lista de itens que você sonha para o bebê — a gente cuida da conversão em dinheiro.',
    defaultPosition: 'top',
  },
  {
    targetId: 'convite',
    titulo: 'ver meu convite',
    descricao: 'Veja a prévia do convite exatamente como seus convidados vão recebê-lo.',
    defaultPosition: 'top',
  },
  {
    targetId: 'preview',
    titulo: 'ver como convidado',
    descricao: 'Navegue na sua página como se fosse um convidado, para testar toda a experiência de presentear.',
    defaultPosition: 'top',
  },
  {
    targetId: 'lista-convidados',
    titulo: 'Lista de convidados',
    descricao: 'Veja quem foi convidado e acompanhe quem já confirmou presença no chá.',
    defaultPosition: 'bottom',
  },
  {
    targetId: 'mensagens',
    titulo: 'mensagens recebidas',
    descricao: 'Leia os recados carinhosos que seus convidados deixaram para a Helena.',
    defaultPosition: 'bottom',
  },
  {
    targetId: 'perfil',
    titulo: 'editar meu perfil',
    descricao: 'Atualize seu nome, a foto e a história do seu bebê que aparece na página.',
    defaultPosition: 'top',
  },
  {
    targetId: 'bancarios',
    titulo: 'dados bancários',
    descricao: 'Cadastre e confira a conta para onde enviamos o valor dos presentes recebidos.',
    defaultPosition: 'top',
  },
  {
    targetId: 'suporte',
    titulo: 'fale com a gente',
    descricao: 'Precisa de ajuda? Fale com o nosso time por WhatsApp ou e-mail, de segunda a sexta.',
    defaultPosition: 'top',
  },
];
```

Verbatim from the screenshots — the wording matches what the operator approved by including those screenshots. Vance does not paraphrase. The mock data in `painelDemo.ts` (e.g. "Helena", "seu bebê") is the demo persona; the live data substitutes the actual user's `nomeExibicao` via the painel surface, and the tutorial descrições stay generic enough that they work for any persona.

### Component → PainelMenuRow integration

`PainelMenuRow` gains a single line: `data-tutorial-target={item.id}` on the outer anchor. No other change. The overlay component reads positions via the DOM; no React context, no portal.

### Dismissal + re-trigger paths

| Action | UI effect | Mutation fired? |
|---|---|---|
| User clicks `PRÓXIMO` on step 1..8 | step++ | no |
| User clicks back arrow on step 2..9 | step-- | no |
| User clicks `CONCLUIR` on step 9 | overlay closes | `completarTutorial` |
| User clicks `ENCERRAR TUTORIAL` (top-right) | overlay closes | `completarTutorial` |
| User presses Escape | overlay closes | `completarTutorial` |
| User reloads page mid-tutorial without completing | overlay re-opens at step 1 on next paint (if not completed) | no |
| Completed user clicks floating `TUTORIAL` CTA | overlay opens at step 1 | no (no re-write on re-trigger) |

The mutation fires exactly once per first-completion. Re-triggers don't write. This matches locked decision #5.

### Gating logic at the painel root

**`apps/eunenem-server/pages/components/eunenem/painel/PainelPage.tsx`** (or wherever the painel root component lives):

```tsx
function PainelPage({ slug }: { slug: string }) {
  const tutorialStatus = trpc.usuario.tutorialStatus.useQuery();
  const completarTutorial = trpc.usuario.completarTutorial.useMutation();
  const [overlayOpen, setOverlayOpen] = useState(false);

  // First-paint auto-open for first-time users
  useEffect(() => {
    if (tutorialStatus.data && !tutorialStatus.data.completado) {
      setOverlayOpen(true);
    }
  }, [tutorialStatus.data]);

  return (
    <>
      {/* existing painel content */}
      <PainelTutorialTrigger onOpen={() => setOverlayOpen(true)} visible={!overlayOpen} />
      <PainelTutorialOverlay
        open={overlayOpen}
        onComplete={() => {
          completarTutorial.mutate();
          setOverlayOpen(false);
        }}
        onDismiss={() => {
          completarTutorial.mutate();
          setOverlayOpen(false);
        }}
      />
    </>
  );
}
```

Note: `onDismiss` ALSO fires the mutation per locked decision #6 (skip = complete). Vance can split if operator wants distinct semantics, but v1 treats them the same.

## Rex / Vance coordination

### Shared zod schema (contract pin)

**`src/observability/dtos/tutorial-status.dto.ts`** (or a similar shared-DTO location — verify with Rex; engine's convention may differ):

```ts
import { z } from 'zod/v4';

/**
 * Plan 0018 — shape of `usuario.tutorialStatus` query response AND
 * `usuario.completarTutorial` mutation response. Single source of truth
 * shared by the tRPC procedure (Rex) and the React client (Vance).
 *
 * Why a separate schema: pinning the contract means Vance can scaffold
 * the overlay's data-binding against this schema BEFORE Rex ships the
 * tRPC procedure. The mutation + query both return the same shape, so
 * the client can unify state updates from either source.
 */
export const TutorialStatusResponseSchema = z.object({
  tutorialCompletadoEm: z.string().datetime().nullable(),
  completado: z.boolean(),
});

export type TutorialStatusResponse = z.infer<typeof TutorialStatusResponseSchema>;
```

Both Rex's tRPC procedures and Vance's React Query hooks import this directly. Drift becomes a compile error.

### Parallel-track prep

**While Rex ships the column + use-cases + tRPC (Phase A):** Vance can build the `PainelTutorialOverlay` + `PainelTutorialTrigger` components against the shared schema, using a hand-rolled mock that returns `{ tutorialCompletadoEm: null, completado: false }`. The overlay renders end-to-end on a local dev server before the backend exists. Manual `setOverlayOpen(true)` calls drive testing.

**Vance's mock hook (temporary, deleted at integration time):**

```tsx
// src/lib/painelTutorialMock.ts — DELETE when Rex's tRPC procedure lands
export function useTutorialStatusMock(): TutorialStatusResponse {
  return { tutorialCompletadoEm: null, completado: false };
}
```

**At integration time:** Vance swaps `useTutorialStatusMock` for `trpc.usuario.tutorialStatus.useQuery()`. The shape is identical (the schema enforces it); only the data source changes. No component rewrites.

### Visual fidelity gate

Vance reviews her implementation against the 18 reference screenshots before opening the PR. Specifically:
- Popover card: rounded corners, paper background, brand pink CTA, dot indicators with the current step filled.
- Spotlight ring: thin border + slight glow on the focused card, matching the screenshot's visual treatment.
- Dimmed background: semi-opaque dark overlay (estimate ~50% opacity, exact value from the screenshots).
- Mobile-narrow popover: positioned below the focused card; doesn't overflow viewport bottom.
- TUTORIAL floating CTA: bottom-right, pink pill matching the screenshots, with the icon (looks like an open-book / lightbulb in the screenshots — confirm).

## Phases

This plan is smaller-shape than Plans 0015/0016 — two parallel tracks (backend + frontend) that converge at integration. Two phases per track, then one integration phase.

### Phase A — Backend (Rex)

**Phase A.0** — Migration + Usuario entity field
- migrations/20260609_024_add_tutorial_completado_em_to_usuarios.ts
- src/domain/usuario/entities/usuario.ts (Usuario interface)
- src/adapters/usuario/repository.ts (port method)
- src/adapters/usuario/repository.memory.ts + repository.postgres.ts (implementations)
- src/adapters/db-types.generated.ts (regenerated via pnpm db:codegen)
- Conformance suite tests for the new repo method

**Phase A.1** — Use-cases + tRPC
- src/use-cases/usuario/marcar-tutorial-completado.ts
- src/use-cases/usuario/obter-status-tutorial.ts
- Unit tests for both use-cases (happy + idempotency + missing-user error paths)
- src/observability/dtos/tutorial-status.dto.ts (shared schema)
- apps/eunenem-server/server/trpc/usuario-router.ts (extend with tutorialStatus + completarTutorial)
- Integration test exercising both procedures via the existing auth-smoke fixture

**Done:** PR opened with both phases in one diff (smaller than splitting two). Reviewer approves; merge to staging.

### Phase B — Frontend (Vance)

**Phase B.0** — Component scaffolding against the mock
- PainelTutorialOverlay.tsx (component shell + STEPS config + render math)
- PainelTutorialTrigger.tsx (floating CTA)
- painelTutorialMock.ts (temporary hook)
- Wire into PainelPage.tsx behind a feature flag `?tutorial=force` so it's testable locally without affecting other dev work
- data-tutorial-target on PainelMenuRow
- Visual fidelity walk against the 18 screenshots
- Storybook stories OR a `/painel/tutorial-demo` route showing each of the 9 steps in isolation (Vance's call)

**Phase B.1** — Integration with Rex's tRPC
- Delete painelTutorialMock.ts; swap for `trpc.usuario.tutorialStatus.useQuery()` + `useMutation()`
- Auto-open logic on first-paint for `completado === false`
- Floating CTA gated on `!overlayOpen`
- E2E test (Playwright) exercising the full happy path: load painel as never-completed user → overlay opens → walk through 9 steps → CONCLUIR → mutation fires → reload → overlay does not auto-open → click floating CTA → overlay re-opens → ENCERRAR → no extra mutation (already completed)

**Done:** PR opened with both sub-phases; visual fidelity review by operator; merge to staging.

### Phase C — Live walk + operator sign-off

- Walk the deployed staging painel (`eunenem.xeroxtoxerox.com/painel/<test-user-slug>`) as a freshly-registered admin
- Verify the auto-open + completion path end-to-end against a real DB
- Verify the re-trigger path
- Verify the dismissal path
- Operator visual sign-off; close the epic

## Open questions

These need operator clarification BEFORE implementation begins. Listed in rough priority order.

1. **TUTORIAL + AJUDA top-nav chips: in scope or out?** The screenshots show a top-nav with chips `MINHA PÁGINA / TUTORIAL / AJUDA` that don't exist in the current `PainelTopbar` (`MINHA ÁREA / EXTRATO / CONVIDADOS / CONVITE`). Three possibilities:
   - (a) The screenshots are from a mockup of a future redesigned topbar, AND that redesign is in scope for v1 of this tutorial bead.
   - (b) The redesign is a separate concern; v1 of this tutorial ships the spotlight overlay + floating CTA + ENCERRAR button only, against the existing topbar.
   - (c) The TUTORIAL + AJUDA chips appear ONLY during the active overlay, replacing/augmenting the standard nav temporarily.
   Plan currently scopes per (b) — out of scope. Operator confirms before Vance starts.

2. **What does the AJUDA chip do?** If (a) or (c) above, the chip presence implies behavior. The screenshots don't show the chip being clicked. Options:
   - Opens a help drawer / modal with FAQ-style content
   - Re-triggers the tutorial (redundant with the floating CTA)
   - Opens the `fale com a gente` (suporte) destination
   Out-of-scope for v1 if the chip is out of scope per #1.

3. **Step count discrepancy.** GLaDOS's dispatch says `passo N/17`. Screenshots show `passo N/9`. Confirm the canonical count is 9.

4. **Mock data leakage.** Step descrições in the screenshots reference "Helena" + "o bebê". The mock data uses "página da Helena" — those words may have leaked into the popover copy. Should the production copy interpolate the actual user's nomeExibicao + their bebê pronouns (?), or stay generic? Plan currently uses generic copy verbatim from screenshots.

5. **Skip-vs-complete semantics.** Locked decision #6 treats ENCERRAR as identical to CONCLUIR (both fire `completarTutorial`). Operator might want distinct tracking: "completed all 9 steps" vs "skipped before finishing". Currently single field, single mutation. If distinct, add `tutorialPuladoEm: Date | null` alongside.

6. **Floating CTA visibility for completed users.** Locked decision #5 says the floating CTA is visible to all users (including completed). Should the floating CTA's STYLE change for completed users (e.g. subtler tone since they've already seen it)? Currently no — same button regardless.

7. **Mobile coverage.** The narrow-viewport screenshots imply mobile/tablet support. Confirm the target breakpoint(s). Plan currently does single-breakpoint switching at the existing `painel-menu-grid` responsive breakpoint (1-col mobile vs 2-col desktop).

8. **Notification badge interaction.** The top-nav bell icon (notification badge) is visible during the overlay's dimmed state. Should the tutorial overlay block click-through to it? Plan currently locks body scroll AND swallows pointer events on the background overlay; the bell is visually visible but not clickable during tutorial.

## Out of scope

Each of these gets its own bead after this plan lands (or operator decides otherwise):

- **TUTORIAL + AJUDA top-nav chips** (per open question #1) — separate Vance bead if operator wants them.
- **AJUDA chip behavior** (per open question #2) — separate bead with its own design.
- **Per-step progress persistence** — "resume where you left off" UX. Locked decision #10 explicitly rejects this for v1.
- **Tutorial reset for testing** — admin-tool affordance to flip `tutorialCompletadoEm` back to null for QA walks. Useful but not critical for v1.
- **A/B testing or analytics** — funnel tracking for tutorial completion vs dismissal vs ignored. Useful for product iteration but no surface today.
- **Localisation** — the copy is Portuguese-Brazilian only (matches the painel surface). If/when eucasei or other plataformas ship, the copy may need scoping per `idPlataforma`.
- **Mobile app (native) version** — out of scope; no mobile app today.
- **Multi-step animations / transitions** — Framer Motion can do them; v1 uses simple fade-in / fade-out per step transition. Polish pass possible later.
- **Accessibility audit** — the overlay should be keyboard-navigable (Tab through buttons, Escape to close, arrow keys for back/next?), screen-reader friendly. Plan covers the basics (Escape closes, aria-labels on buttons); a dedicated a11y pass is a follow-up bead.

## Companion docs (post-implementation)

- Update `apps/eunenem-server/README.md` (if it lists painel surfaces) with the new tutorial overlay + the gating model.
- Atlas's CONTEXTS.md / ENGINE-DDD.md docs may want a one-paragraph note in the BC Usuário section about the new tutorialCompletadoEm field — not load-bearing for the docs, but tidy.

## Plan dependency notes

- Plan 0016 (multi-item Pagamento, in-flight as aperture-8eir8) is orthogonal — touches Pagamentos BC; does not touch Usuario BC.
- Plan 0010 (real auth) is a hard prerequisite — `authProcedure` + session-derived idUsuario are how the tRPC procedures gate themselves. Already shipped via aperture-pgqih.
- The painel scaffolding (aperture-i01o / aperture-fx2iz) ships the surfaces this tutorial walks through. Already on staging.
