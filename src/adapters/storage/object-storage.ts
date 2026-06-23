/**
 * Object storage — infrastructure port (aperture-kcasm).
 *
 * Emits short-lived presigned PUT URLs so the client can upload profile
 * photos DIRECTLY to the bucket (MinIO / S3-compatible), bypassing the
 * server for the byte stream. The returned `objectKey` is later persisted
 * on the profile via the EXISTING `perfil.atualizar` mutation (R3) — this
 * port does NOT touch the profile.
 *
 * NOT a domain concept — object storage is a transport artifact at the
 * infrastructure boundary (same precedent as
 * `src/adapters/webhook-archive/`). No domain entity, no domain use-case
 * operates on storage objects; the presign capability is the whole surface.
 *
 * Security invariants baked into every implementation:
 *   - presigned URLs expire in 5 minutes (`expiresIn: 300`).
 *   - the upload's Content-Type is LOCKED into the presigned request, so
 *     the client cannot smuggle a different MIME type past the signature.
 *   - keys are namespaced per `idUsuario` (`perfis/<idUsuario>/...`) so
 *     user A can never overwrite user B's photo.
 *
 * R5 returns the constructed `publicUrl` only — read-back (public-read or
 * presigned-GET) is Peppy's bucket-policy concern, out of scope here.
 */

/** Photo slot on a creator profile — maps 1:1 to the profile's photo-key fields. */
export type SlotFoto = 'perfil' | 'capa' | 'historia';

export interface EmitirUrlUploadInput {
  /** Caller's user id — supplied by the tRPC procedure from the session, never client input. */
  readonly idUsuario: string;
  readonly slot: SlotFoto;
  /** Validated upstream to one of the allowed image types; locked into the presign. */
  readonly contentType: string;
}

export interface UrlUploadPresignada {
  /** Short-lived presigned PUT URL the client uploads the bytes to. */
  readonly uploadUrl: string;
  /** Namespaced object key (`perfis/<idUsuario>/<slot>-<uuid>.<ext>`) to persist on the profile. */
  readonly objectKey: string;
  /** Constructed public URL for later read-back (assumes public-read / presigned-GET bucket policy). */
  readonly publicUrl: string;
}

export interface ObjectStorage {
  /**
   * Mint a presigned PUT URL for a single profile photo upload.
   *
   * Derives the file extension from `contentType`, builds a per-user
   * namespaced key, and presigns a PutObjectCommand with the Content-Type
   * locked in and a 5-minute expiry. Returns the upload URL, the key, and
   * the constructed public URL.
   */
  emitirUrlUploadPresignada(input: EmitirUrlUploadInput): Promise<UrlUploadPresignada>;
}

/**
 * Allowed image content-types → file extension. The use-case rejects
 * anything not in this map; the adapter relies on it to derive the key
 * extension. Exported so callers/tests share one source of truth.
 */
export const CONTENT_TYPE_EXTENSAO: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
