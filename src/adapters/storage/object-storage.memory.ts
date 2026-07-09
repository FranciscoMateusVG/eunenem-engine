import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  CONTENT_TYPE_EXTENSAO,
  type EmitirUrlUploadCampanhaInput,
  type EmitirUrlUploadInput,
  type EmitirUrlUploadItemInput,
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

  /**
   * Every emitirUrlUploadPresignadaItem call, in order (aperture-tua9o).
   * Public for test assertions — same role as `uploads` for the profile
   * emitter, kept separate so item-image tests assert in isolation.
   */
  public readonly itemUploads: {
    input: EmitirUrlUploadItemInput;
    resultado: UrlUploadPresignada;
  }[] = [];

  /**
   * Every emitirUrlUploadPresignadaCampanha call, in order (aperture-aphk8).
   * Public for test assertions — same role as `uploads` for the per-user
   * profile emitter, kept separate so per-campanha tests assert in isolation.
   */
  public readonly campanhaUploads: {
    input: EmitirUrlUploadCampanhaInput;
    resultado: UrlUploadPresignada;
  }[] = [];

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

  async emitirUrlUploadPresignadaItem(
    input: EmitirUrlUploadItemInput,
  ): Promise<UrlUploadPresignada> {
    return tracer.startActiveSpan('storage.emitirUrlUploadPresignadaItem', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'PRESIGN_PUT' });
      try {
        span.setAttribute('usuario.id', input.idUsuario);

        const ext = CONTENT_TYPE_EXTENSAO[input.contentType];
        if (ext === undefined) {
          throw new Error(`contentType não suportado: ${input.contentType}`);
        }

        const objectKey = `itens/${input.idUsuario}/${randomUUID()}.${ext}`;
        const resultado: UrlUploadPresignada = {
          uploadUrl: `memory://upload/${this.bucket}/${objectKey}`,
          objectKey,
          publicUrl: `memory://${this.bucket}/${objectKey}`,
        };

        this.itemUploads.push({ input, resultado });

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

  async emitirUrlUploadPresignadaCampanha(
    input: EmitirUrlUploadCampanhaInput,
  ): Promise<UrlUploadPresignada> {
    return tracer.startActiveSpan('storage.emitirUrlUploadPresignadaCampanha', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'PRESIGN_PUT' });
      try {
        span.setAttribute('campanha.id', input.idCampanha);
        span.setAttribute('storage.slot', input.slot);

        const ext = CONTENT_TYPE_EXTENSAO[input.contentType];
        if (ext === undefined) {
          throw new Error(`contentType não suportado: ${input.contentType}`);
        }

        const objectKey = `campanha/${input.idCampanha}/${input.slot}-${randomUUID()}.${ext}`;
        const resultado: UrlUploadPresignada = {
          uploadUrl: `memory://upload/${this.bucket}/${objectKey}`,
          objectKey,
          publicUrl: `memory://${this.bucket}/${objectKey}`,
        };

        this.campanhaUploads.push({ input, resultado });

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

  /** Deterministic public URL — same shape as `publicUrl` from a presign. */
  urlPublica(objectKey: string): string {
    return `memory://${this.bucket}/${objectKey}`;
  }

  /** Strips the `memory://${bucket}/` base REPEATEDLY → bare key (aperture-qjgfr). */
  extrairKey(urlOuKey: string): string {
    const base = `memory://${this.bucket}/`;
    let key = urlOuKey;
    while (key.startsWith(base)) {
      key = key.slice(base.length);
    }
    return key;
  }
}
