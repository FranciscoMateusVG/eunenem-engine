// aperture-kbmel — Mock hook for `recebedor.criar` tRPC mutation.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ TODO(aperture-kbmel-rex-swap): REPLACE WITH REAL trpc HOOK              │
// │                                                                         │
// │ When Rex's `recebedor.criar` tRPC procedure ships, swap THE ENTIRE      │
// │ `useCriarRecebedor` BODY below with the one-liner:                      │
// │                                                                         │
// │   import { trpc } from "@/lib/trpc.js";                                 │
// │                                                                         │
// │   export function useCriarRecebedor(                                    │
// │     opts: UseCriarRecebedorOptions,                                     │
// │   ): CriarRecebedorMutationState {                                      │
// │     return trpc.recebedor.criar.useMutation({                           │
// │       onSuccess: (result) => opts.onSuccess?.(result),                  │
// │       onError:   (err)    => opts.onError?.(err),                       │
// │     });                                                                 │
// │   }                                                                     │
// │                                                                         │
// │ ASSUMPTION: Rex's backend uses `CriarRecebedorInputSchema` (this file's │
// │ imported schema) verbatim as the procedure input. If he diverges, the   │
// │ frontend form's payload shape must follow — the schema is the contract. │
// └─────────────────────────────────────────────────────────────────────────┘

import { useCallback, useState } from "react";

import {
  type CriarRecebedorInput,
  type CriarRecebedorOutput,
  CriarRecebedorInputSchema,
} from "@/lib/schemas/criar-recebedor";

/**
 * Caller-supplied options. Mirrors the surface of
 * `trpc.recebedor.criar.useMutation({ onSuccess, onError })` so the
 * swap-over is a one-line change.
 */
export type UseCriarRecebedorOptions = {
  onSuccess?: (result: CriarRecebedorOutput) => void;
  onError?: (err: Error) => void;
};

/**
 * Hook return — mirrors the shape of react-query's mutation result that
 * `trpc.*.useMutation()` exposes. Only the surface actually consumed by
 * the TransferModal is included; expand if a real consumer needs more.
 */
export type CriarRecebedorMutationState = {
  mutate: (input: CriarRecebedorInput) => void;
  mutateAsync: (input: CriarRecebedorInput) => Promise<CriarRecebedorOutput>;
  isPending: boolean;
  data: CriarRecebedorOutput | null;
  error: Error | null;
  reset: () => void;
};

/**
 * Simulated network delay so the modal's pending-state visibly engages.
 * Matches the kbmel spec's ~500ms hint.
 */
const MOCK_LATENCY_MS = 500;

/**
 * Mock implementation: validates input against the shared schema (catches
 * shape drift early), simulates ~500ms latency, returns a fake
 * `idRecebedor`. The shape of the resolved value matches
 * `CriarRecebedorOutputSchema` so consumers that chain on `idRecebedor` work
 * unchanged after the swap.
 *
 * SWAP TARGET: see top-of-file TODO. Replace this function's body with the
 * real `trpc.recebedor.criar.useMutation(...)` call when Rex's backend
 * lands. The exported signature does NOT change.
 */
function useMockCriarRecebedor(
  opts: UseCriarRecebedorOptions = {},
): CriarRecebedorMutationState {
  const [isPending, setIsPending] = useState(false);
  const [data, setData] = useState<CriarRecebedorOutput | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const mutateAsync = useCallback(
    async (input: CriarRecebedorInput): Promise<CriarRecebedorOutput> => {
      setIsPending(true);
      setError(null);
      try {
        // Validate against the shared schema. In prod this is enforced by
        // the wire (zod input on the tRPC procedure); validating here too
        // catches drift the mock would otherwise paper over.
        const parsed = CriarRecebedorInputSchema.parse(input);
        await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS));
        const result: CriarRecebedorOutput = {
          idRecebedor: `mock-recebedor-${parsed.idCampanha.slice(0, 8)}`,
        };
        setData(result);
        opts.onSuccess?.(result);
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        opts.onError?.(e);
        throw e;
      } finally {
        setIsPending(false);
      }
    },
    // We deliberately omit opts.onSuccess/onError from deps — the real
    // trpc useMutation hook reads them from the latest render, and we
    // want identical behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const mutate = useCallback(
    (input: CriarRecebedorInput) => {
      // Fire-and-forget; matches react-query's `mutate` (vs `mutateAsync`).
      void mutateAsync(input).catch(() => {
        // Errors land in the `error` state above + onError callback. The
        // throw here would otherwise become an unhandled promise rejection.
      });
    },
    [mutateAsync],
  );

  const reset = useCallback(() => {
    setIsPending(false);
    setData(null);
    setError(null);
  }, []);

  return { mutate, mutateAsync, isPending, data, error, reset };
}

/**
 * Public export. Single point-of-swap for Rex's backend swap-in.
 *
 * TODO(aperture-kbmel-rex-swap): change RHS to `useRealCriarRecebedor`
 * once it's defined, OR replace this whole file with the one-line trpc
 * wrapper sketched at the top.
 */
export const useCriarRecebedor = useMockCriarRecebedor;
