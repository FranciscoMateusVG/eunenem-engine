import type { CampanhaRepository } from '../../src/adapters/arrecadacao/campanha-repository.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import type { RecebedorRepository } from '../../src/adapters/arrecadacao/recebedor-repository.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import type { PlataformaRepository } from '../../src/adapters/plataforma/repository.js';
import { PlataformaRepositoryMemory } from '../../src/adapters/plataforma/repository.memory.js';
import type { Campanha } from '../../src/domain/arrecadacao/entities/campanha.js';
import {
  criarRecebedorInicial,
  type Recebedor,
} from '../../src/domain/arrecadacao/entities/recebedor.js';

export function createArrecadacaoMemoryRepos(): {
  campanhaRepository: CampanhaRepository;
  recebedorRepository: RecebedorRepository;
  plataformaRepository: PlataformaRepository;
} {
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const plataformaRepository = new PlataformaRepositoryMemory();
  return { campanhaRepository, recebedorRepository, plataformaRepository };
}

/**
 * Persiste campanha e o recebedor ativo (necessário para findById em Postgres).
 *
 * Pós aperture-66klh: a campanha pode existir sem Recebedor. Quando
 * `idRecebedor`/`dadosRecebedor` são `null` (lifecycle pré-bank-info),
 * apenas a campanha é persistida — nenhum recebedor é criado.
 */
export async function saveCampanhaComRecebedorAtivo(
  repos: ReturnType<typeof createArrecadacaoMemoryRepos>,
  campanha: Campanha,
): Promise<void> {
  await repos.campanhaRepository.save(campanha);
  if (campanha.idRecebedor !== null && campanha.dadosRecebedor !== null) {
    const recebedor: Recebedor = criarRecebedorInicial({
      id: campanha.idRecebedor,
      idCampanha: campanha.id,
      dadosRecebedor: campanha.dadosRecebedor,
      criadaEm: campanha.criadaEm,
    });
    await repos.recebedorRepository.save(recebedor);
  }
}
