import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { DadosRecebimentoRepository } from '../../adapters/usuario/dados-recebimento-repository.js';
import { DadosRecebedorSchema } from '../../domain/arrecadacao/value-objects/dados-recebedor.js';
import {
  atualizarDadosRecebimentoUsuario,
  criarDadosRecebimentoUsuario,
  type DadosRecebimentoUsuario,
} from '../../domain/usuario/entities/dados-recebimento-usuario.js';
import { IdUsuarioSchema } from '../../domain/usuario/value-objects/ids.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Input for the user-level receiving-data save (aperture-mcvyw #4a-i). The
 * `dados` payload is the full `DadosRecebedor` discriminated union — pix or
 * conta. Validation goes through the same VO schema as Arrecadação's
 * Recebedor (single source of truth for CPF/CNPJ checksum, PIX-key-by-type,
 * phone, bank-account format).
 */
export const SalvarDadosRecebimentoUsuarioInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  dados: DadosRecebedorSchema,
});

export type SalvarDadosRecebimentoUsuarioInput = z.infer<
  typeof SalvarDadosRecebimentoUsuarioInputSchema
>;

export interface SalvarDadosRecebimentoUsuarioDeps {
  readonly dadosRecebimentoRepository: DadosRecebimentoRepository;
  readonly observability: Observability;
  readonly clock: () => Date;
}

/**
 * Create-or-update the caller's receiving data (1:1 with Usuario). Auth is NOT
 * enforced here — the tRPC procedure derives `idUsuario` from the session and
 * passes it in (keeps the use-case unit-testable). Invalid `dados` →
 * `UsuarioInputInvalidoError` (mapped to BAD_REQUEST by the router).
 *
 * PROJECTION (aperture-mcvyw): receiving data should ALSO be projected onto
 * the user's active-campaign Recebedor (via `alterarDadosRecebedorCampanha`)
 * when one exists. That wiring is NOT done here — see the TODO at the call
 * site / report. The standalone store is fully functional without it.
 */
export async function salvarDadosRecebimentoUsuario(
  deps: SalvarDadosRecebimentoUsuarioDeps,
  input: SalvarDadosRecebimentoUsuarioInput,
): Promise<DadosRecebimentoUsuario> {
  const { dadosRecebimentoRepository, observability, clock } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('salvarDadosRecebimentoUsuario', async (span) => {
    try {
      const parsed = SalvarDadosRecebimentoUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const { idUsuario, dados } = parsed.data;
      span.setAttribute('usuario.id', idUsuario);
      span.setAttribute('usuario.dados_recebimento.metodo', dados.metodo);

      const now = clock();
      const existing = await dadosRecebimentoRepository.findByUsuarioId(idUsuario);
      const registro = existing
        ? atualizarDadosRecebimentoUsuario(existing, { dados, atualizadoEm: now })
        : criarDadosRecebimentoUsuario({ idUsuario, dados, atualizadoEm: now });

      await dadosRecebimentoRepository.save(registro);

      logger.info('usuario.dados_recebimento.salvo', {
        idUsuario,
        metodo: dados.metodo,
        criado: !existing,
      });
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
