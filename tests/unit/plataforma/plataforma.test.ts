import { describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
  PLATAFORMAS_SEED,
  PlataformaRepositoryMemory,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { criarPlataforma } from '../../../src/domain/plataforma/entities/plataforma.js';
import { IdPlataformaSchema } from '../../../src/domain/plataforma/value-objects/ids.js';
import {
  type SlugPlataforma,
  SlugPlataformaSchema,
} from '../../../src/domain/plataforma/value-objects/slug-plataforma.js';

describe('IdPlataformaSchema', () => {
  it('accepts a valid UUID', () => {
    expect(IdPlataformaSchema.safeParse(ID_PLATAFORMA_EUNENEM).success).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    expect(IdPlataformaSchema.safeParse('eunenem').success).toBe(false);
  });
});

describe('SlugPlataformaSchema', () => {
  it.each(['eunenem', 'eucasei', 'eu-nenem', 'plataforma-123'])('accepts %s', (slug) => {
    expect(SlugPlataformaSchema.safeParse(slug).success).toBe(true);
  });

  it.each([
    ['EuNenem', 'uppercase'],
    ['eu', 'too short'],
    ['1eunenem', 'starts with digit'],
    ['eu_nenem', 'contains underscore'],
    ['eu nenem', 'contains space'],
    ['', 'empty'],
  ])('rejects %s (%s)', (slug) => {
    expect(SlugPlataformaSchema.safeParse(slug).success).toBe(false);
  });
});

describe('criarPlataforma', () => {
  it('builds an immutable Plataforma from the input', () => {
    const criadaEm = new Date('2026-05-24T10:00:00.000Z');
    const p = criarPlataforma({
      id: ID_PLATAFORMA_EUNENEM,
      slug: 'eunenem' as SlugPlataforma,
      nome: 'EuNenem',
      criadaEm,
    });
    expect(p).toEqual({
      id: ID_PLATAFORMA_EUNENEM,
      slug: 'eunenem',
      nome: 'EuNenem',
      criadaEm,
    });
  });
});

describe('PLATAFORMAS_SEED', () => {
  it('contains eunenem and eucasei with their canonical ids', () => {
    expect(PLATAFORMAS_SEED.map((p) => p.id)).toEqual([
      ID_PLATAFORMA_EUNENEM,
      ID_PLATAFORMA_EUCASEI,
    ]);
  });

  it('uses valid slugs and ids per the schemas', () => {
    for (const p of PLATAFORMAS_SEED) {
      expect(IdPlataformaSchema.safeParse(p.id).success).toBe(true);
      expect(SlugPlataformaSchema.safeParse(p.slug).success).toBe(true);
    }
  });
});

describe('PlataformaRepositoryMemory', () => {
  it('findById returns the seeded eunenem plataforma', async () => {
    const repo = new PlataformaRepositoryMemory();
    const p = await repo.findById(ID_PLATAFORMA_EUNENEM);
    expect(p?.slug).toBe('eunenem');
    expect(p?.nome).toBe('EuNenem');
  });

  it('findById returns the seeded eucasei plataforma', async () => {
    const repo = new PlataformaRepositoryMemory();
    const p = await repo.findById(ID_PLATAFORMA_EUCASEI);
    expect(p?.slug).toBe('eucasei');
    expect(p?.nome).toBe('EuCasei');
  });

  it('findById returns undefined for an unknown id', async () => {
    const repo = new PlataformaRepositoryMemory();
    const p = await repo.findById('99999999-9999-4999-8999-999999999999');
    expect(p).toBeUndefined();
  });

  it('findBySlug returns the plataforma matching the slug', async () => {
    const repo = new PlataformaRepositoryMemory();
    const p = await repo.findBySlug('eucasei' as SlugPlataforma);
    expect(p?.id).toBe(ID_PLATAFORMA_EUCASEI);
  });

  it('findBySlug returns undefined for an unknown slug', async () => {
    const repo = new PlataformaRepositoryMemory();
    const p = await repo.findBySlug('inexistente' as SlugPlataforma);
    expect(p).toBeUndefined();
  });

  it('listAtivas returns both seeded plataformas', async () => {
    const repo = new PlataformaRepositoryMemory();
    const list = await repo.listAtivas();
    expect(list.map((p) => p.slug).sort()).toEqual(['eucasei', 'eunenem']);
  });

  it('respects a custom seed when provided', async () => {
    const customSeed = [
      criarPlataforma({
        id: '33333333-3333-4333-8333-333333333333',
        slug: 'custom' as SlugPlataforma,
        nome: 'Custom',
        criadaEm: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ];
    const repo = new PlataformaRepositoryMemory(customSeed);
    const list = await repo.listAtivas();
    expect(list).toHaveLength(1);
    expect(list[0]?.slug).toBe('custom');
  });
});
