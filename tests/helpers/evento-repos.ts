import type { ConviteRepository } from '../../src/adapters/evento/convite-repository.js';
import { ConviteRepositoryMemory } from '../../src/adapters/evento/convite-repository.memory.js';
import type { EventoRepository } from '../../src/adapters/evento/evento-repository.js';
import { EventoRepositoryMemory } from '../../src/adapters/evento/evento-repository.memory.js';
import { createArrecadacaoMemoryRepos } from './arrecadacao-repos.js';

export function createEventoMemoryRepos(): {
  conviteRepository: ConviteRepository;
  eventoRepository: EventoRepository;
  campanhaRepository: ReturnType<typeof createArrecadacaoMemoryRepos>['campanhaRepository'];
  recebedorRepository: ReturnType<typeof createArrecadacaoMemoryRepos>['recebedorRepository'];
  plataformaRepository: ReturnType<typeof createArrecadacaoMemoryRepos>['plataformaRepository'];
} {
  const arrecadacao = createArrecadacaoMemoryRepos();
  const conviteRepository = new ConviteRepositoryMemory();
  const eventoRepository = new EventoRepositoryMemory();
  return { conviteRepository, eventoRepository, ...arrecadacao };
}
