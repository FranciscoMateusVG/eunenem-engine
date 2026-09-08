import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PrivateProviderErrorBody } from '../../../apps/eunenem-server/pages/components/eunenem/admin/PrivateProviderErrorBody.js';

// The frontend is an intentionally separate package. Resolve its React runtime
// from that package exactly as CI does after the app's frozen install.
const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react') as {
  createElement: (type: unknown, props: Record<string, unknown>) => unknown;
};
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

describe('PrivateProviderErrorBody', () => {
  it('is collapsed by default and renders the original bank body as escaped text', () => {
    const body = '{"detail":"<script>alert(1)</script>& recipient"}';
    const html = renderToStaticMarkup(
      createElement(PrivateProviderErrorBody, { body, truncated: false }),
    );

    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[=>\s])/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp; recipient');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('truncada em 16 KiB');
  });

  it('shows a conspicuous truncation indicator', () => {
    const html = renderToStaticMarkup(
      createElement(PrivateProviderErrorBody, { body: 'partial', truncated: true }),
    );

    expect(html).toContain('truncada em 16 KiB');
  });
});
