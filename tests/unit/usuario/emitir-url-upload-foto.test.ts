import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectStorageMemory } from '../../../src/adapters/storage/object-storage.memory.js';
import { UsuarioInputInvalidoError } from '../../../src/errors/usuario/input-invalido.error.js';
import { emitirUrlUploadFoto } from '../../../src/use-cases/usuario/emitir-url-upload-foto.js';
import { createTestObservability } from '../../helpers/observability.js';

const testObs = createTestObservability();
const observability = testObs.observability;

afterAll(async () => {
  await testObs.shutdown();
});

describe('emitirUrlUploadFoto', () => {
  let storage: ObjectStorageMemory;
  const idUsuario = randomUUID();

  beforeEach(() => {
    storage = new ObjectStorageMemory();
    testObs.reset();
  });

  it.each([
    'image/jpeg',
    'image/png',
    'image/webp',
  ])('accepts the image content-type %s and returns a namespaced key', async (contentType) => {
    const result = await emitirUrlUploadFoto({ objectStorage: storage, observability }, idUsuario, {
      slot: 'perfil',
      contentType,
    });

    expect(result.objectKey).toMatch(
      new RegExp(`^perfis/${idUsuario}/perfil-[0-9a-f-]+\\.(jpg|png|webp)$`),
    );
    expect(result.uploadUrl).toBeTruthy();
    expect(result.publicUrl).toContain(result.objectKey);
    // The fake recorded the call with the content-type intact.
    expect(storage.uploads).toHaveLength(1);
    expect(storage.uploads[0].input.contentType).toBe(contentType);
  });

  it('namespaces the key by idUsuario AND slot', async () => {
    const result = await emitirUrlUploadFoto({ objectStorage: storage, observability }, idUsuario, {
      slot: 'capa',
      contentType: 'image/png',
    });
    expect(result.objectKey.startsWith(`perfis/${idUsuario}/capa-`)).toBe(true);
    expect(result.objectKey.endsWith('.png')).toBe(true);
  });

  it('rejects a non-image content-type with UsuarioInputInvalidoError', async () => {
    await expect(
      emitirUrlUploadFoto({ objectStorage: storage, observability }, idUsuario, {
        slot: 'perfil',
        // biome-ignore lint/suspicious/noExplicitAny: deliberately testing a rejected type
        contentType: 'application/pdf' as any,
      }),
    ).rejects.toBeInstanceOf(UsuarioInputInvalidoError);
    // No presign minted for a rejected type.
    expect(storage.uploads).toHaveLength(0);
  });

  it('rejects a malformed idUsuario with UsuarioInputInvalidoError', async () => {
    await expect(
      emitirUrlUploadFoto({ objectStorage: storage, observability }, 'not-a-uuid', {
        slot: 'perfil',
        contentType: 'image/jpeg',
      }),
    ).rejects.toBeInstanceOf(UsuarioInputInvalidoError);
    expect(storage.uploads).toHaveLength(0);
  });
});
