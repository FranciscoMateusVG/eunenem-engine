import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MessagesView } from '../../../apps/eunenem-server/pages/components/eunenem/Messages.js';
import { navLinks } from '../../../apps/eunenem-server/pages/components/eunenem/Navbar.js';

/**
 * aperture-851nu — "Exibir recados publicamente" desligado: a página pública
 * não mostra a seção do mural (nem o estado vazio) nem o link "Mural".
 */
const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const mural = (oculto: boolean) =>
  renderToStaticMarkup(
    React.createElement(MessagesView, {
      babyName: 'Helena',
      genero: 'menina',
      recados: [],
      isLoading: false,
      oculto,
    }),
  );

describe('mural com recados ocultos', () => {
  it('não renderiza a seção quando a campanha esconde os recados', () => {
    expect(mural(true)).toBe('');
    expect(mural(false)).toContain('id="mural"');
  });

  it('remove o link Mural da navegação só quando oculto', () => {
    expect(navLinks(true).map((l) => l.href)).toEqual(['#presentes', '#como', '#mural']);
    expect(navLinks(false).map((l) => l.href)).toEqual(['#presentes', '#como']);
  });
});
