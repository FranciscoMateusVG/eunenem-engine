import type { ReactElement } from 'react';

type Props = {
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
};

/**
 * Prevents failed dashboard queries from being rendered as plausible zeroes.
 *
 * A successful empty payload does not enter this boundary; callers render the
 * normal empty dashboard in that case. Only transport/query failure does.
 */
export function PainelDataBoundary({ isLoading, hasError, onRetry }: Props): ReactElement | null {
  if (isLoading && !hasError) {
    return (
      <section className="painel-data-state" role="status" aria-live="polite">
        <span className="perfil-spinner" aria-hidden="true" />
        <p>carregando o resumo da sua página…</p>
      </section>
    );
  }

  if (hasError) {
    return (
      <section className="painel-data-state" role="alert" aria-live="assertive">
        <strong>não foi possível carregar os números da sua página</strong>
        <p>Seus dados continuam salvos. Tente buscar o resumo novamente.</p>
        <button type="button" onClick={onRetry}>
          tentar novamente
        </button>
      </section>
    );
  }

  return null;
}
