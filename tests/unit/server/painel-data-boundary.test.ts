import { describe, expect, it, vi } from 'vitest';
import { PainelDataBoundary } from '../../../apps/eunenem-server/pages/components/eunenem/painel/PainelDataBoundary.js';

describe('PainelDataBoundary', () => {
  it('renders a loading state instead of dashboard zeroes while data is pending', () => {
    const view = PainelDataBoundary({ isLoading: true, hasError: false, onRetry: vi.fn() });

    expect(view?.props.role).toBe('status');
    expect(JSON.stringify(view)).toContain('carregando o resumo');
    expect(JSON.stringify(view)).not.toContain('0 presentes');
  });

  it('renders an explicit error and retries after a failed dashboard query', () => {
    const onRetry = vi.fn();
    const view = PainelDataBoundary({ isLoading: false, hasError: true, onRetry });
    const children = view?.props.children as Array<{
      type?: string;
      props?: { onClick?: () => void };
    }>;
    const retryButton = children.find((child) => child?.type === 'button');

    expect(view?.props.role).toBe('alert');
    expect(JSON.stringify(view)).toContain('não foi possível carregar');
    expect(JSON.stringify(view)).not.toContain('0 presentes');

    retryButton?.props?.onClick?.();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('renders no boundary for a successful empty response', () => {
    expect(PainelDataBoundary({ isLoading: false, hasError: false, onRetry: vi.fn() })).toBeNull();
  });
});
