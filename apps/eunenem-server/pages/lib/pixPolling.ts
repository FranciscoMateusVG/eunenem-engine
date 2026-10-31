/** Wall-clock backstop: changing intervals must not lengthen the QR window. */
export function createPixPollingPolicy(now: () => number = Date.now) {
  const deadline = now() + 12 * 60 * 1000;
  let lastRevision = -1;
  let failures = 0;
  return (state: { status?: string; failed?: boolean; revision: number }): number | false => {
    if (['confirmado', 'expirado', 'rejeitado'].includes(state.status ?? '')) return false;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    if (state.revision !== lastRevision) {
      lastRevision = state.revision;
      failures = state.failed ? Math.min(4, failures + 1) : 0;
    }
    const delay = failures ? Math.min(30000, 5000 * 2 ** (failures - 1)) : 5000;
    return Math.min(delay, remaining);
  };
}
