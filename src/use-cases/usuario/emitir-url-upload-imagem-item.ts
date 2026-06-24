import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type {
  ObjectStorage,
  UrlUploadPresignada,
} from '../../adapters/storage/object-storage.js';
import { IdUsuarioSchema } from '../../domain/usuario/value-objects/ids.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Allowed item-image content-types (aperture-tua9o). Locked here (the only
 * place callers can widen it) — anything outside this set is rejected before
 * a presign is minted, so the bucket only ever receives the MIME types we
 * accept. Re-declared locally (NOT shared with the profile emitter) so the
 * two use-cases stay independently evolvable.
 */
const CONTENT_TYPES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Caller input for a custom-gift ITEM image upload (aperture-tua9o).
 * `idUsuario` is NOT here — it's derived from the session by the tRPC
 * procedure and passed in separately (no "upload to someone else's
 * namespace" shape). Item images have NO slot, so only `contentType`
 * crosses the wire.
 */
export const EmitirUrlUploadImagemItemInputSchema = z.object({
  contentType: z.enum(CONTENT_TYPES_PERMITIDOS),
});

export type EmitirUrlUploadImagemItemInput = z.input<typeof EmitirUrlUploadImagemItemInputSchema>;

export interface EmitirUrlUploadImagemItemDeps {
  readonly objectStorage: ObjectStorage;
  readonly observability: Observability;
}

/**
 * Emit a presigned PUT URL for a custom-gift ITEM image upload
 * (aperture-tua9o). SIBLING of `emitirUrlUploadFoto` but item-scoped: there
 * is NO slot, so the resulting key is `itens/<idUsuario>/<uuid>.<ext>`.
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
export async function emitirUrlUploadImagemItem(
  deps: EmitirUrlUploadImagemItemDeps,
  idUsuario: string,
  input: EmitirUrlUploadImagemItemInput,
): Promise<UrlUploadPresignada> {
  const { objectStorage, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('emitirUrlUploadImagemItem', async (span) => {
    try {
      const idParsed = IdUsuarioSchema.safeParse(idUsuario);
      if (!idParsed.success) {
        const message = idParsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(`idUsuario inválido: ${message}`);
      }

      const parsed = EmitirUrlUploadImagemItemInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const { contentType } = parsed.data;
      span.setAttribute('usuario.id', idParsed.data);

      const presigned = await objectStorage.emitirUrlUploadPresignadaItem({
        idUsuario: idParsed.data,
        contentType,
      });

      logger.info('usuario.imagem_item.url_upload_emitida', {
        idUsuario: idParsed.data,
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
