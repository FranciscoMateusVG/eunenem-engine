/**
 * JSON-safe metadata accepted by the catalogue admin audit boundary.
 *
 * Dates, bigint, functions and undefined are deliberately excluded. Callers
 * must also bound metadata keys/string lengths before append; the adapter is
 * a persistence boundary, not a request-validation boundary.
 */
export type CatalogoAuditJsonPrimitive = boolean | number | string | null;
export type CatalogoAuditJsonValue =
  | CatalogoAuditJsonPrimitive
  | readonly CatalogoAuditJsonValue[]
  | CatalogoAuditJsonObject;
export interface CatalogoAuditJsonObject {
  readonly [key: string]: CatalogoAuditJsonValue;
}

/** Caller-side limits; adapters persist already-validated audit envelopes. */
export const CATALOGO_AUDIT_ACTION_MAX_LENGTH = 100;
export const CATALOGO_AUDIT_TARGET_TYPE_MAX_LENGTH = 64;
export const CATALOGO_AUDIT_TARGET_ID_MAX_LENGTH = 200;
export const CATALOGO_AUDIT_METADATA_MAX_JSON_BYTES = 4 * 1024;

export type CatalogoAdminAuditPhase = 'requested' | 'succeeded' | 'failed';

export interface AppendCatalogoAdminAuditEventInput {
  /** Correlates requested + terminal events for one mutation invocation. */
  readonly requestId: string;
  /** Authenticated engine usuario id, resolved server-side. */
  readonly actorUsuarioId: string;
  /** Stable action taxonomy, bounded by the caller. */
  readonly action: string;
  readonly phase: CatalogoAdminAuditPhase;
  /** Optional affected resource kind, bounded by the caller. */
  readonly targetType: string | null;
  /** Optional affected resource identifier, bounded by the caller. */
  readonly targetId: string | null;
  /** PII-safe, JSON-only context. Keys and string values are caller-bounded. */
  readonly metadata: CatalogoAuditJsonObject;
}

export interface CatalogoAdminAuditEvent extends AppendCatalogoAdminAuditEventInput {
  readonly id: string;
  readonly occurredAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate at the port boundary rather than trusting every future caller to
 * remember the storage limits. Audit data is security evidence; malformed or
 * unbounded envelopes fail before persistence.
 */
export function assertValidCatalogoAdminAuditEvent(
  input: AppendCatalogoAdminAuditEventInput,
): void {
  if (!UUID.test(input.requestId) || !UUID.test(input.actorUsuarioId)) {
    throw new Error('catalog audit requestId and actorUsuarioId must be UUIDs');
  }
  if (input.action.length < 1 || input.action.length > CATALOGO_AUDIT_ACTION_MAX_LENGTH) {
    throw new Error('catalog audit action length is invalid');
  }
  if (
    input.targetType !== null &&
    (input.targetType.length < 1 || input.targetType.length > CATALOGO_AUDIT_TARGET_TYPE_MAX_LENGTH)
  ) {
    throw new Error('catalog audit targetType length is invalid');
  }
  if (
    input.targetId !== null &&
    (input.targetId.length < 1 || input.targetId.length > CATALOGO_AUDIT_TARGET_ID_MAX_LENGTH)
  ) {
    throw new Error('catalog audit targetId length is invalid');
  }

  const serializedMetadata = JSON.stringify(input.metadata);
  if (
    serializedMetadata === undefined ||
    Buffer.byteLength(serializedMetadata, 'utf8') > CATALOGO_AUDIT_METADATA_MAX_JSON_BYTES
  ) {
    throw new Error('catalog audit metadata exceeds its JSON byte limit');
  }
}

/**
 * Append-only audit sink for catalogue admin mutations and upload presigns.
 *
 * There is intentionally no update/delete method. Postgres additionally
 * rejects direct UPDATE/DELETE through migration-level triggers.
 */
export interface CatalogoAdminAudit {
  append(input: AppendCatalogoAdminAuditEventInput): Promise<void>;
}
