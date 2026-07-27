/**
 * Object storage — infrastructure port (aperture-kcasm).
 *
 * Emits short-lived presigned PUT URLs so the client can upload images
 * DIRECTLY to the bucket (MinIO / S3-compatible), bypassing the server for
 * the byte stream. The returned `objectKey` is persisted later by the
 * owning profile, item, campanha, or catalogue mutation — this port does
 * NOT touch domain state.
 *
 * NOT a domain concept — object storage is a transport artifact at the
 * infrastructure boundary (same precedent as
 * `src/adapters/webhook-archive/`). No domain entity, no domain use-case
 * operates on storage objects; the presign capability is the whole surface.
 *
 * Security invariants baked into every implementation:
 *   - presigned URLs expire in 5 minutes (`expiresIn: 300`).
 *   - catalogue uploads lock both Content-Type and Content-Length into the
 *     presigned request, so the client cannot smuggle a different MIME type
 *     or an unbounded body past the signature.
 *   - keys are namespaced by their owning surface. Profile/item keys are
 *     per-user, campanha keys are per-campanha, and admin catalogue product
 *     keys live under `catalogo/produtos/` with a server-generated UUID.
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

/**
 * Caller input for an ITEM (custom-gift) image upload (aperture-tua9o).
 *
 * SIBLING of `EmitirUrlUploadInput` but with NO `slot` — item images are
 * not profile-scoped, so the key is `itens/<idUsuario>/<uuid>.<ext>` (no
 * slot prefix). `idUsuario` is supplied by the tRPC procedure from the
 * session, never client input — that's what namespaces the key per user.
 */
export interface EmitirUrlUploadItemInput {
  /** Caller's user id — supplied by the tRPC procedure from the session, never client input. */
  readonly idUsuario: string;
  /** Validated upstream to one of the allowed image types; locked into the presign. */
  readonly contentType: string;
}

/**
 * Caller input for a CAMPANHA-scoped profile photo upload (aperture-aphk8).
 *
 * SIBLING of `EmitirUrlUploadInput` but keyed by `idCampanha` instead of
 * `idUsuario` — per-campanha profiles (perfil_campanhas) store photos under
 * `campanha/<idCampanha>/<slot>-<uuid>.<ext>`. `idCampanha` is supplied by
 * the tRPC procedure AFTER owner-gating (resolverCampanhaAdministrada),
 * never raw client input — that's what namespaces the key per campanha.
 */
export interface EmitirUrlUploadCampanhaInput {
  /** Owner-gated campanha id — supplied by the tRPC procedure, never raw client input. */
  readonly idCampanha: string;
  readonly slot: SlotFoto;
  /** Validated upstream to one of the allowed image types; locked into the presign. */
  readonly contentType: string;
}

/**
 * Caller input for an admin catalogue product image upload (aperture-d4pmw).
 *
 * The caller controls only the validated MIME type. The adapter generates the
 * complete key (`catalogo/produtos/<uuid>.<ext>`), so no client-controlled
 * filename, path segment, or identifier reaches object storage.
 */
export interface EmitirUrlUploadCatalogoInput {
  /** Validated upstream to one of the allowed image types; locked into the presign. */
  readonly contentType: string;
  /** Exact upload body size in bytes; locked into the presign. */
  readonly sizeBytes: number;
}

export interface UrlUploadPresignada {
  /** Short-lived presigned PUT URL the client uploads the bytes to. */
  readonly uploadUrl: string;
  /** Server-generated, surface-namespaced object key to persist on the owning record. */
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

  /**
   * Mint a presigned PUT URL for a single custom-gift ITEM image upload
   * (aperture-tua9o).
   *
   * SIBLING of `emitirUrlUploadPresignada` but item-scoped: there is NO
   * `slot`, so the key is `itens/<idUsuario>/<uuid>.<ext>` (no slot prefix).
   * Same security invariants as the profile emitter: derives the extension
   * from `contentType`, builds a per-user namespaced key (user A can never
   * overwrite user B's image), and presigns a PutObjectCommand with the
   * Content-Type locked in and a 5-minute expiry. Returns the upload URL,
   * the key, and the constructed public URL.
   */
  emitirUrlUploadPresignadaItem(input: EmitirUrlUploadItemInput): Promise<UrlUploadPresignada>;

  /**
   * Mint a presigned PUT URL for a CAMPANHA-scoped profile photo upload
   * (aperture-aphk8).
   *
   * SIBLING of `emitirUrlUploadPresignada` but campanha-keyed: the key is
   * `campanha/<idCampanha>/<slot>-<uuid>.<ext>`. Same security invariants:
   * derives the extension from `contentType`, builds a namespaced key
   * (campanha A can never overwrite campanha B's photo), and presigns a
   * PutObjectCommand with the Content-Type locked in and a 5-minute expiry.
   */
  emitirUrlUploadPresignadaCampanha(
    input: EmitirUrlUploadCampanhaInput,
  ): Promise<UrlUploadPresignada>;

  /**
   * Mint a presigned PUT URL for an admin catalogue product image
   * (aperture-d4pmw).
   *
   * The key is generated entirely server-side as
   * `catalogo/produtos/<uuid>.<ext>`. Content-Type and Content-Length are
   * locked into the signature, the body is capped at 5 MiB, and the URL
   * expires after 5 minutes.
   */
  emitirUrlUploadPresignadaCatalogo(
    input: EmitirUrlUploadCatalogoInput,
  ): Promise<UrlUploadPresignada>;

  /**
   * Construct the stable public read URL for a stored object key
   * (`${endpoint}/${bucket}/${objectKey}`). Pure string construction — no
   * network, no signature — valid because the bucket is public-read
   * (operator decision). Used to resolve a profile's stored photo KEYS into
   * displayable URLs in the read DTOs (aperture-lq8vw), so the client never
   * needs the bucket/endpoint config (the same client/infra decoupling the
   * pg-leak in aperture-9abwt taught us).
   */
  urlPublica(objectKey: string): string;

  /**
   * Inverse of `urlPublica` — normalize a value that may be a bare object key
   * OR a resolved public URL (or an accidentally MULTI-prefixed URL) back to
   * the bare key (aperture-qjgfr). Strips the public base
   * (`${endpoint}/${bucket}/` or `memory://${bucket}/`) REPEATEDLY so
   * `base×N/key → key`. A bare key never starts with the base, so stripping
   * is safe + idempotent.
   *
   * The persist path runs every incoming photo "key" through this, making the
   * store self-healing: no matter what the client round-trips (key, URL, or a
   * previously-mangled multi-prefixed URL), exactly one bare key is stored and
   * the DTO resolves it to a single-prefixed URL.
   */
  extrairKey(urlOuKey: string): string;
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

/**
 * Hard upper bound for catalogue product images.
 *
 * Five MiB is deliberately conservative for a web catalogue thumbnail while
 * still allowing high-resolution JPEG/PNG/WebP source images. The value is
 * exported so the tRPC boundary and adapters share one invariant.
 */
export const MAX_CATALOGO_IMAGEM_SIZE_BYTES = 5 * 1024 * 1024;
