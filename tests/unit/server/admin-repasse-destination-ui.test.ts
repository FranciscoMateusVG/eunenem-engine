import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DestinationCard } from '../../../apps/eunenem-server/pages/AdminRepasseDetailPage.js';
import type { RepasseDestination } from '../../../apps/eunenem-server/pages/components/eunenem/admin/RepassesStubData.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

function render(destination: RepasseDestination | null): string {
  return renderToStaticMarkup(React.createElement(DestinationCard, { destination }));
}

describe('admin repasse saved destination', () => {
  it('renders the sole saved PIX method with masked holder CPF', () => {
    const html = render({
      method: 'pix',
      receiverId: '10000000-0000-4000-8000-000000000001',
      holderName: 'Bia Silva',
      holderCpfMasked: '***.***.***-25',
      keyType: 'email',
      keyDisplay: 'bia@example.com',
    });

    expect(html).toContain('PIX automático');
    expect(html).toContain('Destino salvo atualmente');
    expect(html).toContain('não comprova o destino de tentativas anteriores');
    expect(html).toContain('Chave PIX salva');
    expect(html).toContain('bia@example.com');
    expect(html).toContain('***.***.***-25');
    expect(html).not.toContain('52998224725');
    expect(html).not.toContain('Conta bancária');
  });

  it('renders the sole saved bank method as manual without PIX fields', () => {
    const html = render({
      method: 'conta',
      receiverId: '10000000-0000-4000-8000-000000000002',
      holderName: 'Bia Silva',
      holderCpfMasked: '***.***.***-25',
      bankCode: '001',
      agency: '1234',
      agencyDigit: '5',
      account: '98765',
      accountDigit: '4',
      accountType: 'cc',
    });

    expect(html).toContain('Conta bancária · registro manual');
    expect(html).toContain('Destino salvo atualmente');
    expect(html).toContain('Conta corrente');
    expect(html).toContain('1234-5');
    expect(html).toContain('98765-4');
    expect(html).toContain('***.***.***-25');
    expect(html).not.toContain('52998224725');
    expect(html).not.toContain('Chave PIX salva');
  });

  it('states honestly when no active saved destination exists', () => {
    const html = render(null);

    expect(html).toContain('Destino de recebimento indisponível');
    expect(html).toContain('Nenhum método ativo está salvo');
    expect(html).not.toContain('PIX automático');
    expect(html).not.toContain('Conta bancária');
  });
});
