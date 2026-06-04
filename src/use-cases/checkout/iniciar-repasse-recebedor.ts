import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { RecebedorRepository } from '../../adapters/arrecadacao/recebedor-repository.js';
import type { LivroFinanceiroRepository } from '../../adapters/pagamentos/financeiro/livro-repository.js';
import { campanhaTemRecebedor } from '../../domain/arrecadacao/entities/campanha.js';
import {
  IdCampanhaSchema,
  IdPlataformaReferenciaSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { RepasseRecebedor } from '../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { IdRepasseSchema } from '../../domain/pagamentos/financeiro/value-objects/ids.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoRecebedorNaoEncontradoError } from '../../errors/arrecadacao/recebedor-nao-encontrado.error.js';
import { CheckoutCampanhaSemRecebedorError } from '../../errors/checkout/campanha-sem-recebedor.error.js';
import { CheckoutPlataformaMismatchError } from '../../errors/checkout/plataforma-mismatch.error.js';
import type { Observability } from '../../observability/observability.js';
import { solicitarRepasseRecebedor } from '../pagamentos/financeiro/solicitar-repasse-recebedor.js';

/**
 * aperture-s03dr: `amountCents` removed. The repasse now sweeps every
 * currently-disponível lançamento atomically; the snapshot IS the
 * amount. Callers that previously passed `amountCents` should drop it.
 */
export const IniciarRepasseRecebedorInputSchema = z.object({
  idPlataforma: IdPlataformaReferenciaSchema,
  idCampanha: IdCampanhaSchema,
  idRepasse: IdRepasseSchema,
});

export type IniciarRepasseRecebedorInput = z.infer<typeof IniciarRepasseRecebedorInputSchema>;

export interface IniciarRepasseRecebedorDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly recebedorRepository: RecebedorRepository;
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Recebedor encerra o ciclo: solicita o repasse do saldo disponível.
 *
 * Este orquestrador é deliberadamente *fino* — o trabalho pesado (cálculo
 * de saldo + criação do RepasseRecebedor) já vive em
 * `solicitarRepasseRecebedor` no BC Financeiro. O orquestrador adiciona
 * duas pré-validações cross-BC que Financeiro sozinho não consegue fazer:
 *
 *   1. **Plataforma membership**: `campanha.idPlataforma === input.idPlataforma`.
 *      Caso contrário lança `CheckoutPlataformaMismatchError` antes de
 *      qualquer leitura ao Financeiro — bloqueia tentativas cross-tenant.
 *
 *   2. **Recebedor presente na campanha** (TOGETHER invariant): a campanha
 *      precisa ter `idRecebedor + dadosRecebedor` projetados. Se a campanha
 *      foi criada sem Recebedor (lifecycle pré-bank-info), o repasse é
 *      bloqueado com `CheckoutCampanhaSemRecebedorError`. Outras operações
 *      (contribuição, pagamento aprovado) continuam funcionando sem ele.
 *
 *   3. **Recebedor ativo persistido**: defensiva — verifica que existe
 *      uma linha `is_active = true` em `recebedores` para a campanha. Pega
 *      o bug de "repasse pedido para campanha cujo recebedor foi desativado
 *      depois da projeção ter sido lida".
 *
 * Depois delega para `solicitarRepasseRecebedor`, que internamente verifica
 * o saldo disponível e cria o repasse em status `solicitado`.
 */
export async function iniciarRepasseRecebedor(
  deps: IniciarRepasseRecebedorDeps,
  input: IniciarRepasseRecebedorInput,
): Promise<RepasseRecebedor> {
  const {
    campanhaRepository,
    recebedorRepository,
    livroFinanceiroRepository,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('iniciarRepasseRecebedor', async (span) => {
    try {
      const parsed = IniciarRepasseRecebedorInputSchema.parse(input);

      span.setAttribute('checkout.plataforma.id', parsed.idPlataforma);
      span.setAttribute('checkout.campanha.id', parsed.idCampanha);
      span.setAttribute('checkout.repasse.id', parsed.idRepasse);

      // pre-validation 1: plataforma membership
      const campanha = await campanhaRepository.findById(parsed.idCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(parsed.idCampanha);
      }
      if (campanha.idPlataforma !== parsed.idPlataforma) {
        throw new CheckoutPlataformaMismatchError(parsed.idPlataforma, campanha.idPlataforma);
      }

      // pre-validation 2: campanha has a Recebedor projected (TOGETHER invariant)
      if (!campanhaTemRecebedor(campanha)) {
        throw new CheckoutCampanhaSemRecebedorError(parsed.idCampanha);
      }

      // pre-validation 3: active recebedor row still exists in persistence
      const recebedorAtivo = await recebedorRepository.findAtivoByCampanhaId(parsed.idCampanha);
      if (!recebedorAtivo) {
        throw new ArrecadacaoRecebedorNaoEncontradoError(parsed.idCampanha);
      }

      // delegate to Financeiro (sweep + atomic claim)
      const repasse = await solicitarRepasseRecebedor(
        { livroFinanceiroRepository, clock, observability },
        {
          idRepasse: parsed.idRepasse,
          idCampanha: parsed.idCampanha,
        },
      );

      logger.info('checkout.repasse.iniciado', {
        idPlataforma: parsed.idPlataforma,
        idCampanha: parsed.idCampanha,
        idRepasse: repasse.id,
        amountCents: repasse.amountCents,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return repasse;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
