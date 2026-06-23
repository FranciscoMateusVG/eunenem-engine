import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  CONTENT_TYPE_EXTENSAO,
  type EmitirUrlUploadInput,
  type ObjectStorage,
  type UrlUploadPresignada,
} from './object-storage.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'objects',
} as const;

const BUCKET_PADRAO = 'eunenem-perfil-fotos';

/** Recorded call — the input plus the deterministic result the fake returned. */
export interface UploadRegistrado {
  readonly input: EmitirUrlUploadInput;
  readonly resultado: UrlUploadPresignada;
}

/**
 * In-memory `ObjectStorage` (aperture-kcasm). Used by unit tests + any
 * future in-process integration tests. Mints DETERMINISTIC `memory://`
 * URLs (no network, no real bucket) and RECORDS every call in the public
 * `uploads` array so tests can assert on the emitted keys + content-types.
 *
 * Mirrors the real adapter's key-namespacing + content-type → extension
 * derivation, so a key produced here has the same shape the MinIO adapter
 * would produce. Mirrors the OTel span shape (db.system 'memory').
 */
export class ObjectStorageMemory implements ObjectStorage {
  /** Every emitirUrlUploadPresignada call, in order. Public for test assertions. */
  public readonly uploads: UploadRegistrado[] = [];

  constructor(private readonly bucket: string = BUCKET_PADRAO) {}

  async emitirUrlUploadPresignada(input: EmitirUrlUploadInput): Promise<UrlUploadPresignada> {
    return tracer.startActiveSpan('storage.emitirUrlUploadPresignada', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'PRESIGN_PUT' });
      try {
        span.setAttribute('usuario.id', input.idUsuario);
        span.setAttribute('storage.slot', input.slot);

        const ext = CONTENT_TYPE_EXTENSAO[input.contentType];
        if (ext === undefined) {
          throw new Error(`contentType não suportado: ${input.contentType}`);
        }

        const objectKey = `perfis/${input.idUsuario}/${input.slot}-${randomUUID()}.${ext}`;
        const resultado: UrlUploadPresignada = {
          uploadUrl: `memory://upload/${this.bucket}/${objectKey}`,
          objectKey,
          publicUrl: `memory://${this.bucket}/${objectKey}`,
        };

        this.uploads.push({ input, resultado });

        span.setStatus({ code: SpanStatusCode.OK });
        return resultado;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
