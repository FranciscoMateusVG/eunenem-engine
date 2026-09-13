/**
 * aperture-7mqsg — seven UI adjustments + item 8 (homepage WhatsApp FAB).
 *
 * Node-env pins in the repo's existing style (pure projections + React
 * element inspection + source-level assertions for copy). Honest scope: these
 * prove the data rule, the markup contract and the copy; the rendered
 * wrapping/scroll behaviour of item 1 is evidenced separately with the
 * fixture screenshots recorded on the bead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Footer } from '../../../apps/eunenem-server/pages/components/eunenem/Footer.js';
import {
  WHATSAPP_FAB_LABEL,
  WhatsAppFab,
} from '../../../apps/eunenem-server/pages/components/eunenem/landing/WhatsAppFab.js';
import {
  LANDING_FOOTER_COLS,
  LANDING_FOOTER_SOCIALS,
} from '../../../apps/eunenem-server/pages/lib/mocks/landing.js';

type Node =
  | { type?: unknown; props?: Record<string, unknown> }
  | Node[]
  | null
  | undefined
  | string;
function findByClass(node: Node, needle: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child, needle);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const props = node.props;
  if (!props) return undefined;
  if (typeof props.className === 'string' && props.className.includes(needle)) return props;
  return findByClass(props.children as Node, needle);
}

import {
  giftActionAvailability,
  visorViewModel,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/ListaPresentesBody.js';
import { signatureLine } from '../../../apps/eunenem-server/pages/components/eunenem/Story.js';
import { TWEAKS_DEFAULTS } from '../../../apps/eunenem-server/pages/lib/mocks/tweaksDefaults.js';
import {
  EUNENEM_SUPPORT_WHATSAPP_NUMBER_DISPLAY,
  EUNENEM_SUPPORT_WHATSAPP_URL,
  menuItemHref,
} from '../../../apps/eunenem-server/pages/lib/painelRoutes.js';

const APP = join(__dirname, '../../../apps/eunenem-server');
const src = (rel: string) => readFileSync(join(APP, rel), 'utf8');

describe('7mqsg item 7 — lista de presentes "já recebido" uses the extrato summary', () => {
  it('R$10 received + price edited to R$100 still shows R$10 (summary-driven, not price × units)', () => {
    // One gift, 1 of 5 units sold while it cost R$10; the creator then edits
    // the price to R$100. The statement's totalRecebidoCents is still 1000.
    const vm = visorViewModel([{ price: 100, qty: 5, received: 1 }], 1000);
    expect(vm.receivedLabel).toMatch(/R\$\s?10,00/);
    expect(vm.receivedLabel).not.toMatch(/100,00/);
    // Capacity value legitimately follows the new price.
    expect(vm.totalValue).toBe(500);
    expect(vm.receivedUnits).toBe(1);
    expect(vm.totalUnits).toBe(5);
    expect(Math.round(vm.pct)).toBe(2); // 10 / 500
  });

  it('multiple contributions: the amount is the summary total, independent of any item price', () => {
    const items = [
      { price: 100, qty: 2, received: 2 }, // was R$10 when sold
      { price: 35, qty: 3, received: 1 },
    ];
    const withEditedPrices = visorViewModel(items, 5500);
    const withOriginalPrices = visorViewModel(
      [
        { price: 10, qty: 2, received: 2 },
        { price: 35, qty: 3, received: 1 },
      ],
      5500,
    );
    expect(withEditedPrices.receivedLabel).toMatch(/R\$\s?55,00/);
    expect(withEditedPrices.receivedLabel).toBe(withOriginalPrices.receivedLabel);
  });

  it('product without receipts: R$0 received; unloaded summary renders a dash, never a guess', () => {
    expect(visorViewModel([{ price: 80, qty: 4, received: 0 }], 0).receivedLabel).toMatch(
      /R\$\s?0,00/,
    );
    const pending = visorViewModel([{ price: 80, qty: 4, received: 3 }], null);
    expect(pending.receivedLabel).toBe('—');
    expect(pending.pct).toBe(0);
  });

  it('no cross-product contamination: two same-name-shaped products with different prices do not alter the received amount', () => {
    const a = visorViewModel(
      [
        { price: 10, qty: 1, received: 1 },
        { price: 1000, qty: 1, received: 0 },
      ],
      1000,
    );
    const b = visorViewModel(
      [
        { price: 1000, qty: 1, received: 1 },
        { price: 10, qty: 1, received: 0 },
      ],
      1000,
    );
    expect(a.receivedLabel).toMatch(/R\$\s?10,00/);
    expect(b.receivedLabel).toBe(a.receivedLabel);
  });

  it('price stays editable on a purchased gift', () => {
    expect(giftActionAvailability(true, 1).editDisabled).toBe(false);
  });

  it('the component no longer computes price × received anywhere', () => {
    const body = src('pages/components/eunenem/painel/ListaPresentesBody.tsx');
    expect(body).not.toMatch(
      /price \* i\.received|i\.price \* i\.received|item\.price \* item\.received/,
    );
    expect(body).toMatch(/useStubExtratoSummary\(/);
    expect(body).toMatch(/recebidoCents=\{recebidoCents\}/);
  });
});

describe('7mqsg item 1 — resgatado rows keep their height inside the scroll box', () => {
  it('pins flex: 0 0 auto on .ex-resg-row (children with overflow:hidden would otherwise shrink to px)', () => {
    const css = src('pages/components/eunenem/painel/PresentesBody.tsx');
    const rule = css.match(/\.presentes-extrato \.ex-resg-row \{([\s\S]*?)\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/flex:\s*0 0 auto;/);
    expect(css).toMatch(/\.ex-resg-rows \{[\s\S]*?max-height: 50vh; overflow-y: auto;/);
  });
});

describe('7mqsg item 2 — no fictional signature/default', () => {
  it('TWEAKS_DEFAULTS.parents is empty and the signature line is omitted when blank', () => {
    expect(TWEAKS_DEFAULTS.parents).toBe('');
    expect(signatureLine('')).toBeNull();
    expect(signatureLine('   ')).toBeNull();
    expect(signatureLine('Ana & João')).toBe('com amor, Ana & João');
  });
  it('the papais field uses a descriptive placeholder, and "Mariana & Rodrigo" is gone from perfil/defaults', () => {
    const perfil = src('pages/components/eunenem/painel/PerfilBody.tsx');
    expect(perfil).not.toMatch(/Mariana & Rodrigo/);
    expect(perfil).toMatch(/placeholder="nomes dos papais, como vão assinar a página"/);
    expect(src('pages/lib/mocks/tweaksDefaults.ts')).not.toMatch(/Mariana & Rodrigo/);
  });
});

describe('7mqsg item 3 — card fee hint without "arredondado para cima"', () => {
  it('keeps the fee copy and drops only the rounding phrase', () => {
    const cart = src('pages/components/eunenem/CartDrawer.tsx');
    expect(cart).toMatch(/hint="processamento: 3,9% sobre o total \+ R\$ 0,39"/);
    expect(cart).not.toMatch(/arredondad/);
  });
});

describe('7mqsg item 4 — no invented "primeira ecografia" caption', () => {
  it('Story renders the história polaroid without a hardcoded caption', () => {
    const story = src('pages/components/eunenem/Story.tsx');
    expect(story).not.toMatch(/primeira ecografia/);
    expect(story).toMatch(/<Polaroid rotate=\{-3\}>/);
  });
});

describe('7mqsg item 5 — "direto na conta"', () => {
  it('Marketplace copy says direto na conta, not direto no Pix', () => {
    const mk = src('pages/components/eunenem/Marketplace.tsx');
    expect(mk).toMatch(/direto na conta dos papais/);
    expect(mk).not.toMatch(/direto no Pix/i);
  });
});

describe('7mqsg item 6 — support WhatsApp is the EuNeném atendimento number', () => {
  it('exposes the exact URL/number and the painel suporte row resolves to it', () => {
    expect(EUNENEM_SUPPORT_WHATSAPP_URL).toBe('https://wa.me/5511961080489');
    expect(EUNENEM_SUPPORT_WHATSAPP_NUMBER_DISPLAY).toBe('(11) 96108-0489');
    expect(menuItemHref('qualquer-slug', 'suporte')).toBe('https://wa.me/5511961080489');
  });
  it('footer "whatsapp" entries (fale conosco + social icon) are atendimento links → support number', () => {
    const fale = LANDING_FOOTER_COLS.find((c) => c.title === 'fale conosco');
    const wa = fale?.links.find(([label]) => label === 'whatsapp');
    expect(wa?.[1]).toBe('https://wa.me/5511961080489');
    const social = LANDING_FOOTER_SOCIALS.find(([, label]) => label === 'WhatsApp');
    expect(social?.[0]).toBe('https://wa.me/5511961080489');
    expect(src('pages/lib/mocks/landing.ts')).not.toMatch(/fale-com-a-gente/);
  });
  it('guest share links are untouched (whatsapp-invite still builds wa.me from the guest phone)', () => {
    const invite = src('pages/lib/whatsapp-invite.ts');
    expect(invite).toMatch(/https:\/\/wa\.me\/\$\{phone \?\? ''\}\?text=/);
    expect(invite).not.toMatch(/5511961080489/);
    expect(src('pages/lib/painelRoutes.ts')).not.toMatch(/5531999999999/);
  });
});

describe('7mqsg item 8 — homepage WhatsApp floating button', () => {
  it('is a plain accessible link to the support URL with no prefilled message and no nested button', () => {
    const el = WhatsAppFab() as unknown as { type: string; props: Record<string, unknown> };
    expect(el.type).toBe('a');
    expect(el.props.href).toBe('https://wa.me/5511961080489');
    expect(String(el.props.href)).not.toMatch(/text=/);
    expect(el.props['aria-label']).toBe(WHATSAPP_FAB_LABEL);
    expect(WHATSAPP_FAB_LABEL).toBe('Falar com a EuNeném pelo WhatsApp');
    expect(el.props.target).toBe('_blank');
    expect(el.props.rel).toBe('noopener noreferrer');
    expect(el.props.className).toBe('wa-fab');
    const child = el.props.children as { type: string; props: Record<string, unknown> };
    expect(child.type).toBe('svg');
    expect(child.props['aria-hidden']).toBe('true');
  });
  it('landing footer reserves the bottom-right strip on lg so the social icons never sit under the FAB', () => {
    const cleared = Footer({ clearFab: true }) as unknown as Node;
    expect(findByClass(cleared, 'lg:pr-[92px]')).toBeDefined();
    const plain = Footer() as unknown as Node;
    expect(findByClass(plain, 'lg:pr-[92px]')).toBeUndefined();
    expect(src('pages/LandingPage.tsx')).toMatch(/<Footer clearFab \/>/);
  });
  it('is mounted by LandingPage only', () => {
    const pages = readdirSync(join(APP, 'pages')).filter((f) => f.endsWith('.tsx'));
    const mounts = pages.filter((f) => src(join('pages', f)).includes('<WhatsAppFab'));
    expect(mounts).toEqual(['LandingPage.tsx']);
    const components = src('pages/components/eunenem/painel/PainelLayout.tsx');
    expect(components).not.toMatch(/WhatsAppFab/);
  });
  it('CSS: ≥44px target, fixed bottom-right with safe-area insets, visible focus, below the sticky navbar', () => {
    const css = src('tailwind.css');
    const rule = css.match(/\.wa-fab \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(rule).toMatch(/position: fixed;/);
    expect(rule).toMatch(/right: calc\(env\(safe-area-inset-right\) \+ 20px\);/);
    expect(rule).toMatch(/bottom: calc\(env\(safe-area-inset-bottom\) \+ 20px\);/);
    expect(rule).toMatch(/width: 56px;/);
    expect(rule).toMatch(/height: 56px;/);
    expect(rule).toMatch(/z-index: 40;/);
    expect(css).toMatch(/\.wa-fab:focus-visible \{[\s\S]*?outline: 3px solid #ffffff;/);
  });
});
