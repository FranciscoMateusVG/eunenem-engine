import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ObjectStorageMemory } from '../../../src/adapters/storage/object-storage.memory.js';

describe('ObjectStorageMemory', () => {
  const idUsuario = randomUUID();

  it('returns a deterministic shape and a namespaced key', async () => {
    const storage = new ObjectStorageMemory('test-bucket');
    const result = await storage.emitirUrlUploadPresignada({
      idUsuario,
      slot: 'historia',
      contentType: 'image/webp',
    });

    expect(result.objectKey).toMatch(
      new RegExp(`^perfis/${idUsuario}/historia-[0-9a-f-]+\\.webp$`),
    );
    expect(result.uploadUrl).toBe(`memory://upload/test-bucket/${result.objectKey}`);
    expect(result.publicUrl).toBe(`memory://test-bucket/${result.objectKey}`);
  });

  it('records each call in the public uploads array', async () => {
    const storage = new ObjectStorageMemory();
    await storage.emitirUrlUploadPresignada({
      idUsuario,
      slot: 'perfil',
      contentType: 'image/jpeg',
    });
    await storage.emitirUrlUploadPresignada({ idUsuario, slot: 'capa', contentType: 'image/png' });

    expect(storage.uploads).toHaveLength(2);
    expect(storage.uploads[0].input.slot).toBe('perfil');
    expect(storage.uploads[0].resultado.objectKey).toContain(`perfis/${idUsuario}/perfil-`);
    expect(storage.uploads[1].input.contentType).toBe('image/png');
  });

  it('derives jpg from image/jpeg', async () => {
    const storage = new ObjectStorageMemory();
    const result = await storage.emitirUrlUploadPresignada({
      idUsuario,
      slot: 'perfil',
      contentType: 'image/jpeg',
    });
    expect(result.objectKey.endsWith('.jpg')).toBe(true);
  });

  it('throws on an unsupported content-type (defense in depth)', async () => {
    const storage = new ObjectStorageMemory();
    await expect(
      storage.emitirUrlUploadPresignada({
        idUsuario,
        slot: 'perfil',
        // biome-ignore lint/suspicious/noExplicitAny: testing adapter-level guard
        contentType: 'application/pdf' as any,
      }),
    ).rejects.toThrow(/não suportado/);
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ])('mints a server-generated catalogue key for %s', async (contentType, extension) => {
    const storage = new ObjectStorageMemory('test-bucket');

    const result = await storage.emitirUrlUploadPresignadaCatalogo({
      contentType,
      sizeBytes: 1_024,
    });

    expect(result.objectKey).toMatch(new RegExp(`^catalogo/produtos/[0-9a-f-]+\\.${extension}$`));
    expect(result.uploadUrl).toBe(`memory://upload/test-bucket/${result.objectKey}`);
    expect(result.publicUrl).toBe(`/${result.objectKey}`);
    expect(storage.catalogoUploads).toEqual([
      { input: { contentType, sizeBytes: 1_024 }, resultado: result },
    ]);
  });

  it('rejects an unsupported catalogue content-type without recording an upload', async () => {
    const storage = new ObjectStorageMemory();

    await expect(
      storage.emitirUrlUploadPresignadaCatalogo({
        contentType: 'image/gif',
        sizeBytes: 1_024,
      }),
    ).rejects.toThrow(/não suportado/);
    expect(storage.catalogoUploads).toHaveLength(0);
  });

  it.each([
    0,
    5 * 1024 * 1024 + 1,
    1.5,
    Number.NaN,
  ])('rejects invalid catalogue sizeBytes %s without recording an upload', async (sizeBytes) => {
    const storage = new ObjectStorageMemory();

    await expect(
      storage.emitirUrlUploadPresignadaCatalogo({
        contentType: 'image/png',
        sizeBytes,
      }),
    ).rejects.toThrow(/sizeBytes/);
    expect(storage.catalogoUploads).toHaveLength(0);
  });
});
