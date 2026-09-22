import { describe, expect, it } from 'vitest';
import {
  EmptyMural,
  MessagesView,
  muralCopy,
} from '../../../apps/eunenem-server/pages/components/eunenem/Messages.js';

type ProjectedNode =
  | { type?: unknown; props?: Record<string, unknown> }
  | ProjectedNode[]
  | string
  | number
  | null
  | undefined;

function textContent(node: ProjectedNode): string {
  if (Array.isArray(node)) return node.map(textContent).join(' ');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';

  const props = node.props ?? {};
  if (node.type === EmptyMural) {
    return textContent(EmptyMural(props as Parameters<typeof EmptyMural>[0]));
  }

  return textContent(props.children as ProjectedNode);
}

function renderMural(genero: string | null, babyName: string): string {
  const tree = MessagesView({
    babyName,
    genero,
    recados: [],
    isLoading: false,
  });

  return textContent(tree).replace(/\s+/gu, ' ').trim();
}

describe('aperture-aponj — concordância do mural', () => {
  it('renders da/pra for a menina in the heading, intro and empty state', () => {
    const text = renderMural('menina', 'Ana Clara');

    expect(text).toContain('o mural da Ana Clara');
    expect(text).toContain('recadinho pra Ana Clara');
    expect(text).toContain('mensagem pra Ana Clara');
    expect(text).not.toContain('mural do Ana Clara');
  });

  it('keeps do/pro for a menino', () => {
    const text = renderMural('menino', 'Pedro');

    expect(text).toContain('o mural do Pedro');
    expect(text).toContain('recadinho pro Pedro');
    expect(text).toContain('mensagem pro Pedro');
  });

  it('uses the explicit legacy do/pro fallback when sexo is absent', () => {
    const text = renderMural(null, 'Alex');

    expect(muralCopy(null)).toEqual({ posse: 'do', destino: 'pro' });
    expect(text).toContain('o mural do Alex');
    expect(text).toContain('recadinho pro Alex');
    expect(text).toContain('mensagem pro Alex');
  });
});
