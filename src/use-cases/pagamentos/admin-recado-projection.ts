import { z } from 'zod/v4';

/**
 * aperture-16wrk / 5v766 Phase A — wire-shape contract for the
 * /painel/<slug>/mensagens dashboard. SHARED with the frontend
 * (Vance / Phase B) via this module's export; frontend scaffolds
 * against the inferred type so the wire shape can only drift if
 * both ends drift together (contract-pinning per the banked
 * 4-layer-defense memory).
 *
 * Date/Money formatting at the wire:
 *   - `criadoEm` + `lidaEm` ship as ISO-8601 strings (offset-bearing).
 *     The use-case stringifies on the way out so JSON serialisation
 *     across the tRPC boundary is stable + parseable.
 *   - `valorContribuicaoCents` ships as a non-negative integer (cents).
 *     The frontend formats to BRL at render.
 *   - `contribuicaoNome` is the resolved name of the FIRST contribuição
 *     item on the cart; `null` when the row was deleted between
 *     pagamento creation and read.
 */
export const AdminRecadoProjectionSchema = z.object({
  idPagamento: z.string().uuid(),
  contribuinteNome: z.string(),
  mensagem: z.string(),
  criadoEm: z.string().datetime({ offset: true }),
  lidaEm: z.string().datetime({ offset: true }).nullable(),
  valorContribuicaoCents: z.number().int().nonnegative(),
  contribuicaoNome: z.string().nullable(),
});

export type AdminRecadoProjection = z.infer<typeof AdminRecadoProjectionSchema>;

/**
 * Wire-shape for `obterRecadosAdminDeCampanha`: the projected recados
 * + the count chips ("todas N" / "não lidas M"). Counts are derived
 * from the same row set the use-case projects — frontend doesn't
 * have to re-count.
 */
export const AdminMensagensResponseSchema = z.object({
  recados: z.array(AdminRecadoProjectionSchema),
  counts: z.object({
    todas: z.number().int().nonnegative(),
    naoLidas: z.number().int().nonnegative(),
  }),
});

export type AdminMensagensResponse = z.infer<typeof AdminMensagensResponseSchema>;
