import { describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
import { RegraTaxaNaoEncontradaError } from '../../../src/errors/taxas/regra-nao-encontrada.error.js';

describe('ProvedorRegraTaxaMemory', () => {
  it('returns the seeded eunenem regra (5 percent across all tipos, contribuinte pays)', async () => {
    const provider = new ProvedorRegraTaxaMemory();
    const regra = await provider.getRegraAtiva(ID_PLATAFORMA_EUNENEM);

    expect(regra.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(regra.tarifasPorTipo.presente).toEqual({
      percentageBps: 500,
      responsavelTaxa: 'contribuinte',
    });
    expect(regra.tarifasPorTipo.rifa).toEqual({
      percentageBps: 500,
      responsavelTaxa: 'contribuinte',
    });
    expect(regra.tarifasPorTipo.convite).toEqual({
      percentageBps: 500,
      responsavelTaxa: 'contribuinte',
    });
  });

  it('returns the seeded eucasei regra (6 presente, 8 rifa, 8 convite, contribuinte pays)', async () => {
    const provider = new ProvedorRegraTaxaMemory();
    const regra = await provider.getRegraAtiva(ID_PLATAFORMA_EUCASEI);

    expect(regra.idPlataforma).toBe(ID_PLATAFORMA_EUCASEI);
    expect(regra.tarifasPorTipo.presente).toEqual({
      percentageBps: 600,
      responsavelTaxa: 'contribuinte',
    });
    expect(regra.tarifasPorTipo.rifa).toEqual({
      percentageBps: 800,
      responsavelTaxa: 'contribuinte',
    });
    expect(regra.tarifasPorTipo.convite).toEqual({
      percentageBps: 800,
      responsavelTaxa: 'contribuinte',
    });
  });

  it('throws RegraTaxaNaoEncontradaError for an unknown plataforma', async () => {
    const provider = new ProvedorRegraTaxaMemory();
    await expect(provider.getRegraAtiva('99999999-9999-4999-8999-999999999999')).rejects.toThrow(
      RegraTaxaNaoEncontradaError,
    );
  });
});
