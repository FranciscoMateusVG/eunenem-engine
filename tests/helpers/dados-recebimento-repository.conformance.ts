import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DadosRecebimentoRepository } from '../../src/adapters/usuario/dados-recebimento-repository.js';
import type { UsuarioRepository } from '../../src/adapters/usuario/repository.js';
import type { DadosRecebedor } from '../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
import {
  criarDadosRecebimentoUsuario,
  type DadosRecebimentoUsuario,
} from '../../src/domain/usuario/entities/dados-recebimento-usuario.js';
import type { Conta, Usuario } from '../../src/domain/usuario/entities/usuario.js';

function makeUsuario(id: string): { usuario: Usuario; conta: Conta } {
  const slug = `u${id.replace(/-/g, '').slice(0, 20)}`;
  const idConta = randomUUID();
  const criadoEm = new Date('2026-01-01T00:00:00.000Z');
  const usuario: Usuario = {
    id,
    idPlataforma: randomUUID(),
    idConta,
    email: `${slug}@test.com`,
    nomeExibicao: 'Usuario Teste',
    slug,
    criadoEm,
    tutorialCompletadoEm: null,
  };
  const conta: Conta = { id: idConta, idUsuario: id, permissoes: [], criadaEm: criadoEm };
  return { usuario, conta };
}

const DADOS_PIX: DadosRecebedor = {
  metodo: 'pix',
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email',
  chavePix: 'maria@exemplo.com',
};

const DADOS_CONTA: DadosRecebedor = {
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
};

function makeRegistro(
  idUsuario: string,
  dados: DadosRecebedor,
  atualizadoEm: Date = new Date('2026-06-01T12:00:00.000Z'),
): DadosRecebimentoUsuario {
  return criarDadosRecebimentoUsuario({ idUsuario, dados, atualizadoEm });
}

interface ConformanceOptions {
  factory: () =>
    | DadosRecebimentoRepository
    | Promise<DadosRecebimentoRepository>
    | {
        dadosRecebimentoRepository: DadosRecebimentoRepository;
        usuarioRepository: UsuarioRepository;
      }
    | Promise<{
        dadosRecebimentoRepository: DadosRecebimentoRepository;
        usuarioRepository: UsuarioRepository;
      }>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describeDadosRecebimentoRepositoryConformance(
  name: string,
  options: ConformanceOptions,
) {
  describe(`DadosRecebimentoRepository conformance — ${name}`, () => {
    let repo: DadosRecebimentoRepository;
    let seedUsuario: (idUsuario: string) => Promise<void>;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      const built = await options.factory();
      if ('dadosRecebimentoRepository' in built) {
        repo = built.dadosRecebimentoRepository;
        seedUsuario = async (idUsuario: string) => {
          await built.usuarioRepository.saveRegistroDomain(makeUsuario(idUsuario));
        };
      } else {
        repo = built;
        seedUsuario = async () => {};
      }
    });

    it('round-trips a pix variant', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      const registro = makeRegistro(idUsuario, DADOS_PIX);
      await repo.save(registro);
      expect(await repo.findByUsuarioId(idUsuario)).toEqual(registro);
    });

    it('round-trips a conta variant', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      const registro = makeRegistro(idUsuario, DADOS_CONTA);
      await repo.save(registro);
      expect(await repo.findByUsuarioId(idUsuario)).toEqual(registro);
    });

    it('returns undefined when no data exists for the usuario', async () => {
      expect(await repo.findByUsuarioId(randomUUID())).toBeUndefined();
    });

    it('upsert replaces dados across variants (pix → conta)', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      await repo.save(makeRegistro(idUsuario, DADOS_PIX, new Date('2026-06-01T12:00:00.000Z')));

      const reedit = makeRegistro(idUsuario, DADOS_CONTA, new Date('2026-06-10T08:00:00.000Z'));
      await repo.save(reedit);

      const found = await repo.findByUsuarioId(idUsuario);
      expect(found).toEqual(reedit);
      expect(found?.dados.metodo).toBe('conta');
    });

    it('save emits db.dados_recebimento_usuario.save span', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      await repo.save(makeRegistro(idUsuario, DADOS_PIX));
      const span = options.getSpans().find((s) => s.name === 'db.dados_recebimento_usuario.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
    });
  });
}
