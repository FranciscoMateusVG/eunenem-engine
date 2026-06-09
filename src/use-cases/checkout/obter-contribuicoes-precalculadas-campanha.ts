import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { ProvedorRegraTaxa } from '../../adapters/taxas/regra-provider.js';
import type { Campanha } from '../../domain/arrecadacao/entities/campanha.js';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  IdCampanhaSchema,
  type IdContribuicao,
  type IdOpcaoContribuicao,
  type IdPlataformaReferencia,
  IdPlataformaReferenciaSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type {
  OpcaoContribuicao,
  TipoOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/opcao-contribuicao.js';
import type { IdContribuicaoPagamento } from '../../domain/pagamentos/value-objects/ids.js';
import { obterTarifaPorTipo } from '../../domain/taxas/entities/regra-taxa.js';
import {
  type ComposicaoValores,
  calcularComposicaoValores,
} from '../../domain/taxas/value-objects/composicao-valores.js';
import type { TipoOpcaoContribuicaoReferencia } from '../../domain/taxas/value-objects/tarifa-tipo.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import { CheckoutPlataformaMismatchError } from '../../errors/checkout/plataforma-mismatch.error.js';
import type { Observability } from '../../observability/observability.js';

export const ObterContribuicoesPrecalculadasCampanhaInputSchema = z.object({
  idPlataforma: IdPlataformaReferenciaSchema,
  idCampanha: IdCampanhaSchema,
});

export type ObterContribuicoesPrecalculadasCampanhaInput = z.infer<
  typeof ObterContribuicoesPrecalculadasCampanhaInputSchema
>;

export interface ContribuicaoPrecalculada {
  readonly idContribuicao: IdContribuicao;
  readonly nome: string;
  readonly imagemUrl: string | null;
  readonly grupo: string | null;
  readonly valorContribuicaoCents: number;
  readonly disponivel: boolean;
  readonly composicao: ComposicaoValores;
}

export interface OpcaoComContribuicoes {
  readonly idOpcao: IdOpcaoContribuicao;
  readonly tipo: TipoOpcaoContribuicao;
  readonly contribuicoes: readonly ContribuicaoPrecalculada[];
}

export interface ContribuicoesPrecalculadasCampanha {
  readonly idPlataforma: IdPlataformaReferencia;
  readonly idCampanha: Campanha['id'];
  readonly tituloCampanha: string;
  readonly opcoes: readonly OpcaoComContribuicoes[];
}

export interface ObterContribuicoesPrecalculadasCampanhaDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  // Plan 0015 (aperture-ucgok): the `disponivel` flag is now a derived
  // predicate from the EXISTS-aprovado-pagamento query, batched over
  // the campanha's contribuicoes in a single round-trip.
  readonly pagamentoRepository: PagamentoRepository;
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly observability: Observability;
}

/**
 * Application-service orchestrator: monta a vista pre-calculada das opções
 * de uma campanha — para cada Contribuição, calcula `ComposicaoValores`
 * usando a `RegraTaxa` da plataforma e a `TarifaTipo` correspondente ao
 * tipo da opção. Read-only; nenhum side-effect.
 *
 * Cross-tenant guard: o `idPlataforma` do input precisa bater com o
 * `idPlataforma` da Campanha carregada; mismatch lança
 * `CheckoutPlataformaMismatchError`.
 */
export async function obterContribuicoesPrecalculadasCampanha(
  deps: ObterContribuicoesPrecalculadasCampanhaDeps,
  input: ObterContribuicoesPrecalculadasCampanhaInput,
): Promise<ContribuicoesPrecalculadasCampanha> {
  const {
    campanhaRepository,
    contribuicaoRepository,
    pagamentoRepository,
    provedorRegraTaxa,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('obterContribuicoesPrecalculadasCampanha', async (span) => {
    try {
      const parsed = ObterContribuicoesPrecalculadasCampanhaInputSchema.parse(input);

      span.setAttribute('checkout.plataforma.id', parsed.idPlataforma);
      span.setAttribute('checkout.campanha.id', parsed.idCampanha);

      const campanha = await campanhaRepository.findById(parsed.idCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(parsed.idCampanha);
      }

      if (campanha.idPlataforma !== parsed.idPlataforma) {
        throw new CheckoutPlataformaMismatchError(parsed.idPlataforma, campanha.idPlataforma);
      }

      const [contribuicoes, regraTaxa] = await Promise.all([
        contribuicaoRepository.findByCampanhaId(campanha.id),
        provedorRegraTaxa.getRegraAtiva(parsed.idPlataforma),
      ]);

      span.setAttribute('checkout.contribuicoes.count', contribuicoes.length);
      span.setAttribute('checkout.opcoes.count', campanha.opcoes.length);

      // Plan 0015 (aperture-ucgok): batch-resolve the disponivel
      // predicate. One indexed Pagamento query for the whole campanha
      // instead of N EXISTS calls.
      const idsIndisponiveis = await pagamentoRepository.findIdsContribuicoesComPagamentoAprovado(
        contribuicoes.map((c) => c.id as unknown as IdContribuicaoPagamento),
      );
      const indisponiveisSet = new Set<string>(idsIndisponiveis);

      const contribuicoesPorOpcao = groupContribuicoesPorOpcao(contribuicoes);

      const opcoes: OpcaoComContribuicoes[] = campanha.opcoes.map((opcao) =>
        buildOpcaoComContribuicoes(
          opcao,
          contribuicoesPorOpcao.get(opcao.id) ?? [],
          regraTaxa,
          indisponiveisSet,
        ),
      );

      const primeiraOrfa = findPrimeiraContribuicaoOrfa(contribuicoes, campanha.opcoes);
      if (primeiraOrfa) {
        throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(
          campanha.id,
          primeiraOrfa.idOpcaoContribuicao,
        );
      }

      logger.info('checkout.contribuicoes.precalculadas', {
        idPlataforma: parsed.idPlataforma,
        idCampanha: parsed.idCampanha,
        opcoesCount: opcoes.length,
        contribuicoesCount: contribuicoes.length,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return {
        idPlataforma: parsed.idPlataforma,
        idCampanha: campanha.id,
        tituloCampanha: campanha.titulo,
        opcoes,
      };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });

  function buildOpcaoComContribuicoes(
    opcao: OpcaoContribuicao,
    contribuicoesDaOpcao: readonly Contribuicao[],
    regraTaxa: Parameters<typeof obterTarifaPorTipo>[0],
    indisponiveisSet: ReadonlySet<string>,
  ): OpcaoComContribuicoes {
    const tarifa = obterTarifaPorTipo(regraTaxa, opcao.tipo as TipoOpcaoContribuicaoReferencia);
    return {
      idOpcao: opcao.id,
      tipo: opcao.tipo,
      contribuicoes: contribuicoesDaOpcao.map((c) => ({
        idContribuicao: c.id,
        nome: c.nome,
        imagemUrl: c.imagemUrl,
        grupo: c.grupo,
        valorContribuicaoCents: c.valor,
        // Plan 0015 (aperture-ucgok): disponivel is the negation of
        // "EXISTS aprovado pagamento for this slot."
        disponivel: !indisponiveisSet.has(c.id),
        composicao: calcularComposicaoValores(tarifa, {
          idContribuicao: c.id,
          contributionAmountCents: c.valor,
        }),
      })),
    };
  }
}

function groupContribuicoesPorOpcao(
  contribuicoes: readonly Contribuicao[],
): Map<IdOpcaoContribuicao, Contribuicao[]> {
  const groups = new Map<IdOpcaoContribuicao, Contribuicao[]>();
  for (const c of contribuicoes) {
    const list = groups.get(c.idOpcaoContribuicao);
    if (list) {
      list.push(c);
    } else {
      groups.set(c.idOpcaoContribuicao, [c]);
    }
  }
  return groups;
}

function findPrimeiraContribuicaoOrfa(
  contribuicoes: readonly Contribuicao[],
  opcoes: readonly OpcaoContribuicao[],
): Contribuicao | undefined {
  const opcaoIds = new Set(opcoes.map((o) => o.id));
  return contribuicoes.find((c) => !opcaoIds.has(c.idOpcaoContribuicao));
}
