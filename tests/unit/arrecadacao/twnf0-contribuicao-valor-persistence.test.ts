/**
 * aperture-twnf0 — data-correctness for the creator add-mimo / edit-mimo
 * flows at the DOMAIN + REPOSITORY layer.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The e2e specs for these flows assert the WRONG layer:
 *   - e2e/painel-adicionar-qty.spec.ts fills price "50,00" but only asserts
 *     "exactly ONE contribuicao row with quantidade=N" — it NEVER reads the
 *     persisted `valor` back, so a reais/cents conversion bug ships green.
 *   - e2e/painel-editar-mimo.spec.ts asserts tRPC call-SHAPE (update fired
 *     once / delete zero times) — it never asserts the persisted row equals
 *     the NEW name/price/qty the operator typed.
 *
 * These tests close that hole against the REAL use-cases + REAL repository
 * (read-back via `findById`, not the use-case's return value — a use-case
 * could return the right object yet persist the wrong one). The frontend
 * reais→cents PARSER that feeds these use-cases is tested separately in
 * tests/unit/server/twnf0-contribuicao-valor-parser.test.ts (it has a real
 * bug — see that file).
 *
 * The valor unit is CENTS end-to-end (MoneyCentsSchema). R$50,00 == 5000.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import type { DadosRecebedor } from '../../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { atualizarContribuicao } from '../../../src/use-cases/arrecadacao/atualizar-contribuicao.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { createArrecadacaoMemoryRepos } from '../../helpers/arrecadacao-repos.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const dadosRecebedorPadrao = (): DadosRecebedor => ({
  metodo: 'pix',
  nomeTitular: 'Maria Silva',
  cpfTitular: '52998224725',
  tipoChavePix: 'email',
  chavePix: 'maria@exemplo.com',
});

/**
 * Build a persisted campanha with a single `presente` opção plus a fresh
 * ContribuicaoRepositoryMemory — the minimal world a slot needs to exist in.
 * Returns the ids + repos so each test can create/patch and read back.
 */
async function buildCampanhaComOpcao() {
  const { campanhaRepository, recebedorRepository, plataformaRepository } =
    createArrecadacaoMemoryRepos();
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const idCampanha = randomUUID();
  const idOpcao = randomUUID();

  await criarCampanha(
    {
      campanhaRepository,
      recebedorRepository,
      plataformaRepository,
      clock,
      observability: silentObservability,
    },
    {
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [randomUUID()],
      dadosRecebedor: dadosRecebedorPadrao(),
      titulo: 'Lista da Helena',
    },
  );
  await adicionarOpcaoContribuicao(
    { campanhaRepository, observability: silentObservability },
    { idCampanha, idOpcao, tipo: 'presente' },
  );

  return { campanhaRepository, contribuicaoRepository, idCampanha, idOpcao };
}

describe('aperture-twnf0 — add-mimo: valor persists as cents (read-back)', () => {
  it('a slot created with valor 5000 (R$50,00) persists valor === 5000', async () => {
    const { campanhaRepository, contribuicaoRepository, idCampanha, idOpcao } =
      await buildCampanhaComOpcao();
    const idContribuicao = randomUUID();

    await criarContribuicao(
      { campanhaRepository, contribuicaoRepository, clock, observability: silentObservability },
      {
        id: idContribuicao,
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        nome: 'Cadeirinha',
        valor: 5000,
        quantidade: 3,
      },
    );

    // READ-BACK from the repository — NOT the use-case return value.
    const persisted = await contribuicaoRepository.findById(idContribuicao);
    expect(persisted, 'slot must exist after create').not.toBeNull();
    expect(persisted?.valor, 'R$50,00 persists as 5000 cents').toBe(5000);
    expect(persisted?.nome).toBe('Cadeirinha');
    expect(persisted?.quantidade).toBe(3);
  });

  it('preserves exact cents for a fractional price (R$19,99 → 1999)', async () => {
    const { campanhaRepository, contribuicaoRepository, idCampanha, idOpcao } =
      await buildCampanhaComOpcao();
    const idContribuicao = randomUUID();

    await criarContribuicao(
      { campanhaRepository, contribuicaoRepository, clock, observability: silentObservability },
      { id: idContribuicao, idCampanha, idOpcaoContribuicao: idOpcao, nome: 'Fralda', valor: 1999 },
    );

    const persisted = await contribuicaoRepository.findById(idContribuicao);
    expect(persisted?.valor).toBe(1999);
  });
});

describe('aperture-twnf0 — edit-mimo: the NEW name/price/qty is what persists (read-back)', () => {
  async function seedSlot() {
    const world = await buildCampanhaComOpcao();
    const idContribuicao = randomUUID();
    await criarContribuicao(
      {
        campanhaRepository: world.campanhaRepository,
        contribuicaoRepository: world.contribuicaoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idContribuicao,
        idCampanha: world.idCampanha,
        idOpcaoContribuicao: world.idOpcao,
        nome: 'Fralda',
        valor: 5000,
        quantidade: 1,
      },
    );
    return { ...world, idContribuicao };
  }

  it('editing name + price + qty persists ALL new values (not just "an update fired")', async () => {
    const { contribuicaoRepository, idCampanha, idContribuicao } = await seedSlot();

    await atualizarContribuicao(
      { contribuicaoRepository, observability: silentObservability },
      {
        idContribuicao,
        idCampanhaEsperada: idCampanha,
        nome: 'Fralda Premium',
        valor: 7500,
        quantidade: 4,
      },
    );

    const persisted = await contribuicaoRepository.findById(idContribuicao);
    expect(persisted?.nome, 'new name persists').toBe('Fralda Premium');
    expect(persisted?.valor, 'R$75,00 persists as 7500 cents — NOT the old 5000').toBe(7500);
    expect(persisted?.quantidade, 'new qty persists').toBe(4);
  });

  it('editing price only leaves name + qty untouched (patch semantics, read-back)', async () => {
    const { contribuicaoRepository, idCampanha, idContribuicao } = await seedSlot();

    await atualizarContribuicao(
      { contribuicaoRepository, observability: silentObservability },
      { idContribuicao, idCampanhaEsperada: idCampanha, valor: 12345 },
    );

    const persisted = await contribuicaoRepository.findById(idContribuicao);
    expect(persisted?.valor).toBe(12345);
    expect(persisted?.nome, 'untouched fields survive the patch').toBe('Fralda');
    expect(persisted?.quantidade).toBe(1);
  });
});
