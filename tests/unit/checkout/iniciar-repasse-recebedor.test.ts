import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/financeiro/livro-repository.memory.js';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { desativarRecebedor } from '../../../src/domain/arrecadacao/entities/recebedor.js';
import type { LancamentoFinanceiro } from '../../../src/domain/financeiro/entities/lancamento-financeiro.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../../src/errors/arrecadacao/campanha-nao-encontrada.error.js';
import { CheckoutCampanhaSemRecebedorError } from '../../../src/errors/checkout/campanha-sem-recebedor.error.js';
import { CheckoutPlataformaMismatchError } from '../../../src/errors/checkout/plataforma-mismatch.error.js';
import { FinanceiroSaldoDisponivelInsuficienteError } from '../../../src/errors/financeiro/saldo-disponivel-insuficiente.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { iniciarRepasseRecebedor } from '../../../src/use-cases/checkout/iniciar-repasse-recebedor.js';
import { createArrecadacaoMemoryRepos } from '../../helpers/arrecadacao-repos.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const dadosRecebedorPadrao = () => ({
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
});

/**
 * Set up a campanha with an active recebedor and a SINGLE seeded
 * `disponivel`-status lancamento in the livro (saldo = `disponivelAmountCents`).
 * Skips the full Phase 2 + Phase 3 flow because those produce
 * `pendente`-status lancamentos (which don't count toward `saldoDisponivel`).
 *
 * This orchestrator's contract is about cross-BC pre-validations + delegation,
 * not the saldo-maturation pipeline (which doesn't exist in this engine yet).
 */
async function setupCampanhaComSaldoDisponivel(
  idPlataforma: string,
  disponivelAmountCents: number,
) {
  const repos = createArrecadacaoMemoryRepos();
  const { campanhaRepository, recebedorRepository, plataformaRepository } = repos;
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

  const idCampanha = randomUUID();
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
      idPlataforma,
      idsAdministradores: [randomUUID()],
      dadosRecebedor: dadosRecebedorPadrao(),
      titulo: 'Campanha Repasse',
    },
  );

  if (disponivelAmountCents > 0) {
    // Plan 0015 (aperture-ucgok): lancamento has no FSM anymore. The
    // "disponivel" (transferred) state is `transferidoEm !== null AND
    // canceladoEm === null` — see `calcularSaldoRecebedor`. Stamp
    // transferidoEm here so the seeded row counts toward
    // `valorDisponivelCents`.
    const lancamento: LancamentoFinanceiro = {
      id: randomUUID(),
      idPagamento: randomUUID(),
      idContribuicao: randomUUID(),
      idCampanha,
      tipo: 'credito_saldo_recebedor',
      amountCents: disponivelAmountCents,
      criadoEm: fixedDate,
      transferidoEm: fixedDate,
      canceladoEm: null,
    };
    await livroFinanceiroRepository.saveLancamentos([lancamento]);
  }

  return {
    deps: {
      campanhaRepository,
      recebedorRepository,
      livroFinanceiroRepository,
      clock,
      observability: silentObservability,
    },
    idCampanha,
  };
}

describe('iniciarRepasseRecebedor — happy path', () => {
  it('creates a repasse solicitado for a campanha with sufficient saldo disponível', async () => {
    const { deps, idCampanha } = await setupCampanhaComSaldoDisponivel(ID_PLATAFORMA_EUNENEM, 8000);
    const idRepasse = randomUUID();

    const repasse = await iniciarRepasseRecebedor(deps, {
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idCampanha,
      idRepasse,
      amountCents: 8000,
    });

    expect(repasse.id).toBe(idRepasse);
    expect(repasse.idCampanha).toBe(idCampanha);
    expect(repasse.amountCents).toBe(8000);
    expect(repasse.status).toBe('solicitado');
  });

  it('persists the repasse in the livro so it is retrievable by id', async () => {
    const { deps, idCampanha } = await setupCampanhaComSaldoDisponivel(ID_PLATAFORMA_EUNENEM, 5000);
    const idRepasse = randomUUID();

    await iniciarRepasseRecebedor(deps, {
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idCampanha,
      idRepasse,
      amountCents: 5000,
    });

    const persisted = await deps.livroFinanceiroRepository.findRepasseById(idRepasse);
    expect(persisted?.id).toBe(idRepasse);
    expect(persisted?.status).toBe('solicitado');
  });
});

describe('iniciarRepasseRecebedor — pre-validation failures', () => {
  it('throws CheckoutPlataformaMismatchError when input plataforma differs from campanha plataforma', async () => {
    const { deps, idCampanha } = await setupCampanhaComSaldoDisponivel(ID_PLATAFORMA_EUNENEM, 8000);

    await expect(
      iniciarRepasseRecebedor(deps, {
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        idCampanha,
        idRepasse: randomUUID(),
        amountCents: 1000,
      }),
    ).rejects.toThrow(CheckoutPlataformaMismatchError);
  });

  it('throws ArrecadacaoCampanhaNaoEncontradaError for an unknown campanha', async () => {
    const { deps } = await setupCampanhaComSaldoDisponivel(ID_PLATAFORMA_EUNENEM, 8000);

    await expect(
      iniciarRepasseRecebedor(deps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha: randomUUID(),
        idRepasse: randomUUID(),
        amountCents: 1000,
      }),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws CheckoutCampanhaSemRecebedorError when the campanha has no projected Recebedor', async () => {
    // Após `aperture-66klh`, `CampanhaRepository.findById` retorna a campanha
    // mesmo sem recebedor ativo (projeção null). O orquestrador detecta o
    // estado via `campanhaTemRecebedor(campanha)` e lança o erro de domínio
    // específico — o repasse é gated em presença, sem coerção silenciosa.
    const { deps, idCampanha } = await setupCampanhaComSaldoDisponivel(ID_PLATAFORMA_EUNENEM, 8000);

    const recebedoresDaCampanha = await deps.recebedorRepository.findByCampanhaId(idCampanha);
    for (const r of recebedoresDaCampanha) {
      if (r.isActive) {
        await deps.recebedorRepository.save(desativarRecebedor(r));
      }
    }

    await expect(
      iniciarRepasseRecebedor(deps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idRepasse: randomUUID(),
        amountCents: 1000,
      }),
    ).rejects.toThrow(CheckoutCampanhaSemRecebedorError);
  });
});

describe('iniciarRepasseRecebedor — delegated failures bubble up', () => {
  it('throws FinanceiroSaldoDisponivelInsuficienteError when amountCents exceeds available saldo', async () => {
    const { deps, idCampanha } = await setupCampanhaComSaldoDisponivel(ID_PLATAFORMA_EUNENEM, 5000);

    await expect(
      iniciarRepasseRecebedor(deps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idRepasse: randomUUID(),
        amountCents: 999_999, // more than the seeded R$50
      }),
    ).rejects.toThrow(FinanceiroSaldoDisponivelInsuficienteError);
  });
});
