import { readFileSync, statSync } from 'node:fs';
import { browserErrorRuntimeConfigFromEnv } from '../pages/lib/browser-error-contract.js';

const RELEASE_METADATA_URL = new URL('../public/browser-error-release.json', import.meta.url);
const RELEASE_PATTERN = /^artifact-sha256:[0-9a-f]{64}$/;

export function readBrowserArtifactRelease(
  metadataUrl: URL = RELEASE_METADATA_URL,
): string | undefined {
  try {
    const metadata = statSync(metadataUrl);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 160) return undefined;
    const serialized = readFileSync(metadataUrl, 'utf8');
    if (Buffer.byteLength(serialized, 'utf8') !== metadata.size) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !('release' in parsed) ||
      typeof parsed.release !== 'string' ||
      !RELEASE_PATTERN.test(parsed.release)
    ) {
      return undefined;
    }
    return parsed.release;
  } catch {
    return undefined;
  }
}

export function browserArtifactAssetUrl(
  pathname: string,
  browserArtifactRelease: string | undefined,
): string {
  if (!browserArtifactRelease) return pathname;
  return `${pathname}?v=${encodeURIComponent(browserArtifactRelease)}`;
}

export function serializeClientRuntimeEnv(
  source: Readonly<Record<string, string | undefined>>,
  browserArtifactRelease: string | undefined,
): string {
  const env: {
    browserErrorDsn?: string;
    legacyMigracaoUrl?: string;
    legacySiteOrigin?: string;
    mixpanelToken?: string;
    release?: string;
  } = {};
  const browserErrors = browserErrorRuntimeConfigFromEnv({
    browserDsn: source.GLITCHTIP_BROWSER_DSN,
    release: browserArtifactRelease,
    serverDsn: source.GLITCHTIP_DSN,
  });
  if (browserErrors.browserErrorDsn && browserErrors.release) {
    env.browserErrorDsn = browserErrors.browserErrorDsn;
    env.release = browserErrors.release;
  }
  if (source.LEGACY_MIGRACAO_URL) env.legacyMigracaoUrl = source.LEGACY_MIGRACAO_URL;
  if (source.LEGACY_SITE_ORIGIN) env.legacySiteOrigin = source.LEGACY_SITE_ORIGIN;
  if (source.MIXPANEL_TOKEN) env.mixpanelToken = source.MIXPANEL_TOKEN;
  return JSON.stringify(env).replaceAll('<', '\\u003c');
}

export function clientRuntimeEnvScript(
  source: Readonly<Record<string, string | undefined>>,
  browserArtifactRelease: string | undefined,
): string {
  return `<script>window.__EUNENEM_ENV__=${serializeClientRuntimeEnv(source, browserArtifactRelease)}</script>`;
}
