import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { criarCampanhaSemRecebedor } from '../../../src/domain/arrecadacao/entities/campanha.js';
import { contribuicaoAtualizada } from '../../../src/domain/arrecadacao/entities/contribuicao.js';
import type {
  IdCampanha,
  IdContribuicao,
  IdOpcaoContribuicao,
  IdPlataforma,
  IdUsuario,
} from '../../../src/domain/arrecadacao/value-objects/ids.js';
import { atualizarContribuicao } from '../../../src/use-cases/arrecadacao/atualizar-contribuicao.js';
import { criarContribuicoesEmLote } from '../../../src/use-cases/arrecadacao/criar-contribuicoes-em-lote.js';
import { createTestObservability } from '../../helpers/observability.js';

/**
 * Plan 0016 Phase 5 — aperture-putz5 / aperture-1l37i ENGINE PIECE.
 *
 * Locks in the single-row + quantidade migration at the saga + use-case
 * boundary:
 *   1. criarContribuicoesEmLote emits ONE row per input item carrying
 *      quantidade=N (NOT N rows with quantidade=1, which was the pre-0016
 *      `qty` row-multiplier shape retired by locked decision #1).
 *   2. The opção cap is on slot count (rows), not unit count.
 *   3. atualizarContribuicao accepts quantidade and threads it to the
 *      entity patch helper; the new value can be lower than already-sold
 *      count per locked decision #10 (overshoot accepted —
 *      quantidadeRestante goes negative; the entity doesn't validate
 *      against the sold count).
 *
 * Adapter behavior (saga writes to memory adapter; postgres
 * conformance is separately tested in tests/integration/).
 */

const { observability } = createTestObservability();

function makeRepos() {
  const campanhaRepository = new CampanhaRepositoryMemory(new RecebedorRepositoryMemory());
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  return { campanhaRepository, contribuicaoRepository };
}

async function seedCampanhaWithOpcao(deps: ReturnType<typeof makeRepos>) {
  const idCampanha = randomUUID() as IdCampanha;
  const idOpcao = randomUUID() as IdOpcaoContribuicao;
  const idAdmin = randomUUID() as IdUsuario;
  const idPlataforma = randomUUID() as IdPlataforma;
  const campanha = criarCampanhaSemRecebedor({
    id: idCampanha,
    idPlataforma,
    titulo: 'Teste',
    idsAdministradores: [idAdmin],
    opcoes: [
      {
        id: idOpcao,
        nome: 'Presentes',
        titulo: 'Sua lista de presentes',
        criadaEm: new Date('2026-06-09T00:00:00Z'),
      },
    ],
    criadaEm: new Date('2026-06-09T00:00:00Z'),
  });
  await deps.campanhaRepository.save(campanha);
  return { idCampanha, idOpcao };
}

describe('criarContribuicoesEmLote — single-row + quantidade (aperture-putz5)', () => {
  it('1 item × quantidade=8 → 1 row persisted with quantidade=8 (NOT 8 rows)', async () => {
    const repos = makeRepos();
    const { idCampanha, idOpcao } = await seedCampanhaWithOpcao(repos);

    const result = await criarContribuicoesEmLote(
      { ...repos, clock: () => new Date('2026-06-09T01:00:00Z'), observability },
      {
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        items: [
          {
            nome: 'Fralda P',
            valor: 5000 as never,
            quantidade: 8,
          },
        ],
      },
    );

    expect(result.ids).toHaveLength(1);
    const created = await repos.contribuicaoRepository.findById(result.ids[0] as IdContribuicao);
    expect(created).toBeDefined();
    expect(created?.quantidade).toBe(8);
    expect(created?.nome).toBe('Fralda P');
  });

  it('3 items each quantidade=1 → 3 rows, each quantidade=1', async () => {
    const repos = makeRepos();
    const { idCampanha, idOpcao } = await seedCampanhaWithOpcao(repos);

    const result = await criarContribuicoesEmLote(
      { ...repos, clock: () => new Date('2026-06-09T01:00:00Z'), observability },
      {
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        items: [
          { nome: 'Mamadeira', valor: 3000 as never, quantidade: 1 },
          { nome: 'Chupeta', valor: 1500 as never, quantidade: 1 },
          { nome: 'Babador', valor: 800 as never, quantidade: 1 },
        ],
      },
    );

    expect(result.ids).toHaveLength(3);
    for (const id of result.ids) {
      const row = await repos.contribuicaoRepository.findById(id as IdContribuicao);
      expect(row?.quantidade).toBe(1);
    }
  });

  it('mixed quantidades — 1 item × q=10 + 1 × q=3 + 1 × q=1 → 3 rows with q=10/3/1', async () => {
    const repos = makeRepos();
    const { idCampanha, idOpcao } = await seedCampanhaWithOpcao(repos);

    const result = await criarContribuicoesEmLote(
      { ...repos, clock: () => new Date('2026-06-09T01:00:00Z'), observability },
      {
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        items: [
          { nome: 'Pacote Fraldas', valor: 8000 as never, quantidade: 10 },
          { nome: 'Babador', valor: 800 as never, quantidade: 3 },
          { nome: 'Mamadeira', valor: 3000 as never, quantidade: 1 },
        ],
      },
    );

    expect(result.ids).toHaveLength(3);
    const rows = await Promise.all(
      result.ids.map((id) => repos.contribuicaoRepository.findById(id as IdContribuicao)),
    );
    const quantidades = rows.map((r) => r?.quantidade).sort((a, b) => (b ?? 0) - (a ?? 0));
    expect(quantidades).toEqual([10, 3, 1]);
  });

  it('quantidade omitted → defaults to 1 (back-compat for preset items with no explicit qty)', async () => {
    const repos = makeRepos();
    const { idCampanha, idOpcao } = await seedCampanhaWithOpcao(repos);

    const result = await criarContribuicoesEmLote(
      { ...repos, clock: () => new Date('2026-06-09T01:00:00Z'), observability },
      {
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        items: [{ nome: 'Pacifier', valor: 2000 as never }],
      },
    );
    const row = await repos.contribuicaoRepository.findById(result.ids[0] as IdContribuicao);
    expect(row?.quantidade).toBe(1);
  });

  it('cap is on slot count, not unit count — 1 item × quantidade=99 fits under the rows cap', async () => {
    const repos = makeRepos();
    const { idCampanha, idOpcao } = await seedCampanhaWithOpcao(repos);

    // Pre-0016 this would have tried to insert 99 rows (qty multiplier);
    // post-0016 it's ONE row regardless of quantidade. The cap check is
    // against the rows count, not the unit sum.
    const result = await criarContribuicoesEmLote(
      { ...repos, clock: () => new Date('2026-06-09T01:00:00Z'), observability },
      {
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        items: [{ nome: 'Pacote Mega', valor: 50000 as never, quantidade: 99 }],
      },
    );
    expect(result.ids).toHaveLength(1);
    const total = await repos.contribuicaoRepository.countByOpcao(idCampanha, idOpcao);
    expect(total).toBe(1);
  });
});

describe('atualizarContribuicao — accepts quantidade (aperture-putz5)', () => {
  it('quantidade can be patched on an existing contribuição', async () => {
    const repos = makeRepos();
    const { idCampanha, idOpcao } = await seedCampanhaWithOpcao(repos);

    const created = await criarContribuicoesEmLote(
      { ...repos, clock: () => new Date('2026-06-09T01:00:00Z'), observability },
      {
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        items: [{ nome: 'Fralda', valor: 3000 as never, quantidade: 5 }],
      },
    );
    const id = created.ids[0] as IdContribuicao;

    const updated = await atualizarContribuicao(
      { contribuicaoRepository: repos.contribuicaoRepository, observability },
      {
        idContribuicao: id,
        idCampanhaEsperada: idCampanha,
        quantidade: 12,
      },
    );

    expect(updated.quantidade).toBe(12);
    expect(updated.nome).toBe('Fralda'); // other fields untouched
    const reloaded = await repos.contribuicaoRepository.findById(id);
    expect(reloaded?.quantidade).toBe(12);
  });

  it('overshoot accepted per locked decision #10 — quantidade lowered below sold count does not throw', async () => {
    // The entity-level invariant (contribuicaoAtualizada) is "quantidade >= 1"
    // only. There is NO check against already-sold quantity at the entity
    // or use-case layer — `quantidadeRestante` goes negative,
    // `esgotada` returns true (verified separately in
    // tests/unit/arrecadacao/quantidade-restante.test.ts). This test pins
    // that the patch path itself doesn't reject.
    const repos = makeRepos();
    const { idCampanha, idOpcao } = await seedCampanhaWithOpcao(repos);

    const created = await criarContribuicoesEmLote(
      { ...repos, clock: () => new Date('2026-06-09T01:00:00Z'), observability },
      {
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        items: [{ nome: 'Fralda', valor: 3000 as never, quantidade: 10 }],
      },
    );
    const id = created.ids[0] as IdContribuicao;

    // Lower from 10 to 2 — admin trimming the slot's offered cap after
    // some units already sold.
    const updated = await atualizarContribuicao(
      { contribuicaoRepository: repos.contribuicaoRepository, observability },
      {
        idContribuicao: id,
        idCampanhaEsperada: idCampanha,
        quantidade: 2,
      },
    );
    expect(updated.quantidade).toBe(2);
  });

  it('quantidade < 1 rejected by the entity patch helper (positive integer floor)', async () => {
    const repos = makeRepos();
    const { idCampanha, idOpcao } = await seedCampanhaWithOpcao(repos);

    const created = await criarContribuicoesEmLote(
      { ...repos, clock: () => new Date('2026-06-09T01:00:00Z'), observability },
      {
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        items: [{ nome: 'Fralda', valor: 3000 as never, quantidade: 5 }],
      },
    );
    const id = created.ids[0] as IdContribuicao;
    const existing = await repos.contribuicaoRepository.findById(id);
    if (!existing) throw new Error('seed broken');

    // Use the entity helper directly — the use-case rejects at the schema
    // layer before even reaching the entity (z.number().int().min(1)),
    // but the entity has its own runtime guard as defense in depth.
    expect(() => contribuicaoAtualizada(existing, { quantidade: 0 })).toThrow(/positivo/i);
  });
});
