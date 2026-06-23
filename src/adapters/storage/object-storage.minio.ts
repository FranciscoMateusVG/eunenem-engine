import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  CONTENT_TYPE_EXTENSAO,
  type EmitirUrlUploadInput,
  type ObjectStorage,
  type UrlUploadPresignada,
} from './object-storage.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'minio',
  'db.collection.name': 'objects',
} as const;

/** Presigned-URL lifetime in seconds. 5 minutes — security invariant, do NOT widen. */
const PRESIGN_EXPIRES_IN_SECONDS = 300;

/**
 * Config injected by the composition root (NOT read from process.env here —
 * same DI pattern as the other adapters). `endpoint` is the public
 * S3-compatible endpoint; `forcePathStyle` is REQUIRED for MinIO.
 */
export interface ObjectStorageMinioConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

/**
 * MinIO (S3-compatible) `ObjectStorage` (aperture-kcasm).
 *
 * Builds the S3Client with `forcePathStyle: true` (MinIO requires
 * path-style addressing — virtual-hosted-style buckets aren't routable on
 * a bare MinIO endpoint). Presigns PutObjectCommands with the Content-Type
 * locked in and a 5-minute expiry.
 */
export class ObjectStorageMinio implements ObjectStorage {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor(config: ObjectStorageMinioConfig) {
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async emitirUrlUploadPresignada(input: EmitirUrlUploadInput): Promise<UrlUploadPresignada> {
    return tracer.startActiveSpan('storage.emitirUrlUploadPresignada', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'PRESIGN_PUT' });
      try {
        span.setAttribute('usuario.id', input.idUsuario);
        span.setAttribute('storage.slot', input.slot);

        const ext = CONTENT_TYPE_EXTENSAO[input.contentType];
        if (ext === undefined) {
          // Defense-in-depth: the use-case validates first, but the adapter
          // refuses to mint a key for an unknown content-type so the
          // Content-Type lock is never bypassed.
          throw new Error(`contentType não suportado: ${input.contentType}`);
        }

        // Per-user namespaced key — user A can never overwrite user B's photo.
        const objectKey = `perfis/${input.idUsuario}/${input.slot}-${randomUUID()}.${ext}`;

        const uploadUrl = await getSignedUrl(
          this.s3,
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: objectKey,
            ContentType: input.contentType,
          }),
          { expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
        );

        const publicUrl = this.urlPublica(objectKey);

        span.setStatus({ code: SpanStatusCode.OK });
        return { uploadUrl, objectKey, publicUrl };
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Stable public read URL for a key. Pure string construction (bucket is
   * public-read) — no signature, no network. Single source of truth shared
   * with `emitirUrlUploadPresignada`'s `publicUrl`.
   */
  urlPublica(objectKey: string): string {
    return `${this.endpoint}/${this.bucket}/${objectKey}`;
  }

  /**
   * Normalize a value to a bare key — strips the public base
   * (`${endpoint}/${bucket}/`) REPEATEDLY so an accidentally re-prefixed value
   * (`base×N/key`) collapses to `key` (aperture-qjgfr). A bare key never starts
   * with the endpoint, so this is a no-op on already-bare keys.
   */
  extrairKey(urlOuKey: string): string {
    const base = `${this.endpoint}/${this.bucket}/`;
    let key = urlOuKey;
    while (key.startsWith(base)) {
      key = key.slice(base.length);
    }
    return key;
  }
}
