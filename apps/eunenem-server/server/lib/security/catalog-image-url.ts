import type { ObjectStorage } from "../../../../../src/adapters/storage/object-storage.js";

const CATALOG_OBJECT_KEY =
  /^catalogo\/produtos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;

const ROOT_RELATIVE_PREFIXES = [
  "/products/",
  "/listas-prontas/",
  "/catalogo/produtos/",
] as const;

const LEGACY_PRODUCT_HOSTS = new Set([
  "http2.mlstatic.com",
  "rihappy.vteximg.com.br",
]);

function isSafeRootRelative(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return false;
  }

  // Inspect the caller's original path before URL parsing. WHATWG normalizes
  // literal dot segments (`/products/a/../b.jpg`) while constructing URL,
  // which would otherwise erase the evidence before the policy sees it.
  let decodedValue: string;
  try {
    decodedValue = decodeURIComponent(value);
  } catch {
    return false;
  }
  const decodedPathBeforeNormalization = decodedValue.split(/[?#]/, 1)[0] ?? "";
  if (
    decodedValue !== value ||
    decodedPathBeforeNormalization.includes("\\") ||
    decodedPathBeforeNormalization
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value, "https://catalogo.eunenem.invalid");
  } catch {
    return false;
  }

  if (url.origin !== "https://catalogo.eunenem.invalid") return false;
  if (url.hash !== "" || url.search !== "") return false;
  if (!ROOT_RELATIVE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    return false;
  }

  return true;
}

function isManagedCatalogUrl(
  value: string,
  objectStorage: ObjectStorage,
): boolean {
  const objectKey = objectStorage.extrairKey(value);
  return (
    objectKey !== value &&
    CATALOG_OBJECT_KEY.test(objectKey) &&
    objectStorage.urlPublica(objectKey) === value
  );
}

function isGrandfatheredLegacyProductUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !LEGACY_PRODUCT_HOSTS.has(url.hostname)
  ) {
    return false;
  }

  if (url.hostname === "http2.mlstatic.com") {
    return url.search === "";
  }

  // The immutable migration-045 snapshot contains only the vendor's `v`
  // cache-version key. Do not turn grandfathering into a generic query-string
  // tracking channel.
  const queryEntries = [...url.searchParams.entries()];
  const versionEntry = queryEntries[0];
  return (
    queryEntries.length === 1 &&
    versionEntry?.[0] === "v" &&
    /^\d+$/.test(versionEntry[1])
  );
}

/**
 * Mutation policy: new admin writes may reference only catalog-owned
 * root-relative namespaces or the exact configured object-storage public
 * base. Arbitrary remote HTTPS images are rejected even though the backfill
 * still contains two legacy vendor hosts.
 */
export function isCatalogImageUrlWritable(
  value: string,
  objectStorage: ObjectStorage,
): boolean {
  if (value.length < 1 || value.length > 2_048) return false;
  return (
    isSafeRootRelative(value) || isManagedCatalogUrl(value, objectStorage)
  );
}

/**
 * Read policy: permit the mutation-safe set plus the two exact hosts already
 * present in migration 045. This keeps all 501 backfilled products renderable
 * without allowing admins or direct DB corruption to introduce a new tracking
 * origin.
 */
export function isCatalogImageUrlReadable(
  value: string,
  objectStorage: ObjectStorage,
): boolean {
  if (value.length < 1 || value.length > 2_048) return false;
  return (
    isCatalogImageUrlWritable(value, objectStorage) ||
    isGrandfatheredLegacyProductUrl(value)
  );
}
