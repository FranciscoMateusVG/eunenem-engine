// aperture-6wl0f — loading/error gate for the painel dashboard's data queries.
// meuAcesso is part of it: a failed permission read must show the error state
// with a retry, never a dashboard filtered down to "no permissions".

export interface ConsultaDashboard {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly refetch: () => unknown;
}

export function estadoDadosDashboard(consultas: {
  acesso: ConsultaDashboard;
  summary: ConsultaDashboard;
  convidados: ConsultaDashboard;
  lista: ConsultaDashboard;
}): { loading: boolean; failed: boolean; retry: () => void } {
  const todas = Object.values(consultas);
  return {
    loading: todas.some((c) => c.isLoading),
    failed: todas.some((c) => Boolean(c.error)),
    retry: () => {
      for (const c of todas) if (c.error) void c.refetch();
    },
  };
}
