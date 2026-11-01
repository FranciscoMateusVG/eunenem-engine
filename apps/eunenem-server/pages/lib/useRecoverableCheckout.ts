import { useEffect, useRef, useState } from 'react';
import { CheckoutCooldownError, executeRecoverableCheckout } from './checkoutOperationClient.js';

/** Own the whole operation, including failures before tRPC starts. Never infer
 * the latest outcome from a previous network mutation's sticky error state. */
export function useRecoverableCheckout<TInput extends object, TResponse extends { tipo: string }>(
  storageKey: string,
  mutation: {
    mutateAsync: (input: TInput & { operationId: string }) => Promise<TResponse>;
    reset: () => void;
  },
) {
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const running = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [retryAt, now >= retryAt]);
  const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const reset = () => {
    mutation.reset();
    setError(null);
  };
  const mutateAsync = (requestInput: TInput) => {
    // Suppress duplicate submits even during hashing/storage before HTTP starts.
    if (running.current)
      return running.current as ReturnType<typeof executeRecoverableCheckout<TInput, TResponse>>;
    reset();
    setPending(true);
    setNow(Date.now());
    setRetryAt(0);
    const promise = executeRecoverableCheckout({
      storageKey,
      requestInput,
      request: mutation.mutateAsync,
    })
      .catch((cause: unknown) => {
        const failure =
          cause instanceof Error
            ? cause
            : new Error('Não foi possível iniciar o pagamento. Tente novamente.');
        setError(failure);
        if (failure instanceof CheckoutCooldownError) setRetryAt(failure.retryAt);
        throw failure;
      })
      .finally(() => {
        running.current = null;
        setPending(false);
      });
    running.current = promise;
    return promise;
  };
  const message =
    error instanceof CheckoutCooldownError
      ? retrySeconds > 0
        ? `Aguarde ${retrySeconds} s antes de tentar novamente.`
        : 'Você já pode tentar novamente.'
      : error?.message;
  return {
    mutateAsync,
    reset,
    error,
    errorMessage: message,
    isError: error !== null,
    isPending: pending,
    retryAt,
    retrySeconds,
  };
}
