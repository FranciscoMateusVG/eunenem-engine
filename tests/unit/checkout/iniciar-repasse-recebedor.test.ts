import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import {
  criarNovoRecebedor,
  desativarRecebedor,
} from '../../../src/domain/arrecadacao/entities/recebedor.js';
import type { LancamentoFinanceiro } from '../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../../src/errors/arrecadacao/campanha-nao-encontrada.error.js';
import { CheckoutCampanhaSemRecebedorError } from '../../../src/errors/checkout/campanha-sem-recebedor.error.js';
import { CheckoutPlataformaMismatchError } from '../../../src/errors/checkout/plataforma-mismatch.error.js';
import { CheckoutRecebedorNaoPagavelViaPixError } from '../../../src/errors/checkout/recebedor-nao-pagavel-via-pix.error.js';
import { FinanceiroSaldoDisponivelInsuficienteError } from '../../../src/errors/pagamentos/financeiro/saldo-disponivel-insuficiente.error.js';
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
  metodo: 'pix' as const,
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
    // aperture-s03dr: "disponivel for solicitação" is now the predicate
    // `transferidoEm IS NULL && canceladoEm IS NULL && idRepasse IS NULL`
    // (plus the parent-pagamento JOIN which the memory adapter skips
    // when no PagamentoRepository is injected — that's fine for this
    // cross-BC orchestrator unit test).
    const lancamento: LancamentoFinanceiro = {
      id: randomUUID(),
      idPagamento: randomUUID(),
      idContribuicao: randomUUID(),
      idCampanha,
      tipo: 'credito_saldo_recebedor',
      amountCents: disponivelAmountCents,
      criadoEm: fixedDate,
      transferidoEm: null,
      canceladoEm: null,
      idRepasse: null,
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
      }),
    ).rejects.toThrow(CheckoutCampanhaSemRecebedorError);
  });
});

describe('iniciarRepasseRecebedor — conta receiver landmine', () => {
  it('throws CheckoutRecebedorNaoPagavelViaPixError for a conta recebedor, never reaching the cents-sweep', async () => {
    // Campanha starts with a PIX recebedor + seeded saldo disponível. Swap
    // the active recebedor for a 'conta' (bank-account) one: there is no
    // bank-transfer rail, so the repasse MUST short-circuit BEFORE any
    // Financeiro delegation. Proof it doesn't crash AND doesn't sweep: the
    // seeded lançamento stays unclaimed (idRepasse === null) afterwards.
    const { deps, idCampanha } = await setupCampanhaComSaldoDisponivel(ID_PLATAFORMA_EUNENEM, 8000);

    const ativos = await deps.recebedorRepository.findByCampanhaId(idCampanha);
    for (const r of ativos) {
      if (r.isActive) await deps.recebedorRepository.save(desativarRecebedor(r));
    }
    const contaRecebedor = criarNovoRecebedor({
      idCampanha,
      dadosRecebedor: {
        metodo: 'conta',
        nomeTitular: 'Joao Santos',
        cpfTitular: '52998224725',
        celularTitular: '11987654321',
        codigoBanco: '237',
        agencia: '1234',
        agenciaDigito: null,
        conta: '56789',
        contaDigito: '0',
        tipoConta: 'cc',
      },
      gerarId: () => randomUUID(),
      criadaEm: fixedDate,
    });
    await deps.recebedorRepository.save(contaRecebedor);

    await expect(
      iniciarRepasseRecebedor(deps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idRepasse: randomUUID(),
      }),
    ).rejects.toThrow(CheckoutRecebedorNaoPagavelViaPixError);

    // The cents-sweep never ran: the disponível lançamento is still unclaimed
    // (idRepasse === null) — the guard fired BEFORE Financeiro delegation.
    const lancamentos =
      await deps.livroFinanceiroRepository.findLancamentosByIdCampanha(idCampanha);
    expect(lancamentos.length).toBe(1);
    expect(lancamentos[0]?.idRepasse).toBeNull();
  });
});

describe('iniciarRepasseRecebedor — delegated failures bubble up', () => {
  it('throws FinanceiroSaldoDisponivelInsuficienteError when the eligible set is empty', async () => {
    // aperture-s03dr: with the sweep semantics, "insuficiente" means
    // "no eligible lançamento for this campanha at this clock", not
    // "amountCents > sum". Seed zero balance and verify the
    // delegated error bubbles up through the orchestrator.
    const { deps, idCampanha } = await setupCampanhaComSaldoDisponivel(ID_PLATAFORMA_EUNENEM, 0);

    await expect(
      iniciarRepasseRecebedor(deps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idRepasse: randomUUID(),
      }),
    ).rejects.toThrow(FinanceiroSaldoDisponivelInsuficienteError);
  });
});
