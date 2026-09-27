import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { AdministradoresSection } from '../../../apps/eunenem-server/pages/AdminCampanhaPage.js';

/**
 * aperture-9bpre — seção Administradores em /admin/campanha/:id.
 *
 * É o destino do "+N" das tabelas: aqui a lista é COMPLETA. O link público
 * vem do slug escolhido no servidor sobre todos os administradores.
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const CAMPANHA = '10000000-0000-4000-8000-000000000001';

function admin(i: number, temUsuario: boolean) {
  return {
    idConta: `12000000-0000-4000-8000-00000000000${i}`,
    nomeExibicao: temUsuario ? `Pessoa ${i}` : null,
    email: temUsuario ? `pessoa${i}@example.test` : null,
    temUsuario,
  };
}

function render(campanha: Parameters<typeof AdministradoresSection>[0]['campanha']): string {
  return renderToStaticMarkup(
    React.createElement(AdministradoresSection, { campanha, idCampanha: CAMPANHA }),
  );
}

describe('AdministradoresSection', () => {
  it('lista todos os administradores, sem limite de exibição', () => {
    const rows = Array.from({ length: 7 }, (_, i) => admin(i + 1, true));
    const html = render({
      slug: 'cha-da-lia',
      publicOwnerSlug: 'pessoa-um',
      administradores: { rows, total: 7 },
    });
    expect(html).toContain('administradores (7)');
    expect(html.match(/href="\/admin\/usuario\//g)).toHaveLength(7);
    for (const row of rows) expect(html).toContain(`href="/admin/usuario/${row.idConta}"`);
    expect(html).not.toContain('ver os');
  });

  it('link público usa o caminho canônico e abre em nova aba', () => {
    const html = render({
      slug: 'cha-da-lia',
      publicOwnerSlug: 'pessoa-um',
      administradores: { rows: [admin(1, true)], total: 1 },
    });
    expect(html).toContain('href="/pagina/pessoa-um/cha-da-lia"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('abre em nova aba');
  });

  it('campanha sem slug cai no caminho com o id da campanha', () => {
    const html = render({
      slug: null,
      publicOwnerSlug: 'pessoa-um',
      administradores: { rows: [admin(1, true)], total: 1 },
    });
    expect(html).toContain(`href="/pagina/pessoa-um/c/${CAMPANHA}"`);
  });

  it('sem administrador elegível: explica a ausência e não cria link', () => {
    const html = render({
      slug: 'cha-da-lia',
      publicOwnerSlug: null,
      administradores: { rows: [admin(1, false), admin(2, false)], total: 2 },
    });
    expect(html).toContain('página pública indisponível');
    expect(html).toContain('Nenhum administrador desta campanha tem cadastro nesta plataforma');
    expect(html).not.toContain('href="/pagina/');
    expect(html).not.toContain('href="/admin/usuario/');
    expect(html).toContain('sem cadastro nesta plataforma');
  });

  it('campanha sem administrador registrado diz isso', () => {
    const html = render({
      slug: null,
      publicOwnerSlug: null,
      administradores: { rows: [], total: 0 },
    });
    expect(html).toContain('administradores (0)');
    expect(html).toContain('Nenhum administrador registrado para esta campanha.');
  });
});
