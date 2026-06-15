import { z } from 'zod/v4';

/**
 * Plan 0018 Phase A (aperture-omswg). SHARED response shape for both
 * `usuario.tutorialStatus` (query) and `usuario.completarTutorial`
 * (mutation). Frontend imports the type-only inference for
 * Vance's TutorialOverlay scaffold (contract-pinning per banked
 * 4-layer-defense memory).
 *
 * Two-field shape with NULL-vs-non-NULL semantic:
 *   - completado=false + completadoEm=null    → first-time user, fire the overlay
 *   - completado=true  + completadoEm=<iso>   → already done; do not render the overlay
 *
 * `completadoEm` is the ISO string (NOT a Date) because the response
 * crosses the tRPC wire. The frontend can `new Date(...)` when it
 * wants to display "completed 3 days ago" UX.
 *
 * `completado` is REDUNDANT given `completadoEm !== null` carries the
 * same signal — it's kept as an explicit boolean for two reasons:
 *   1. Discriminated-union ergonomics on the frontend: `if (status.completado)`
 *      reads cleaner than `if (status.completadoEm !== null)`.
 *   2. Future-proofing: if the backend ever splits completion-eligibility
 *      from completion-timestamp (e.g. an admin force-skip without a
 *      timestamp), the boolean can encode the difference.
 */
export const TutorialStatusResponseSchema = z.object({
  completado: z.boolean(),
  completadoEm: z.string().datetime({ offset: true }).nullable(),
});

export type TutorialStatusResponse = z.infer<typeof TutorialStatusResponseSchema>;
