import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { RecebedorRepository } from '../../adapters/arrecadacao/recebedor-repository.js';
import {
  campanhaComRecebedorAtivo,
  campanhaPossuiAdministrador,
} from '../../domain/arrecadacao/entities/campanha.js';
import { criarRecebedorInicial } from '../../domain/arrecadacao/entities/recebedor.js';
import { DadosRecebedorSchema } from '../../domain/arrecadacao/value-objects/dados-recebedor.js';
import {
  type IdConta,
  IdContaSchema,
  IdCampanhaSchema,
  type IdRecebedor,
} from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoNaoAutorizadoError } from '../../errors/arrecadacao/nao-autorizado.error.js';
import { ArrecadacaoRecebedorJaExisteError } from '../../errors/arrecadacao/recebedor-ja-existe.error.js';
import type { Observability } from '../../observability/observability.js';
import {
  type ExecutarTransacaoArrecadacao,
  executarTransacaoSequencial,
} from './executar-transacao-arrecadacao.js';

/**
 * Plan: backend half of aperture-kbmel (Solicitar Transferência
 * onboarding embed). Operator opens the painel TransferModal on a
 * campanha that has NO active recebedor; the modal embeds the
 * BancariosBody form; on submit this use-case fires, persists the
 * first recebedor, and the frontend chains the original
 * `solicitarRepasseRecebedor` call.
 *
 * SHARED with the frontend via the `CriarRecebedorParaCampanhaInputSchema`
 * export — Vance scaffolds against the type-only inference
 * (contract-pinning per banked 4-layer-defense memory).
 *
 * Semantics:
 *   - If the campanha already has an active recebedor → throws
 *     `ArrecadacaoRecebedorJaExisteError`. Callers route the user to
 *     the edit (alterar) surface instead.
 *   - If the caller is not an admin of the campanha → throws
 *     `ArrecadacaoNaoAutorizadoError`. The tRPC procedure derives
 *     `idContaCaller` from the session — there is no shape where a
 *     non-admin can target another campanha's recebedor slot.
 *   - On success, persists the new recebedor + updates the campanha's
 *     `idRecebedor` + `dadosRecebedor` snapshot atomically.
 */
export const CriarRecebedorParaCampanhaInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  /**
   * Identity of the caller (their `idConta`), derived from the session by
   * the tRPC procedure. Never accept from the client. Required because
   * the admin guard runs inside this use-case.
   */
  idContaCaller: IdContaSchema,
  dadosRecebedor: DadosRecebedorSchema,
});

export type CriarRecebedorParaCampanhaInput = z.infer<
  typeof CriarRecebedorParaCampanhaInputSchema
>;

export interface CriarRecebedorParaCampanhaDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly recebedorRepository: RecebedorRepository;
  readonly clock: () => Date;
  readonly gerarIdRecebedor?: () => IdRecebedor;
  readonly executarTransacao?: ExecutarTransacaoArrecadacao;
  readonly observability: Observability;
}

export interface CriarRecebedorParaCampanhaResult {
  readonly idRecebedor: IdRecebedor;
}

export async function criarRecebedorParaCampanha(
  deps: CriarRecebedorParaCampanhaDeps,
  input: CriarRecebedorParaCampanhaInput,
): Promise<CriarRecebedorParaCampanhaResult> {
  const {
    campanhaRepository,
    recebedorRepository,
    clock,
    gerarIdRecebedor = randomUUID,
    executarTransacao = executarTransacaoSequencial,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarRecebedorParaCampanha', async (span) => {
    try {
      const parsed = CriarRecebedorParaCampanhaInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idCampanha, idContaCaller, dadosRecebedor } = parsed.data;
      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.recebedor.tipoChavePix', dadosRecebedor.tipoChavePix);

      const campanha = await campanhaRepository.findById(idCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(idCampanha);
      }

      // Admin guard FIRST — checking authorization before existence avoids
      // leaking whether a recebedor exists for a campanha the caller does
      // not own.
      if (!campanhaPossuiAdministrador(campanha, idContaCaller as IdConta)) {
        throw new ArrecadacaoNaoAutorizadoError(
          `Conta ${idContaCaller} nao e administradora da campanha ${idCampanha}`,
        );
      }

      // Slot guard: no overwrites. Edit path is `alterarDadosRecebedorCampanha`.
      const existing = await recebedorRepository.findAtivoByCampanhaId(idCampanha);
      if (existing !== undefined) {
        throw new ArrecadacaoRecebedorJaExisteError(idCampanha);
      }

      const criadaEm = clock();
      const recebedor = criarRecebedorInicial({
        id: gerarIdRecebedor(),
        idCampanha,
        dadosRecebedor,
        criadaEm,
      });
      const campanhaUpdated = campanhaComRecebedorAtivo(campanha, recebedor);

      await executarTransacao(async (ctx) => {
        await recebedorRepository.save(recebedor, ctx);
        await campanhaRepository.save(campanhaUpdated, ctx);
      });

      span.setAttribute('arrecadacao.recebedor.id', recebedor.id);
      logger.info('arrecadacao.recebedor.criado', {
        idCampanha,
        idRecebedor: recebedor.id,
        tipoChavePix: dadosRecebedor.tipoChavePix,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { idRecebedor: recebedor.id };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
