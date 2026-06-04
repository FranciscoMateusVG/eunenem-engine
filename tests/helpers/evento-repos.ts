import type { EventoRepository } from '../../src/adapters/evento/evento-repository.js';
import { EventoRepositoryMemory } from '../../src/adapters/evento/evento-repository.memory.js';
import { createArrecadacaoMemoryRepos } from './arrecadacao-repos.js';

export function createEventoMemoryRepos(): {
  eventoRepository: EventoRepository;
  campanhaRepository: ReturnType<typeof createArrecadacaoMemoryRepos>['campanhaRepository'];
  recebedorRepository: ReturnType<typeof createArrecadacaoMemoryRepos>['recebedorRepository'];
  plataformaRepository: ReturnType<typeof createArrecadacaoMemoryRepos>['plataformaRepository'];
} {
  const arrecadacao = createArrecadacaoMemoryRepos();
  const eventoRepository = new EventoRepositoryMemory();
  return { eventoRepository, ...arrecadacao };
}
