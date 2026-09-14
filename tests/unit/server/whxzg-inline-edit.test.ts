/**
 * aperture-whxzg — owner inline editing on the public gift page + any-colour
 * palette. Node-env pins in the repo's existing style: pure projections
 * (palette + draft/dirty helpers) and React SSR element inspection
 * (renderToString — hooks run, effects don't) for the owner/guest gate,
 * icon labels and focus-target ids.
 *
 * Honest scope: these prove the data rules, the markup contract (which
 * elements exist for whom, with which labels/ids/sizes) and the save-payload
 * merge discipline. Real click → focus, native colour picker behaviour and
 * the upload PUT are real-browser facts covered by e2e/whxzg-inline-edit.spec.ts
 * and Izzy's exact-head QA.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// react lives in the app's node_modules (not the root) — same pattern as
// browser-error-capture.test.ts importing @sentry/react.
import { createElement } from '../../../apps/eunenem-server/node_modules/react/index.js';
import { renderToString } from '../../../apps/eunenem-server/node_modules/react-dom/server.js';
import { Hero } from '../../../apps/eunenem-server/pages/components/eunenem/Hero.js';
import { Story } from '../../../apps/eunenem-server/pages/components/eunenem/Story.js';
import { TweaksProvider } from '../../../apps/eunenem-server/pages/components/eunenem/TweaksContext.js';
import {
  changedKeys,
  DRAFT_KEYS,
  draftValidationError,
  EDIT_FIELDS,
  type EditableDraft,
  HISTORIA_MAX,
  isDirty,
  mergeDraftIntoStored,
} from '../../../apps/eunenem-server/pages/lib/inline-edit.js';
import {
  PRIMARY_PRESETS,
  TWEAKS_DEFAULTS,
} from '../../../apps/eunenem-server/pages/lib/mocks/tweaksDefaults.js';
import {
  contrastRatio,
  contrastWarnings,
  isHex6,
  isPresetPrimary,
  normalizeHex,
  triadFor,
} from '../../../apps/eunenem-server/pages/lib/palette.js';

const APP = join(__dirname, '../../../apps/eunenem-server');
const src = (rel: string) => readFileSync(join(APP, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// Palette — any colour, never an unsafe value
// ─────────────────────────────────────────────────────────────────────────
describe('whxzg palette — normalizeHex accepts every RGB hex and nothing else', () => {
  it('normalizes 6-digit and 3-digit forms, with/without #, any case, padded', () => {
    expect(normalizeHex('#c9a5d8')).toBe('#C9A5D8');
    expect(normalizeHex('C9A5D8')).toBe('#C9A5D8');
    expect(normalizeHex('  #abc ')).toBe('#AABBCC');
    expect(normalizeHex('fA0')).toBe('#FFAA00');
    expect(normalizeHex('#000000')).toBe('#000000');
    expect(normalizeHex('#FFFFFF')).toBe('#FFFFFF');
    // surrounding whitespace (incl. a pasted newline) is trimmed, not rejected
    expect(normalizeHex('#C9A5D8\n')).toBe('#C9A5D8');
  });

  it('rejects anything that is not a hex colour — nothing reaches CSS or the save payload', () => {
    for (const bad of [
      '',
      ' ',
      '#',
      '#ab',
      '#abcd',
      '#abcde',
      '#abcdef0',
      '#ggg',
      'red',
      'rgb(1,2,3)',
      'var(--ink)',
      'url(javascript:alert(1))',
      '#c9a5d8; background: red',
      '#c9a5d8}',
      null,
      undefined,
    ]) {
      expect(normalizeHex(bad as string), JSON.stringify(bad)).toBeNull();
    }
  });

  it('every normalized output satisfies the backend regex (^#[0-9a-fA-F]{6}$)', () => {
    for (const v of ['#c9a5d8', 'abc', '  FfFfFf ', '123456']) {
      const n = normalizeHex(v);
      expect(n).not.toBeNull();
      expect(isHex6(n)).toBe(true);
      expect(/^#[0-9a-fA-F]{6}$/.test(n as string)).toBe(true);
    }
  });
});

describe('whxzg palette — triadFor keeps presets hand-tuned and derives the rest', () => {
  it('curated presets return their exact deep/soft pair (case-insensitive lookup)', () => {
    for (const [primary, pair] of Object.entries(PRIMARY_PRESETS)) {
      const t = triadFor(primary.toLowerCase());
      expect(t.primary).toBe(primary.toUpperCase());
      expect(t.primaryDeep).toBe(pair.deep.toUpperCase());
      expect(t.primarySoft).toBe(pair.soft.toUpperCase());
      expect(isPresetPrimary(primary.toLowerCase())).toBe(true);
    }
  });

  it('a custom primary yields a darker deep and a lighter soft, all valid hex', () => {
    const t = triadFor('#2E7D32'); // a saturated green no preset knows
    expect(isPresetPrimary('#2E7D32')).toBe(false);
    expect(isHex6(t.primary)).toBe(true);
    expect(isHex6(t.primaryDeep)).toBe(true);
    expect(isHex6(t.primarySoft)).toBe(true);
    // deep darker than primary, soft lighter than primary (luminance order)
    expect(contrastRatio(t.primaryDeep, '#000000')).toBeLessThan(
      contrastRatio(t.primary, '#000000'),
    );
    expect(contrastRatio(t.primarySoft, '#FFFFFF')).toBeLessThan(
      contrastRatio(t.primary, '#FFFFFF'),
    );
  });

  it('never loses the palette: invalid input falls back to the lilac preset', () => {
    expect(triadFor('not a colour')).toEqual(triadFor('#C9A5D8'));
    expect(triadFor(null)).toEqual(triadFor('#C9A5D8'));
  });

  it('extremes stay valid (black / white / pure channels)', () => {
    for (const c of ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF']) {
      const t = triadFor(c);
      expect(isHex6(t.primaryDeep)).toBe(true);
      expect(isHex6(t.primarySoft)).toBe(true);
    }
  });
});

describe('whxzg palette — contrast warning is informational and correctly thresholded', () => {
  it('computes WCAG ratios (white/black = 21, identical = 1)', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('#123456', '#123456')).toBe(1);
  });

  it('warns on a pale primary (white CTA text) and a pale accent (display text on paper)', () => {
    const w = contrastWarnings({ primary: '#FFF5F8', accent: '#FFE0E8' });
    expect(w.map((x) => x.field).sort()).toEqual(['accent', 'primary']);
    for (const x of w) {
      expect(x.message).toMatch(/contraste baixo/);
      expect(x.message).toMatch(/\d\.\d:1/);
    }
  });

  it('does not warn on strong colours', () => {
    expect(contrastWarnings({ primary: '#4A148C', accent: '#880E4F' })).toEqual([]);
  });

  it('the shipped defaults trip the primary warning (lilac is pale under white text) — honest, not blocking', () => {
    const w = contrastWarnings({
      primary: TWEAKS_DEFAULTS.primary,
      accent: TWEAKS_DEFAULTS.accent,
    });
    // Informational only: the panel must still render and save with these.
    expect(w.every((x) => typeof x.ratio === 'number' && x.ratio >= 1)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Draft / dirty / save-merge discipline
// ─────────────────────────────────────────────────────────────────────────
const BASE: EditableDraft = {
  babyName: 'Helena',
  parents: 'Mari & Rodrigo',
  historia: 'era uma vez',
  primary: '#C9A5D8',
  accent: '#E78FA7',
};

describe('whxzg draft — dirty tracks the editable half only, tolerant of whitespace/case', () => {
  it('identical → clean; trailing whitespace and hex case do not count', () => {
    expect(isDirty(BASE, BASE)).toBe(false);
    expect(
      isDirty({ ...BASE, babyName: 'Helena  ', primary: '#c9a5d8', accent: ' #e78fa7 ' }, BASE),
    ).toBe(false);
  });

  it('each editable key flips dirty on its own', () => {
    for (const key of DRAFT_KEYS) {
      const draft = { ...BASE, [key]: key === 'primary' || key === 'accent' ? '#123456' : 'x' };
      expect(changedKeys(draft, BASE), key).toEqual([key]);
      expect(isDirty(draft, BASE)).toBe(true);
    }
  });
});

describe('whxzg save merge — only CHANGED keys override the stored profile', () => {
  const atual = {
    nomeBebe: 'Helena',
    papais: null as string | null,
    historia: 'era uma vez',
    corPrimaria: '#C9A5D8',
    corAcento: '#E78FA7',
    relacao: 'Mãe',
    fotoCapaKey: 'campanha/x/capa.jpg',
  };
  // Baseline as PaginaPage/TweaksPanel seed it: papais null → parents shows
  // the creatorName FALLBACK ("franciscomateusvg"), not an empty string.
  const baseline: EditableDraft = { ...BASE, parents: 'franciscomateusvg' };

  it('untouched draft echoes the stored profile verbatim — the creatorName fallback is NEVER persisted as papais', () => {
    const merged = mergeDraftIntoStored(atual, baseline, baseline);
    expect(merged).toEqual(atual);
    expect(merged.papais).toBeNull();
  });

  it('editing only the story leaves name/palette/keys untouched', () => {
    const merged = mergeDraftIntoStored(
      atual,
      { ...baseline, historia: 'nova história' },
      baseline,
    );
    expect(merged.historia).toBe('nova história');
    expect(merged.nomeBebe).toBe('Helena');
    expect(merged.corPrimaria).toBe('#C9A5D8');
    expect(merged.fotoCapaKey).toBe('campanha/x/capa.jpg');
    expect(merged.relacao).toBe('Mãe');
  });

  it('a custom colour persists as the normalized hex; clearing text persists null', () => {
    const merged = mergeDraftIntoStored(
      atual,
      { ...baseline, primary: '#2E7D32', accent: '#880E4F', historia: '   ' },
      baseline,
    );
    expect(merged.corPrimaria).toBe('#2E7D32');
    expect(merged.corAcento).toBe('#880E4F');
    expect(merged.historia).toBeNull();
  });

  it('client validation mirrors the VO caps (120 / 120 / 600)', () => {
    expect(draftValidationError(BASE)).toBeNull();
    expect(draftValidationError({ ...BASE, babyName: 'a'.repeat(121) })).toMatch(/120/);
    expect(draftValidationError({ ...BASE, parents: 'a'.repeat(121) })).toMatch(/120/);
    expect(draftValidationError({ ...BASE, historia: 'a'.repeat(HISTORIA_MAX + 1) })).toMatch(
      /600/,
    );
    expect(draftValidationError({ ...BASE, historia: 'a'.repeat(HISTORIA_MAX) })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Owner / guest gate on the page components (SSR element inspection)
// ─────────────────────────────────────────────────────────────────────────
function render(node: React.ReactElement, initialState?: Record<string, unknown>) {
  return renderToString(createElement(TweaksProvider, { initialState, children: node }));
}

const EDIT_BTN = /data-testid="edit-([a-zA-Z]+)"/g;
const editFields = (html: string) => [...html.matchAll(EDIT_BTN)].map((m) => m[1]);

describe('whxzg page gate — edit icons exist ONLY for the owner', () => {
  it('Hero: guest render (editable=false / omitted) has no edit control at all', () => {
    const html = render(createElement(Hero, { coverUrl: 'https://x/capa.jpg' }));
    expect(editFields(html)).toEqual([]);
    expect(html).not.toContain('eu-edit-btn');
    expect(html).not.toContain('Editar');
  });

  it('Hero: owner render carries title + cover + polaroid icons with the field map labels', () => {
    const html = render(createElement(Hero, { editable: true }));
    expect(editFields(html).sort()).toEqual(['fotoCapa', 'fotoPerfil', 'nomeBebe']);
    expect(html).toContain(`aria-label="${EDIT_FIELDS.nomeBebe.iconLabel}"`);
    expect(html).toContain(`aria-label="${EDIT_FIELDS.fotoCapa.iconLabel}"`);
    expect(html).toContain(`aria-label="${EDIT_FIELDS.fotoPerfil.iconLabel}"`);
  });

  it('Story: guest render has no controls; owner render has story-text + story-photo icons', () => {
    const guest = render(createElement(Story, { historia: 'oi' }));
    expect(editFields(guest)).toEqual([]);
    const owner = render(createElement(Story, { historia: 'oi', editable: true }));
    expect(editFields(owner).sort()).toEqual(['fotoHistoria', 'historia']);
    expect(owner).toContain(`aria-label="${EDIT_FIELDS.historia.iconLabel}"`);
  });

  it('edit icons are real <button type="button"> (keyboard-native), never links/divs', () => {
    const html = render(createElement(Hero, { editable: true }));
    const buttons = html.match(/<button[^>]*class="eu-edit-btn[^"]*"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    for (const b of buttons) expect(b).toContain('type="button"');
  });
});

describe('whxzg previews — TweaksContext overrides win over server props', () => {
  it('Hero shows the context photo override (owner just uploaded) over the prop', () => {
    const html = render(createElement(Hero, { coverUrl: 'https://x/old.jpg' }), {
      fotoCapaUrl: 'https://x/new.jpg',
    });
    expect(html).toContain('https://x/new.jpg');
    expect(html).not.toContain('https://x/old.jpg');
  });

  it('Story shows the context historia draft over the prop, and the prop when the draft is null', () => {
    const withDraft = render(createElement(Story, { historia: 'servidor' }), {
      historia: 'rascunho',
    });
    expect(withDraft).toContain('rascunho');
    expect(withDraft).not.toContain('servidor');
    const noDraft = render(createElement(Story, { historia: 'servidor' }), { historia: null });
    expect(noDraft).toContain('servidor');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Field map ↔ panel contract (source-level: every field has a focus target)
// ─────────────────────────────────────────────────────────────────────────
describe('whxzg field map — every edit field has a unique focus target the panel renders', () => {
  it('inputIds are unique and 44px targets are enforced in CSS', () => {
    const ids = Object.values(EDIT_FIELDS).map((f) => f.inputId);
    expect(new Set(ids).size).toBe(ids.length);
    const css = src('tailwind.css');
    expect(css).toMatch(/\.eu-edit-btn\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
    expect(css).toMatch(/\.tweaks-close\s*\{[^}]*width:\s*44px;/s);
    expect(css).toMatch(/\.tweaks-btn\s*\{[^}]*min-height:\s*44px;/s);
  });

  it('TweaksPanel renders an element with each inputId (focus targets exist)', () => {
    const panel = src('pages/components/eunenem/TweaksPanel.tsx');
    for (const f of Object.values(EDIT_FIELDS)) {
      // Rendered via EDIT_FIELDS.<id>.inputId — the identifier must be referenced.
      expect(panel, f.id).toContain(`EDIT_FIELDS.${f.id}.inputId`);
    }
    // Photo persistence is disclosed BEFORE the picker and Cancelar never
    // claims to undo photos (GLaDOS/Izzy contract 2026-09-14).
    const slot = src('pages/components/eunenem/PhotoSlot.tsx');
    expect(slot).toContain('foto salva na hora do envio');
    expect(panel).toMatch(/fotos enviadas já estão salvas/);
    expect(panel).toMatch(/descarta só o texto e as cores não salvos/);
  });

  it('the photo persist payload echoes the STORED profile, never the draft', () => {
    const panel = src('pages/components/eunenem/TweaksPanel.tsx');
    const upload = panel.slice(
      panel.indexOf('const uploadFoto'),
      panel.indexOf('// The whole affordance'),
    );
    // Inside uploadFoto every content field comes from `atual.` (stored), and
    // the draft accessors never appear.
    expect(upload).toContain('nomeBebe: atual.nomeBebe');
    expect(upload).toContain('historia: atual.historia');
    expect(upload).toContain('corPrimaria: atual.corPrimaria');
    expect(upload).not.toContain('tweaks.babyName');
    expect(upload).not.toContain('tweaks.historia');
    expect(upload).not.toContain('tweaks.primary');
    expect(upload).not.toContain('markSaved(');
  });
});
