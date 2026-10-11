import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const perfilSource = readFileSync(
  join(__dirname, '../../../apps/eunenem-server/pages/components/eunenem/painel/PerfilBody.tsx'),
  'utf8',
);

describe('editar meu perfil — tipo de evento', () => {
  it('oferece chá revelação como uma opção selecionável', () => {
    const selectableTypes = perfilSource.match(
      /const SELECTABLE_EVENT_TYPES:[\s\S]*?= \[([\s\S]*?)\];/,
    )?.[1];

    expect(selectableTypes).toContain('"cha-revelacao"');
    expect(perfilSource).toContain('"cha-revelacao": "Chá revelação"');
  });
});
