import { z } from 'zod/v4';

/**
 * Value object: kind of celebration shown on the creator's public profile
 * (aperture-3dlzs). This is a **display copy** carried by `PerfilCriador`,
 * NOT a live reference to the `Evento` BC — the profile is per-Usuario and
 * may exist before any campanha/evento (operator decision #2).
 *
 * ⚠️ ENUM ALIGNMENT (silent-bug fix flagged by Wheatley in aperture-qk5wi):
 * the canonical celebration vocabulary lives in the Evento BC
 * (`src/domain/evento/value-objects/tipo-evento.ts` → `TipoEventoSchema`).
 * These values are kept BYTE-FOR-BYTE IN SYNC with that enum so the profile
 * never stores a value the rest of the domain can't read. We deliberately do
 * NOT import the Evento BC's schema (dependency-cruiser forbids cross-BC
 * domain imports); this is a local mirror VO, the same convention used for
 * `IdPlataformaReferencia`.
 *
 * Frontend mismatch to resolve in V1 (Vance): the profile form
 * (`PerfilBody.tsx` → `PERFIL_EVENT_TYPES`) presents human labels
 * — "Chá de bebê", "Chá revelação", "Maternidade", "Aniversário" — which do
 * NOT map 1:1 to these slugs. The frontend MUST translate its labels to
 * these canonical slugs before sending to the API; the API rejects anything
 * outside this set. Suggested mapping:
 *   "Chá de bebê"     → 'cha-bebe'
 *   "Chá revelação"   → 'cha-revelacao'
 *   "Maternidade"     → (no slug today; closest is 'cha-bebe' — confirm w/ product)
 *   "Aniversário"     → 'aniversario'
 */
export const TipoEventoPerfilSchema = z.enum([
  'cha-bebe',
  'cha-fraldas',
  'cha-surpresa',
  'cha-revelacao',
  'batizado',
  'aniversario',
]);

export type TipoEventoPerfil = z.infer<typeof TipoEventoPerfilSchema>;
