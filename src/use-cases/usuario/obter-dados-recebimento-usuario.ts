import { SpanStatusCode } from '@opentelemetry/api';
import type { DadosRecebimentoRepository } from '../../adapters/usuario/dados-recebimento-repository.js';
import type { DadosRecebimentoUsuario } from '../../domain/usuario/entities/dados-recebimento-usuario.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';

export interface ObterDadosRecebimentoUsuarioDeps {
  readonly dadosRecebimentoRepository: DadosRecebimentoRepository;
  readonly observability: Observability;
}

/**
 * Read the caller's user-level receiving data (aperture-mcvyw #4a-i). Returns
 * `undefined` when the user has never saved any (the settings form renders
 * empty, not an error). Auth is NOT enforced here — the tRPC procedure
 * derives `idUsuario` from the session and passes it in.
 */
export async function obterDadosRecebimentoUsuario(
  deps: ObterDadosRecebimentoUsuarioDeps,
  idUsuario: IdUsuario,
): Promise<DadosRecebimentoUsuario | undefined> {
  const { dadosRecebimentoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterDadosRecebimentoUsuario', async (span) => {
    try {
      span.setAttribute('usuario.id', idUsuario);
      const registro = await dadosRecebimentoRepository.findByUsuarioId(idUsuario);
      span.setStatus({ code: SpanStatusCode.OK });
      return registro;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
