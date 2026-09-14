/**
 * aperture-925nx — admin "Usuários migrados" UI.
 *
 * Node-env pins in the repo's admin-UI style (createRequire'd react +
 * renderToStaticMarkup of pure components, source-level assertions for the
 * route/nav wiring). Fixture rows stand in for Rex's contract (aperture-4i05m);
 * the labels asserted here are the verbatim MIGRADO_STATUS map, so when the
 * server enum is finalised this file changes in lockstep with that one map.
 *
 * Truthfulness rules pinned: link only when idConta resolves; "—" when the
 * server sent no name / no evidence; server counts rendered as-is; no bulk
 * action controls anywhere in the table.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MigradosSearch } from '../../../apps/eunenem-server/pages/AdminMigradosPage.js';
import {
  LIMIT_OPTIONS,
  MigradosCounts,
  MigradosTable,
  type MigradosTableProps,
  StatusPill,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/MigradosTable.js';
import {
  MIGRADO_STATUS,
  type MigradoRow,
  migradosSearchInput,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/migrados-contract.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react') as {
  createElement: (type: unknown, props: Record<string, unknown>) => unknown;
};
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const APP = join(__dirname, '../../../apps/eunenem-server');
const src = (rel: string) => readFileSync(join(APP, rel), 'utf8');

const noop = () => {};
const baseProps: Omit<MigradosTableProps, 'data' | 'isFetching' | 'error'> = {
  limit: 50,
  onLimitChange: noop,
  hasPrev: false,
  onPrev: noop,
  hasNext: false,
  onNext: noop,
  startIndex: 1,
  onRetry: noop,
};

const ROWS: MigradoRow[] = [
  {
    email: 'ana@exemplo.com',
    nomeExibicao: 'Ana',
    idConta: 'conta-ana',
    legacyCampaignCount: 2,
    status: 'perfil_2_0',
    evidencedAt: '2026-09-13T12:00:00.000Z',
  },
  {
    email: 'bia@exemplo.com',
    nomeExibicao: null,
    idConta: null,
    legacyCampaignCount: 1,
    status: 'somente_legado',
    evidencedAt: null,
  },
  {
    email: 'caio@exemplo.com',
    nomeExibicao: 'Caio',
    idConta: 'conta-caio',
    legacyCampaignCount: 3,
    status: 'conta_2_0',
    evidencedAt: null,
  },
  {
    email: 'dana@exemplo.com',
    nomeExibicao: null,
    idConta: null,
    legacyCampaignCount: 1,
    status: 'evidencia_inconsistente',
    evidencedAt: null,
  },
];

const render = (props: MigradosTableProps) =>
  renderToStaticMarkup(createElement(MigradosTable, props));

describe('925nx MigradosTable — rows are truthful projections of the server row', () => {
  const html = render({
    ...baseProps,
    data: { items: ROWS, nextCursor: null, totalCount: 4, counts: {} },
    isFetching: false,
    error: null,
  });

  it('links to /admin/usuario/:idConta ONLY when the server resolved a conta', () => {
    expect(html).toContain('href="/admin/usuario/conta-ana"');
    expect(html).toContain('href="/admin/usuario/conta-caio"');
    expect(html).not.toContain('href="/admin/usuario/null"');
    expect((html.match(/data-linked="true"/g) ?? []).length).toBe(2);
    expect((html.match(/data-linked="false"/g) ?? []).length).toBe(2);
    // the unlinked row still shows its email as plain text
    expect(html).toContain('bia@exemplo.com');
  });

  it('renders "—" for a missing name and a missing evidence date, a date only when evidenced', () => {
    expect(html).toContain('2026-09-13');
    // bia: name + evidence (2) · caio: evidence only (1) · dana: name + evidence (2)
    expect((html.match(/—/g) ?? []).length).toBe(5);
  });

  it('renders the server status label verbatim and never the raw enum as visible text', () => {
    for (const status of Object.keys(MIGRADO_STATUS) as Array<keyof typeof MIGRADO_STATUS>) {
      expect(html).toContain(`data-status="${status}"`);
      expect(html).toContain(`>${MIGRADO_STATUS[status].label}<`);
    }
    expect(html).not.toContain('>somente_legado<');
    expect(html).not.toContain('>perfil_2_0<');
    // nothing in the table ever claims "migrado" — no such server status
    expect(html).not.toMatch(/>\s*migrado\s*</i);
  });

  it('has no bulk / migrate / import / edit controls — only pagination buttons', () => {
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    const labels = buttons.map((b) => b.replace(/<[^>]+>/g, '').trim());
    expect(labels.sort()).toEqual(['próxima ›', '‹ anterior']);
    expect(html).not.toMatch(/migrar|importar|editar|selecionar|checkbox/i);
  });

  it('footer counter reads startIndex–end de total and the page-size options are the documented set', () => {
    expect(html).toContain('1–4 de 4');
    for (const n of LIMIT_OPTIONS) expect(html).toContain(`<option value="${n}"`);
  });
});

describe('925nx MigradosTable — states', () => {
  it('first load → skeleton rows, no table body rows', () => {
    const html = render({ ...baseProps, data: undefined, isFetching: true, error: null });
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('data-linked');
  });

  it('error → alert banner with the server message and a retry button', () => {
    const html = render({
      ...baseProps,
      data: undefined,
      isFetching: false,
      error: { message: 'cursor inválido para esta busca' },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('cursor inválido para esta busca');
    expect(html).toContain('tentar novamente');
  });

  it('empty → explicit empty note and 0 de 0', () => {
    const html = render({
      ...baseProps,
      data: { items: [], nextCursor: null, totalCount: 0, counts: {} },
      isFetching: false,
      error: null,
    });
    expect(html).toContain('(nenhum usuário do 1.0 encontrado)');
    expect(html).toContain('0 de 0');
  });
});

describe('925nx counts + status pill + search', () => {
  it('counts render the server numbers per status and "—" when a status count is absent', () => {
    const html = renderToStaticMarkup(
      createElement(MigradosCounts, { counts: { somente_legado: 120, perfil_2_0: 7 } }),
    );
    expect(html).toContain('>120<');
    expect(html).toContain('>7<');
    expect(html).toContain('>—<'); // conta_2_0 / evidencia_inconsistente not sent → no invented zero
    for (const meta of Object.values(MIGRADO_STATUS)) {
      expect(html).toContain(meta.label);
      expect(html).toContain(`title="${meta.gloss}"`);
    }
  });

  it('status pill carries the gloss as title (semantics on hover, never inferred)', () => {
    const html = renderToStaticMarkup(createElement(StatusPill, { status: 'conta_2_0' }));
    expect(html).toContain(MIGRADO_STATUS.conta_2_0.label);
    expect(html).toContain(`title="${MIGRADO_STATUS.conta_2_0.gloss}"`);
  });

  it('search input trims and omits empty queries; the control is ≥44px and keyboard-native', () => {
    expect(migradosSearchInput('  Ana  ')).toEqual({ query: 'Ana' });
    expect(migradosSearchInput('   ')).toEqual({ query: undefined });
    const html = renderToStaticMarkup(
      createElement(MigradosSearch, { value: '', onChange: noop, onClear: noop }),
    );
    expect(html).toContain('id="admin-migrados-query"');
    expect(html).toContain('type="search"');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('maxLength="120"');
  });
});

describe('925nx wiring — route + nav (source-level)', () => {
  it('App.tsx routes /admin/migrados to AdminMigradosPage before the bare /admin rule', () => {
    const app = src('pages/App.tsx');
    const route = app.indexOf("pathname === '/admin/migrados'");
    const bare = app.indexOf("pathname === '/admin' ||");
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(bare);
    expect(app).toContain("if (route.kind === 'admin-migrados') return <AdminMigradosPage />;");
  });

  it('AdminShell sidebar carries the "Usuários migrados" entry at /admin/migrados', () => {
    const shell = src('pages/components/eunenem/admin/AdminShell.tsx');
    expect(shell).toContain(
      '{ key: "migrados", label: "Legado e migração", href: "/admin/migrados" }',
    );
  });

  it('the page never touches the server files Rex owns, and its copy never claims migration', () => {
    const page = src('pages/AdminMigradosPage.tsx');
    expect(page).not.toContain('admin-router');
    expect(page).not.toContain('legacy-users');
    expect(page).toContain('não prova');
  });

  it('the UI talks to exactly the frozen procedure and its status enum matches the server enum', () => {
    const seam = src('pages/components/eunenem/admin/migrados-contract.ts');
    expect(seam).toContain('trpc.admin.usuarios.legado.listPaginated.useQuery');
    const server = src('server/admin-legacy-users.ts');
    const enumBlock = server.slice(server.indexOf('AdminLegacyUserStatusSchema = z.enum(['));
    for (const status of Object.keys(MIGRADO_STATUS)) {
      expect(enumBlock.slice(0, enumBlock.indexOf('])'))).toContain(`"${status}"`);
    }
  });

  it('root-approved labels are the exact status wording', () => {
    expect(Object.values(MIGRADO_STATUS).map((m) => m.label)).toEqual([
      'Só no legado',
      'Conta 2.0 criada',
      'Perfil 2.0 criado',
      'Dados inconsistentes',
    ]);
  });
});
