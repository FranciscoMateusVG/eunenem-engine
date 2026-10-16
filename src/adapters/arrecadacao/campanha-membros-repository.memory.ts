import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdCampanha, IdConta } from '../../domain/arrecadacao/value-objects/ids.js';
import type {
  AcaoConcedivel,
  AcessoMembroCampanha,
} from '../../domain/arrecadacao/value-objects/permissao-campanha.js';
import type { CampanhaMembrosRepository, MembroCampanha } from './campanha-membros-repository.js';
import { ordenarMembros } from './campanha-membros-repository.postgres.js';
import type { CampanhaRepository } from './campanha-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'campanha_membros_permissoes',
} as const;

async function comSpan<T>(nome: string, operacao: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`db.campanha_membros_permissoes.${nome}`, async (span) => {
    span.setAttributes({ ...DB_ATTRS, 'db.operation.name': operacao });
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: unknown) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Memory twin of the Postgres adapter. Membership (`campanha_administradores`)
 * is read from the CampanhaRepository. The Postgres `save` writes a NEW
 * campanha's creator as owner; the memory CampanhaRepository can't reach this
 * store, so that is emulated lazily: a campanha with no papel rows yet gets
 * its creator (`idsAdministradores[0]`) as owner on first access.
 */
export class CampanhaMembrosRepositoryMemory implements CampanhaMembrosRepository {
  private readonly papeis = new Map<IdCampanha, Map<IdConta, AcessoMembroCampanha>>();

  constructor(private readonly campanhaRepository: CampanhaRepository) {}

  private async linhas(idCampanha: IdCampanha): Promise<Map<IdConta, AcessoMembroCampanha>> {
    let linhas = this.papeis.get(idCampanha);
    if (!linhas) {
      linhas = new Map();
      this.papeis.set(idCampanha, linhas);
    }
    if (linhas.size === 0) {
      const campanha = await this.campanhaRepository.findById(idCampanha);
      const primeiro = campanha?.idsAdministradores[0];
      if (primeiro !== undefined) linhas.set(primeiro, { papel: 'owner', permissoes: [] });
    }
    return linhas;
  }

  private async administradores(idCampanha: IdCampanha): Promise<readonly IdConta[]> {
    const campanha = await this.campanhaRepository.findById(idCampanha);
    return campanha?.idsAdministradores ?? [];
  }

  async obterAcesso(
    idCampanha: IdCampanha,
    idConta: IdConta,
  ): Promise<AcessoMembroCampanha | undefined> {
    return comSpan('obterAcesso', 'SELECT', async () => {
      const linhas = await this.linhas(idCampanha);
      if (!(await this.administradores(idCampanha)).includes(idConta)) return undefined;
      return linhas.get(idConta);
    });
  }

  async listarMembros(idCampanha: IdCampanha): Promise<readonly MembroCampanha[]> {
    return comSpan('listarMembros', 'SELECT', async () => {
      const linhas = await this.linhas(idCampanha);
      const admins = await this.administradores(idCampanha);
      return [...linhas.entries()]
        .filter(([idConta]) => admins.includes(idConta))
        .map(([idConta, acesso]) => ({ idConta, ...acesso }))
        .sort(ordenarMembros);
    });
  }

  async adicionarMembro(idCampanha: IdCampanha, idConta: IdConta): Promise<void> {
    return comSpan('adicionarMembro', 'INSERT', async () => {
      const linhas = await this.linhas(idCampanha);
      if (!linhas.has(idConta)) linhas.set(idConta, { papel: 'membro', permissoes: [] });
    });
  }

  async removerMembro(idCampanha: IdCampanha, idConta: IdConta): Promise<void> {
    return comSpan('removerMembro', 'DELETE', async () => {
      this.papeis.get(idCampanha)?.delete(idConta);
    });
  }

  async definirPermissoes(
    idCampanha: IdCampanha,
    idConta: IdConta,
    permissoes: readonly AcaoConcedivel[],
  ): Promise<boolean> {
    return comSpan('definirPermissoes', 'UPDATE', async () => {
      const linhas = await this.linhas(idCampanha);
      const atual = linhas.get(idConta);
      if (atual?.papel !== 'membro') return false;
      linhas.set(idConta, { papel: 'membro', permissoes: [...new Set(permissoes)] });
      return true;
    });
  }
}
