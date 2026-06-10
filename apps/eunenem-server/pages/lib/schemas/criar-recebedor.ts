// aperture-kbmel — Shared zod schema for `recebedor.criar` tRPC mutation.
//
// CONTRACT PINNING (see PR body for the full swap-over plan):
// This schema is the canonical input contract for the upcoming
// `recebedor.criar` procedure. Both sides consume it:
//
//   - Frontend (TODAY): the mock hook in `pages/lib/hooks/useCriarRecebedor.ts`
//     validates form output against this schema before "submitting" (no-op
//     persist), so when Rex's real procedure lands the wire payload is
//     already shaped correctly.
//
//   - Backend (REX's LANE): `recebedor.criar` in `server/trpc/recebedor-router.ts`
//     will `import { CriarRecebedorInputSchema } from "@/lib/schemas/criar-recebedor"`
//     and use it as `t.procedure.input(CriarRecebedorInputSchema).mutation(...)`.
//
// This monorepo has no `packages/domains`. The closest convention is to
// colocate shared zod schemas under `pages/lib/schemas/` — server tRPC
// routers already import from `@/lib/...` paths (via tsconfig paths), so
// the schema is reachable from both surfaces without a package boundary.
//
// MIGRATION NOTE: when/if `packages/domains` lands (per kbmel's spec, future
// work), move this file there as `packages/domains/src/recebedor/criar.ts`
// and update both frontend + backend imports in the same swap.

import { z } from "zod";

/**
 * `tipo` — discriminator for which dadosBancarios shape applies.
 *  - "conta_completa" → full bank account (banco / agência / conta / DV / tipo)
 *  - "chave_pix"      → single Pix key (with key-type subdiscriminator)
 */
export const RecebedorTipoSchema = z.enum(["conta_completa", "chave_pix"]);
export type RecebedorTipo = z.infer<typeof RecebedorTipoSchema>;

/**
 * Pix key kind (matches `PIX_TYPES` in `pages/lib/mocks/bancarios.ts`).
 * Kept in sync with the BancariosBody form's `tipoPix` state.
 */
export const PixKeyTipoSchema = z.enum(["cpf", "email", "celular", "aleatoria"]);
export type PixKeyTipo = z.infer<typeof PixKeyTipoSchema>;

/**
 * Account kind — Compe-banking semantics.
 *  - cc   → Conta Corrente
 *  - cp   → Conta Poupança
 *  - pg   → Conta de Pagamento
 *  - csl  → Conta Salário
 */
export const ContaTipoSchema = z.enum(["cc", "cp", "pg", "csl"]);
export type ContaTipo = z.infer<typeof ContaTipoSchema>;

/**
 * Full bank account payload (Compe codes + DV).
 *
 * Validations match the existing BancariosBody client-side rules:
 *  - bankCode: Compe 3-digit string
 *  - agencia: 1..6 digits
 *  - agenciaDV: optional, 1..2 chars (digit or X)
 *  - conta: 1..14 digits
 *  - contaDV: 1..2 chars (digit or X), REQUIRED
 */
export const DadosContaCompletaSchema = z.object({
  bankCode: z.string().regex(/^\d{3}$/, "código Compe deve ter 3 dígitos"),
  agencia: z.string().regex(/^\d{1,6}$/, "agência deve ter 1 a 6 dígitos"),
  agenciaDV: z.string().regex(/^[\dxX]{0,2}$/).optional().default(""),
  conta: z.string().regex(/^\d{1,14}$/, "conta deve ter 1 a 14 dígitos"),
  contaDV: z.string().regex(/^[\dxX]{1,2}$/, "dígito da conta é obrigatório"),
  tipoConta: ContaTipoSchema,
});
export type DadosContaCompleta = z.infer<typeof DadosContaCompletaSchema>;

/**
 * Pix key payload — key type + raw key string. Backend (Rex's lane) is
 * responsible for the actual DICT lookup + titular-CPF cross-check; the
 * frontend only enforces shape per `PixKeyTipo`.
 */
export const DadosChavePixSchema = z.object({
  tipoChave: PixKeyTipoSchema,
  chave: z.string().min(1, "chave Pix é obrigatória"),
});
export type DadosChavePix = z.infer<typeof DadosChavePixSchema>;

/**
 * Discriminated union on `tipo`. Branching on `tipo` gives the backend a
 * single zod-validated payload — no separate "if tipo === pix then" checks.
 */
export const DadosBancariosSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("conta_completa"), dados: DadosContaCompletaSchema }),
  z.object({ tipo: z.literal("chave_pix"), dados: DadosChavePixSchema }),
]);
export type DadosBancarios = z.infer<typeof DadosBancariosSchema>;

/**
 * Titular block — nome (must match documento) + telefone for notification.
 * CPF is NOT in the input: it's locked to the authenticated session's CPF
 * server-side (the BancariosBody UI hard-locks the field, and the backend
 * MUST ignore any CPF the client tries to send).
 */
export const TitularSchema = z.object({
  nome: z.string().min(3, "nome do titular precisa ter pelo menos 3 caracteres"),
  telefone: z.string().regex(/^\(\d{2}\) \d{4,5}-\d{4}$/, "celular inválido"),
});
export type Titular = z.infer<typeof TitularSchema>;

/**
 * Full input to `recebedor.criar`.
 *
 * Note `idCampanha` is required at the procedure level — the recebedor
 * belongs to a specific campanha. The frontend resolves this from
 * `auth.me().idCampanha` before submitting.
 */
export const CriarRecebedorInputSchema = z.object({
  idCampanha: z.string().uuid(),
  dadosBancarios: DadosBancariosSchema,
  titular: TitularSchema,
});
export type CriarRecebedorInput = z.infer<typeof CriarRecebedorInputSchema>;

/**
 * Output: the freshly-minted recebedor's id. Lets the caller chain into
 * `solicitarRepasseRecebedor({ idCampanha })` immediately — no second
 * round-trip to fetch the recebedor's id.
 */
export const CriarRecebedorOutputSchema = z.object({
  idRecebedor: z.string(),
});
export type CriarRecebedorOutput = z.infer<typeof CriarRecebedorOutputSchema>;
