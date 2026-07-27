import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectStorageMinio } from '../../../src/adapters/storage/object-storage.minio.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

const getSignedUrlMock = vi.mocked(getSignedUrl);

describe('ObjectStorageMinio catalogue presign', () => {
  beforeEach(() => {
    getSignedUrlMock.mockReset();
    getSignedUrlMock.mockResolvedValue('https://minio.example/upload-signed');
  });

  it('locks ContentType, uses a server-generated catalogue key, and expires in 300 seconds', async () => {
    const storage = new ObjectStorageMinio({
      endpoint: 'https://minio.example',
      region: 'us-east-1',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      bucket: 'test-bucket',
    });

    const result = await storage.emitirUrlUploadPresignadaCatalogo({
      contentType: 'image/png',
    });

    expect(result.objectKey).toMatch(/^catalogo\/produtos\/[0-9a-f-]+\.png$/);
    expect(result).toEqual({
      uploadUrl: 'https://minio.example/upload-signed',
      objectKey: result.objectKey,
      publicUrl: `https://minio.example/test-bucket/${result.objectKey}`,
    });

    expect(getSignedUrlMock).toHaveBeenCalledOnce();
    const [, command, options] = getSignedUrlMock.mock.calls[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toEqual({
      Bucket: 'test-bucket',
      Key: result.objectKey,
      ContentType: 'image/png',
    });
    expect(options).toEqual({ expiresIn: 300 });
  });

  it('rejects unsupported MIME types before asking MinIO to sign', async () => {
    const storage = new ObjectStorageMinio({
      endpoint: 'https://minio.example',
      region: 'us-east-1',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      bucket: 'test-bucket',
    });

    await expect(
      storage.emitirUrlUploadPresignadaCatalogo({ contentType: 'image/gif' }),
    ).rejects.toThrow(/não suportado/);
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });
});
