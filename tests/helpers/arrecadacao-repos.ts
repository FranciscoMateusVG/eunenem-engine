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

/** Persiste campanha e o recebedor ativo (necessário para findById em Postgres). */
export async function saveCampanhaComRecebedorAtivo(
  repos: ReturnType<typeof createArrecadacaoMemoryRepos>,
  campanha: Campanha,
): Promise<void> {
  const recebedor: Recebedor = criarRecebedorInicial({
    id: campanha.idRecebedor,
    idCampanha: campanha.id,
    dadosRecebedor: campanha.dadosRecebedor,
    criadaEm: campanha.criadaEm,
  });
  await repos.campanhaRepository.save(campanha);
  await repos.recebedorRepository.save(recebedor);
}
