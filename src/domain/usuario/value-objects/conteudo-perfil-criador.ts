import { z } from 'zod/v4';
import { GeneroBebeSchema } from './genero-bebe.js';
import { TipoEventoPerfilSchema } from './tipo-evento-perfil.js';

/**
 * Value object: the editable content of a creator's public profile
 * (aperture-3dlzs). Immutable, validated by value, no identity of its own —
 * it lives inside the `PerfilCriador` aggregate root (1:1 with Usuario).
 *
 * Every field is nullable: a profile is created empty at first and filled in
 * progressively through the painel form. The use case (R3) normalizes blank
 * input to `null` rather than empty strings.
 *
 * Storage refs (`fotoPerfilKey` / `fotoCapaKey` / `fotoHistoriaKey`) hold the
 * object-storage KEY only — the actual upload/presign flow lands in R5
 * (aperture storage bead). Here they are opaque, length-bounded strings.
 */
export const ConteudoPerfilCriadorSchema = z.object({
  /** Baby / celebrated-person name shown on the profile. */
  nomeBebe: z.string().trim().min(1).max(120).nullable(),
  /** Creator's relation to the baby (e.g. "Mãe", "Tia", "Padrinho"). */
  relacao: z.string().trim().min(1).max(60).nullable(),
  /** Free-text story shown on the profile, capped at 600 chars. */
  historia: z.string().trim().max(600).nullable(),
  /** Baby's birth date (display copy). */
  dataNascimento: z.date().nullable(),
  /** Celebration kind — canonical slug aligned to the Evento BC. */
  tipoEvento: TipoEventoPerfilSchema.nullable(),
  /** Baby's gender — drives PT-BR pronoun/article agreement on greetings. */
  genero: GeneroBebeSchema.nullable(),
  /** Event date shown on the profile (display copy). */
  dataEvento: z.date().nullable(),
  /** Object-storage key for the profile photo (resolved/presigned in R5). */
  fotoPerfilKey: z.string().trim().min(1).max(512).nullable(),
  /** Object-storage key for the cover photo. */
  fotoCapaKey: z.string().trim().min(1).max(512).nullable(),
  /** Object-storage key for the story photo. */
  fotoHistoriaKey: z.string().trim().min(1).max(512).nullable(),
  /** Display line for the parents/family shown on the profile (TweaksPanel "parents"). */
  papais: z.string().trim().min(1).max(120).nullable(),
  /** Primary theme color (hex) chosen via the TweaksPanel swatches. */
  corPrimaria: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
  /** Accent theme color (hex) chosen via the TweaksPanel swatches. */
  corAcento: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
});

export type ConteudoPerfilCriador = Readonly<z.infer<typeof ConteudoPerfilCriadorSchema>>;

/** Empty profile content — all fields null. Used when a profile is first created. */
export function conteudoPerfilCriadorVazio(): ConteudoPerfilCriador {
  return {
    nomeBebe: null,
    relacao: null,
    historia: null,
    dataNascimento: null,
    tipoEvento: null,
    genero: null,
    dataEvento: null,
    fotoPerfilKey: null,
    fotoCapaKey: null,
    fotoHistoriaKey: null,
    papais: null,
    corPrimaria: null,
    corAcento: null,
  };
}
