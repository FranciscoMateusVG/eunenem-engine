/**
 * AdminRecadoProjection — shared zod contract for the admin mensagens slice
 * (aperture-5v766 Phase B).
 *
 * Mirrors the projection that Rex's Phase A backend (aperture-16wrk) will
 * expose under `admin.mensagens.list`. Kept here as the contract-pinning
 * locked artifact so the Phase B frontend can scaffold against the mock
 * hooks today; when Rex's backend lands, the swap is:
 *
 *   TODO(aperture-5v766-rex-swap): once Rex's PR (aperture-16wrk) merges
 *   and the domain export ships at `src/index.ts`, replace this module's
 *   schema definition with:
 *
 *     export {
 *       AdminRecadoProjectionSchema,
 *       type AdminRecadoProjection,
 *     } from '../../../../../src/index.js';
 *
 *   The shape MUST match verbatim — any drift is a contract violation and
 *   surfaces as a tsc error at the call sites in `useMensagensAdmin.ts`
 *   and `MensagensBody.tsx`. That's the point.
 *
 * Fields:
 *   - idPagamento:        UUID of the pagamento row carrying the mensagem
 *   - contribuinteNome:   Display name (pre-validated upstream — never blank)
 *   - mensagem:           The recado text the contribuinte left at checkout
 *   - criadoEm:           Pagamento.criadoEm — when the recado arrived
 *   - valorContribuicao:  Amount of the contribuição in CENTS (BRL)
 *   - contribuicaoNome:   Display label for the contribuição/gift
 *   - lidaEm:             null = unread; Date = timestamp it was marked read
 *
 * Counts envelope returned alongside the list (also locked):
 *   - todas:    total count regardless of read state
 *   - naoLidas: count of rows where lidaEm === null
 */
import { z } from 'zod';

export const AdminRecadoProjectionSchema = z.object({
  idPagamento: z.string().uuid(),
  contribuinteNome: z.string().min(1),
  mensagem: z.string().min(1),
  criadoEm: z.date(),
  valorContribuicao: z.number().int().nonnegative(),
  contribuicaoNome: z.string().min(1),
  lidaEm: z.date().nullable(),
});

export type AdminRecadoProjection = z.infer<typeof AdminRecadoProjectionSchema>;

export const AdminRecadoCountsSchema = z.object({
  todas: z.number().int().nonnegative(),
  naoLidas: z.number().int().nonnegative(),
});

export type AdminRecadoCounts = z.infer<typeof AdminRecadoCountsSchema>;

export const AdminMensagensListSchema = z.object({
  recados: z.array(AdminRecadoProjectionSchema),
  counts: AdminRecadoCountsSchema,
});

export type AdminMensagensList = z.infer<typeof AdminMensagensListSchema>;
