import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { criarContribuicao as criarContribuicaoEntity } from '../../../src/domain/arrecadacao/entities/contribuicao.js';
import { ArrecadacaoInputInvalidoError } from '../../../src/errors/arrecadacao/input-invalido.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { alterarValorContribuicao } from '../../../src/use-cases/arrecadacao/alterar-valor-contribuicao.js';
import { atualizarContribuicao } from '../../../src/use-cases/arrecadacao/atualizar-contribuicao.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { criarContribuicoesEmLote } from '../../../src/use-cases/arrecadacao/criar-contribuicoes-em-lote.js';
import { ValorUnitarioPresenteWriteSchema } from '../../../src/use-cases/arrecadacao/valor-unitario-presente.js';

const observability = { logger: new NoopLogger(), tracer: noopTracer() };

describe('gift unit-value write policy', () => {
  it.each([1, 999])('rejects %i cents at every direct write use-case boundary', async (valor) => {
    const saveBulk = vi.fn();
    const invalid = ArrecadacaoInputInvalidoError;

    await expect(
      criarContribuicao(
        {
          observability,
          campanhaRepository: {} as never,
          contribuicaoRepository: {} as never,
          clock: () => new Date(),
        },
        {
          id: randomUUID(),
          idCampanha: randomUUID(),
          idOpcaoContribuicao: randomUUID(),
          nome: 'Presente',
          valor,
        },
      ),
    ).rejects.toThrow(invalid);
    await expect(
      criarContribuicoesEmLote(
        {
          observability,
          campanhaRepository: {} as never,
          contribuicaoRepository: { saveBulk } as never,
          clock: () => new Date(),
        },
        {
          idCampanha: randomUUID(),
          idOpcaoContribuicao: randomUUID(),
          items: [
            { nome: 'Válido', valor: 1_000 },
            { nome: 'Inválido', valor, quantidade: 100 },
          ],
        },
      ),
    ).rejects.toThrow(invalid);
    await expect(
      atualizarContribuicao(
        { observability, contribuicaoRepository: {} as never, pagamentoRepository: {} as never },
        { idContribuicao: randomUUID(), idCampanhaEsperada: randomUUID(), valor },
      ),
    ).rejects.toThrow(invalid);
    await expect(
      alterarValorContribuicao(
        { observability, contribuicaoRepository: {} as never },
        { idContribuicao: randomUUID(), valor },
      ),
    ).rejects.toThrow(invalid);

    expect(saveBulk).not.toHaveBeenCalled();
  });

  it('accepts 1000 cents without changing the historical entity/read contract', () => {
    expect(ValorUnitarioPresenteWriteSchema.parse(1_000)).toBe(1_000);
    const historical = criarContribuicaoEntity({
      id: randomUUID(),
      idCampanha: randomUUID(),
      idOpcaoContribuicao: randomUUID(),
      nome: 'Presente histórico',
      valor: 999,
      criadaEm: new Date('2026-09-15T00:00:00.000Z'),
    });
    expect(historical.valor).toBe(999);
  });
});
