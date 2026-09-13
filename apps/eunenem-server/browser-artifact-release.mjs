import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DOMAIN = Buffer.from('eunenem-browser-artifact-v1\0', 'utf8');
const RELEASE_FILE = 'browser-error-release.json';
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

function lengthPrefix(length) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
}

export function computeBrowserArtifactRelease({ client, styles }) {
  const hash = createHash('sha256');
  hash.update(DOMAIN);
  for (const [name, content] of [
    ['public/client.js', client],
    ['public/styles.css', styles],
  ]) {
    const nameBytes = Buffer.from(name, 'utf8');
    hash.update(lengthPrefix(nameBytes.length));
    hash.update(nameBytes);
    hash.update(lengthPrefix(content.length));
    hash.update(content);
  }
  return `artifact-sha256:${hash.digest('hex')}`;
}

export async function writeBrowserArtifactRelease(appRoot = process.cwd()) {
  const publicDir = join(appRoot, 'public');
  const paths = [join(publicDir, 'client.js'), join(publicDir, 'styles.css')];
  const metadata = await Promise.all(paths.map((path) => stat(path)));
  if (metadata.some((entry) => !entry.isFile() || entry.size < 1 || entry.size > MAX_ASSET_BYTES)) {
    throw new Error('browser artifact asset unavailable');
  }
  const [client, styles] = await Promise.all(paths.map((path) => readFile(path)));
  if (
    !client ||
    !styles ||
    client.length !== metadata[0].size ||
    styles.length !== metadata[1].size
  ) {
    throw new Error('browser artifact changed during release calculation');
  }
  const release = computeBrowserArtifactRelease({ client, styles });
  const output = join(publicDir, RELEASE_FILE);
  const temporary = `${output}.tmp`;
  await mkdir(publicDir, { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ release })}\n`, { mode: 0o644 });
  await rename(temporary, output);
  return release;
}
