import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type {
  ObjectStorage,
  SlotFoto,
  UrlUploadPresignada,
} from '../../adapters/storage/object-storage.js';
import { IdCampanhaSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Allowed photo content-types — mirrors `emitir-url-upload-foto.ts` (the
 * per-user emitter) verbatim. Anything outside this set is rejected before
 * a presign is minted.
 */
const CONTENT_TYPES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'] as const;

const SLOTS_PERMITIDOS = ['perfil', 'capa', 'historia'] as const satisfies readonly SlotFoto[];

/**
 * Caller input. `idCampanha` is NOT here — it's owner-gated by the tRPC
 * procedure (resolverCampanhaAdministrada) and passed in separately (no
 * "upload to someone else's campanha" shape). Only `slot` + `contentType`
 * cross the wire.
 */
export const EmitirUrlUploadFotoCampanhaInputSchema = z.object({
  slot: z.enum(SLOTS_PERMITIDOS),
  contentType: z.enum(CONTENT_TYPES_PERMITIDOS),
});

export type EmitirUrlUploadFotoCampanhaInput = z.input<
  typeof EmitirUrlUploadFotoCampanhaInputSchema
>;

export interface EmitirUrlUploadFotoCampanhaDeps {
  readonly objectStorage: ObjectStorage;
  readonly observability: Observability;
}

/**
 * Emit a presigned PUT URL for a per-campanha profile photo upload
 * (aperture-aphk8, W1a).
 *
 * PARALLEL use-case to `emitirUrlUploadFoto` (per-user): that emitter's key
 * construction is user-hardcoded (`perfis/<idUsuario>/...`) inside the
 * ObjectStorage adapters, so this one delegates to the campanha-scoped port
 * method instead — keys are namespaced `campanha/<idCampanha>/<slot>-<uuid>.<ext>`.
 * The existing per-user use-case's behavior is untouched.
 *
 * Auth is NOT enforced here — the tRPC procedure owner-gates `idCampanha`
 * via resolverCampanhaAdministrada before calling (keeps it unit-testable).
 */
export async function emitirUrlUploadFotoCampanha(
  deps: EmitirUrlUploadFotoCampanhaDeps,
  idCampanha: string,
  input: EmitirUrlUploadFotoCampanhaInput,
): Promise<UrlUploadPresignada> {
  const { objectStorage, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('emitirUrlUploadFotoCampanha', async (span) => {
    try {
      const idParsed = IdCampanhaSchema.safeParse(idCampanha);
      if (!idParsed.success) {
        const message = idParsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(`idCampanha inválido: ${message}`);
      }

      const parsed = EmitirUrlUploadFotoCampanhaInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { slot, contentType } = parsed.data;
      span.setAttribute('campanha.id', idParsed.data);
      span.setAttribute('storage.slot', slot);

      const presigned = await objectStorage.emitirUrlUploadPresignadaCampanha({
        idCampanha: idParsed.data,
        slot,
        contentType,
      });

      logger.info('arrecadacao.foto_campanha.url_upload_emitida', {
        idCampanha: idParsed.data,
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
