import { describe, expect, it } from 'vitest';
import { ObjectStorageMinio } from '../../../src/adapters/storage/object-storage.minio.js';

const createStorage = () =>
  new ObjectStorageMinio({
    endpoint: 'https://minio.example',
    region: 'us-east-1',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    bucket: 'test-bucket',
  });

describe('ObjectStorageMinio catalogue presign', () => {
  it('real-presigns MIME and exact length with a 300-second catalogue PUT', async () => {
    const storage = createStorage();

    const result = await storage.emitirUrlUploadPresignadaCatalogo({
      contentType: 'image/png',
      sizeBytes: 4_096,
    });

    expect(result.objectKey).toMatch(/^catalogo\/produtos\/[0-9a-f-]+\.png$/);
    expect(result.publicUrl).toBe(`https://minio.example/test-bucket/${result.objectKey}`);

    // This intentionally exercises @aws-sdk/s3-request-presigner itself.
    // A mocked getSignedUrl cannot prove which headers SDK 3.1075 actually
    // includes in the SigV4 canonical request.
    const uploadUrl = new URL(result.uploadUrl);
    expect(uploadUrl.origin).toBe('https://minio.example');
    expect(decodeURIComponent(uploadUrl.pathname)).toBe(`/test-bucket/${result.objectKey}`);
    expect(uploadUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(uploadUrl.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(uploadUrl.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );
    expect(uploadUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unsupported MIME types before signing', async () => {
    const storage = createStorage();

    await expect(
      storage.emitirUrlUploadPresignadaCatalogo({
        contentType: 'image/gif',
        sizeBytes: 1_024,
      }),
    ).rejects.toThrow(/não suportado/);
  });

  it.each([
    0,
    5 * 1024 * 1024 + 1,
    1.5,
    Number.NaN,
  ])('rejects invalid sizeBytes %s before signing', async (sizeBytes) => {
    const storage = createStorage();

    await expect(
      storage.emitirUrlUploadPresignadaCatalogo({
        contentType: 'image/webp',
        sizeBytes,
      }),
    ).rejects.toThrow(/sizeBytes/);
  });
});
