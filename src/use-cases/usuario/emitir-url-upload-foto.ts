import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type {
  ObjectStorage,
  SlotFoto,
  UrlUploadPresignada,
} from '../../adapters/storage/object-storage.js';
import { IdUsuarioSchema } from '../../domain/usuario/value-objects/ids.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Allowed photo content-types. Locked here (the only place callers can
 * widen it) — anything outside this set is rejected before a presign is
 * minted, so the bucket only ever receives the MIME types we accept.
 */
const CONTENT_TYPES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'] as const;

const SLOTS_PERMITIDOS = ['perfil', 'capa', 'historia'] as const satisfies readonly SlotFoto[];

/**
 * Caller input. `idUsuario` is NOT here — it's derived from the session by
 * the tRPC procedure and passed in separately (no "upload to someone else's
 * namespace" shape). Only `slot` + `contentType` cross the wire.
 */
export const EmitirUrlUploadFotoInputSchema = z.object({
  slot: z.enum(SLOTS_PERMITIDOS),
  contentType: z.enum(CONTENT_TYPES_PERMITIDOS),
});

export type EmitirUrlUploadFotoInput = z.input<typeof EmitirUrlUploadFotoInputSchema>;

export interface EmitirUrlUploadFotoDeps {
  readonly objectStorage: ObjectStorage;
  readonly observability: Observability;
}

/**
 * Emit a presigned PUT URL for a profile photo upload (aperture-kcasm).
 *
 * AUTHED by caller: `idUsuario` is supplied by the tRPC procedure from the
 * session cookie, NEVER from client input — that's what namespaces the key
 * per user. Validates the content-type against the allowed image set
 * (rejecting anything else with `UsuarioInputInvalidoError`) and delegates
 * the actual presign + key construction to the injected ObjectStorage port.
 *
 * Auth is NOT enforced here — same convention as the other usuario
 * use-cases (keeps it unit-testable). Generates nothing itself.
 */
export async function emitirUrlUploadFoto(
  deps: EmitirUrlUploadFotoDeps,
  idUsuario: string,
  input: EmitirUrlUploadFotoInput,
): Promise<UrlUploadPresignada> {
  const { objectStorage, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('emitirUrlUploadFoto', async (span) => {
    try {
      const idParsed = IdUsuarioSchema.safeParse(idUsuario);
      if (!idParsed.success) {
        const message = idParsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(`idUsuario inválido: ${message}`);
      }

      const parsed = EmitirUrlUploadFotoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const { slot, contentType } = parsed.data;
      span.setAttribute('usuario.id', idParsed.data);
      span.setAttribute('storage.slot', slot);

      const presigned = await objectStorage.emitirUrlUploadPresignada({
        idUsuario: idParsed.data,
        slot,
        contentType,
      });

      logger.info('usuario.foto.url_upload_emitida', {
        idUsuario: idParsed.data,
        slot,
        objectKey: presigned.objectKey,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return presigned;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
