import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ObjectStorage } from '../../adapters/storage/object-storage.js';
import type { PerfilCriadorRepository } from '../../adapters/usuario/perfil-criador-repository.js';
import {
  atualizarConteudoPerfilCriador,
  criarPerfilCriador,
  type PerfilCriador,
} from '../../domain/usuario/entities/perfil-criador.js';
import {
  type ConteudoPerfilCriador,
  ConteudoPerfilCriadorSchema,
} from '../../domain/usuario/value-objects/conteudo-perfil-criador.js';
import { type IdPerfilCriador, IdUsuarioSchema } from '../../domain/usuario/value-objects/ids.js';
import { TipoEventoPerfilSchema } from '../../domain/usuario/value-objects/tipo-evento-perfil.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Input for the profile-content update (aperture-cdo69). Dates arrive as ISO
 * strings on the wire → coerced to Date. Blank strings normalize to null
 * (we store null, not empty strings). nomeExibicao is NOT here — it lives on
 * Usuario and is updated by `atualizarPerfilUsuario` (the router calls both).
 */
export const AtualizarPerfilCriadorInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  nomeBebe: z.string().trim().min(1).max(120).nullable(),
  relacao: z.string().trim().min(1).max(60).nullable(),
  historia: z.string().trim().max(600).nullable(),
  dataNascimento: z.coerce.date().nullable(),
  tipoEvento: TipoEventoPerfilSchema.nullable(),
  dataEvento: z.coerce.date().nullable(),
  fotoPerfilKey: z.string().trim().min(1).max(512).nullable(),
  fotoCapaKey: z.string().trim().min(1).max(512).nullable(),
  fotoHistoriaKey: z.string().trim().min(1).max(512).nullable(),
});

export type AtualizarPerfilCriadorInput = z.input<typeof AtualizarPerfilCriadorInputSchema>;

export interface AtualizarPerfilCriadorDeps {
  readonly perfilCriadorRepository: PerfilCriadorRepository;
  /**
   * Used to normalize incoming photo "keys" back to bare keys (aperture-qjgfr).
   * The client may round-trip a RESOLVED public URL into a fotoXKey field; we
   * strip the public base before persisting so the store stays idempotent and
   * self-heals any previously double-prefixed value.
   */
  readonly objectStorage: ObjectStorage;
  readonly observability: Observability;
  readonly clock: () => Date;
  readonly gerarId: () => IdPerfilCriador;
}

/**
 * Create-or-update the caller's profile content (1:1 with Usuario). Reads the
 * existing profile by idUsuario: if none, creates a fresh one; otherwise
 * replaces its content and bumps atualizadoEm. Identity + creation time are
 * preserved across re-saves by the adapter's 1:1 upsert.
 *
 * Auth is NOT enforced here — the tRPC procedure derives idUsuario from the
 * session and passes it in (keeps the use-case unit-testable).
 */
export async function atualizarPerfilCriador(
  deps: AtualizarPerfilCriadorDeps,
  input: AtualizarPerfilCriadorInput,
): Promise<PerfilCriador> {
  const { perfilCriadorRepository, objectStorage, observability, clock, gerarId } = deps;
  const { logger, tracer } = observability;
  const normalizarKey = (key: string | null): string | null =>
    key === null ? null : objectStorage.extrairKey(key);

  return tracer.startActiveSpan('atualizarPerfilCriador', async (span) => {
    try {
      const parsed = AtualizarPerfilCriadorInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const { idUsuario, ...rawRest } = parsed.data;
      span.setAttribute('usuario.id', idUsuario);

      // Idempotent persist (aperture-qjgfr): a fotoXKey arriving as a resolved
      // (or accidentally multi-prefixed) public URL is stripped back to a bare
      // key before storage, so the round-trip never re-prefixes the base.
      const rest = {
        ...rawRest,
        fotoPerfilKey: normalizarKey(rawRest.fotoPerfilKey),
        fotoCapaKey: normalizarKey(rawRest.fotoCapaKey),
        fotoHistoriaKey: normalizarKey(rawRest.fotoHistoriaKey),
      };

      // Re-validate the content as a domain VO (single source of truth for
      // the field invariants — historia cap, photo-key bounds, etc).
      const conteudoParsed = ConteudoPerfilCriadorSchema.safeParse(rest);
      if (!conteudoParsed.success) {
        const message = conteudoParsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }
      const conteudo: ConteudoPerfilCriador = conteudoParsed.data;

      const now = clock();
      const existing = await perfilCriadorRepository.findByUsuarioId(idUsuario);
      const perfil = existing
        ? atualizarConteudoPerfilCriador(existing, { conteudo, atualizadoEm: now })
        : criarPerfilCriador({ id: gerarId(), idUsuario, conteudo, criadoEm: now });

      await perfilCriadorRepository.save(perfil);

      logger.info('usuario.perfil_criador.atualizado', { idUsuario, criado: !existing });
      span.setStatus({ code: SpanStatusCode.OK });
      return perfil;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
