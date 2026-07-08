import { SpanStatusCode } from '@opentelemetry/api';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { IdCampanha, IdContribuicao } from '../../domain/arrecadacao/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';
import type { AdminMensagensResponse } from './admin-recado-projection.js';

/**
 * aperture-16wrk / 5v766 Phase A — admin mensagens list read.
 *
 * Two adapter calls, both indexed:
 *   1. `pagamentoRepository.findRecadosAdminByCampanha(idCampanha)` —
 *      the aprovado-with-mensagem rows on the campanha + their
 *      `lidaEm` + value + first-contribuição id.
 *   2. `contribuicaoRepository.findByCampanhaId(idCampanha)` — the
 *      full contribuição set for the campanha; one round-trip.
 *
 * Decoration is in-process: build a Map<IdContribuicao, nome>, then
 * map raw rows → wire projection. Stable iteration order (newest
 * recado first) is preserved from the adapter.
 *
 * Counts (`todas` / `naoLidas`) are derived from the same row set —
 * no separate aggregate query, no race window between count + list.
 *
 * Auth: NOT enforced here. The caller (tRPC procedure) MUST resolve
 * the slug → campanha and verify the session user is an admin BEFORE
 * calling this. The use-case is tenant-shape: it answers ONLY for
 * the given `idCampanha`.
 */
export interface ObterRecadosAdminDeCampanhaDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly observability: Observability;
}

export async function obterRecadosAdminDeCampanha(
  deps: ObterRecadosAdminDeCampanhaDeps,
  idCampanha: IdCampanha,
): Promise<AdminMensagensResponse> {
  const { pagamentoRepository, contribuicaoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterRecadosAdminDeCampanha', async (span) => {
    try {
      span.setAttribute('arrecadacao.campanha.id', idCampanha);

      const [rows, contribuicoes] = await Promise.all([
        pagamentoRepository.findRecadosAdminByCampanha(idCampanha),
        contribuicaoRepository.findByCampanhaId(idCampanha),
      ]);

      const nomeByContribuicao = new Map<IdContribuicao, string>();
      for (const c of contribuicoes) {
        nomeByContribuicao.set(c.id, c.nome);
      }

      const recados = rows.map((row) => ({
        idPagamento: row.idPagamento as unknown as string,
        contribuinteNome: row.contribuinteNome,
        mensagem: row.mensagem,
        criadoEm: row.criadoEm.toISOString(),
        lidaEm: row.lidaEm === null ? null : row.lidaEm.toISOString(),
        valorContribuicaoCents: row.valorContribuicaoCents,
        contribuicaoNome:
          row.idPrimeiraContribuicao === null
            ? null
            : (nomeByContribuicao.get(row.idPrimeiraContribuicao) ?? null),
      }));

      const todas = recados.length;
      const naoLidas = recados.reduce((acc, r) => acc + (r.lidaEm === null ? 1 : 0), 0);

      span.setAttribute('arrecadacao.mensagens.todas', todas);
      span.setAttribute('arrecadacao.mensagens.naoLidas', naoLidas);
      span.setStatus({ code: SpanStatusCode.OK });
      return { recados, counts: { todas, naoLidas } };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
