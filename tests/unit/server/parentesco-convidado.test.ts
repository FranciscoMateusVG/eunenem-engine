import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { concordanciaResponsaveis } from '../../../apps/eunenem-server/pages/lib/concordancia';
import { PERFIL_RELATIONS } from '../../../apps/eunenem-server/pages/lib/mocks/perfil';

describe('parentesco dos responsáveis na página do convidado', () => {
  it('oferece exatamente as cinco opções solicitadas', () => {
    expect(PERFIL_RELATIONS).toEqual(
      ['Mãe', 'Pai', 'Mãe e Pai', 'Mamães', 'Papais'].map((value) => ({ value, label: value })),
    );
  });

  it.each([
    ['Mãe', 'da mãe', 'a mãe', 'pra mãe', 'Ela compra'],
    ['Pai', 'do pai', 'o pai', 'pro pai', 'Ele compra'],
    ['Mãe e Pai', 'dos papais', 'os papais', 'pros papais', 'Eles compram'],
    ['Mamães', 'das mamães', 'as mamães', 'pras mamães', 'Elas compram'],
    ['Papais', 'dos papais', 'os papais', 'pros papais', 'Eles compram'],
  ])('concorda todos os textos para %s', (relacao, posse, sujeito, destinatario, compra) => {
    expect(concordanciaResponsaveis(relacao)).toEqual({ posse, sujeito, destinatario, compra });
  });

  it.each([
    null,
    undefined,
    '',
    'Avó',
    'Outro',
  ])('preserva o padrão de perfis antigos: %s', (relacao) => {
    expect(concordanciaResponsaveis(relacao).posse).toBe('dos papais');
  });

  it('aceita a grafia Mãe e pai e espaços', () => {
    expect(concordanciaResponsaveis(' Mãe e pai ').sujeito).toBe('os papais');
  });

  it('passa o parentesco público para os dois componentes que exibem os textos', () => {
    const page = readFileSync('apps/eunenem-server/pages/PaginaPage.tsx', 'utf8');
    expect(page).toContain(
      '<Marketplace slug={slug} ownerEditHref={ownerEditHref} relacao={data?.relacao} />',
    );
    expect(page).toContain('<HowTo relacao={data?.relacao} />');
  });
});
