// --- Adapter Interfaces & Implementations ---

export type { CampanhaRepository } from './adapters/arrecadacao/campanha-repository.js';
export { CampanhaRepositoryMemory } from './adapters/arrecadacao/campanha-repository.memory.js';
export { CampanhaRepositoryPostgres } from './adapters/arrecadacao/campanha-repository.postgres.js';
export type { ContribuicaoRepository } from './adapters/arrecadacao/contribuicao-repository.js';
export { ContribuicaoRepositoryMemory } from './adapters/arrecadacao/contribuicao-repository.memory.js';
export { ContribuicaoRepositoryPostgres } from './adapters/arrecadacao/contribuicao-repository.postgres.js';
export type { RecebedorRepository } from './adapters/arrecadacao/recebedor-repository.js';
export { RecebedorRepositoryMemory } from './adapters/arrecadacao/recebedor-repository.memory.js';
export { RecebedorRepositoryPostgres } from './adapters/arrecadacao/recebedor-repository.postgres.js';
export type { CatRepository } from './adapters/cat-repository.js';
export type { Database } from './adapters/database.js';
export { createDatabase } from './adapters/database.js';
export type { LivroFinanceiroRepository } from './adapters/financeiro/livro-repository.js';
export { LivroFinanceiroRepositoryMemory } from './adapters/financeiro/livro-repository.memory.js';
export {
  computeCardSurchargeCents,
  STRIPE_CARD_FIXED_CENTS,
  STRIPE_CARD_RATE,
  SURCHARGE_LINE_ITEM_NAME,
} from './adapters/pagamentos/card-surcharge.js';
export type {
  CheckoutSessionProvider,
  CriarSessaoCheckoutInput,
  CriarSessaoCheckoutResult,
  ObterSessaoCheckoutResult,
} from './adapters/pagamentos/checkout-session-provider.js';
export type { PagamentoEventPublisher } from './adapters/pagamentos/event-publisher.js';
export { PagamentoEventPublisherMemory } from './adapters/pagamentos/event-publisher.memory.js';
export { PagamentoProviderFake } from './adapters/pagamentos/provider.fake.js';
export type { PagamentoProvider, SolicitarPagamentoInput } from './adapters/pagamentos/provider.js';
export { PagamentoProviderStripe } from './adapters/pagamentos/provider.stripe.js';
export type { PagamentoRepository } from './adapters/pagamentos/repository.js';
export { PagamentoRepositoryMemory } from './adapters/pagamentos/repository.memory.js';
export { PagamentoRepositoryPostgres } from './adapters/pagamentos/repository.postgres.js';
export type { PlataformaRepository } from './adapters/plataforma/repository.js';
export {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
  PLATAFORMAS_SEED,
  PlataformaRepositoryMemory,
} from './adapters/plataforma/repository.memory.js';
export type { ProvedorRegraTaxa } from './adapters/taxas/regra-provider.js';
export {
  ProvedorRegraTaxaMemory,
  REGRAS_TAXA_SEED,
} from './adapters/taxas/regra-provider.memory.js';
export { AuthServiceBetterAuth } from './adapters/usuario/auth-service.better-auth.js';
export type { AuthService } from './adapters/usuario/auth-service.js';
export { AuthServiceMemoria } from './adapters/usuario/auth-service.memory.js';
export type { Auth, CriarAuthConfig } from './adapters/usuario/criar-auth.js';
export { criarAuth } from './adapters/usuario/criar-auth.js';
export type { UsuarioRepository } from './adapters/usuario/repository.js';
export { UsuarioRepositoryMemory } from './adapters/usuario/repository.memory.js';
export { UsuarioRepositoryPostgres } from './adapters/usuario/repository.postgres.js';
export { hashClientPII } from './observability/hash-client-pii.js';

// --- Domain: Arrecadação ---

export type { Campanha } from './domain/arrecadacao/entities/campanha.js';
export {
  campanhaComAdministrador,
  campanhaComOpcao,
  campanhaComRecebedorAtivo,
  campanhaComRecebedorInicial,
  campanhaPossuiAdministrador,
  campanhaSemAdministrador,
  campanhaSemRecebedor,
  campanhaTemRecebedor,
  criarCampanhaSemRecebedor,
  encontrarOpcaoContribuicao,
} from './domain/arrecadacao/entities/campanha.js';
export type {
  Contribuicao,
  StatusContribuicao,
} from './domain/arrecadacao/entities/contribuicao.js';
export {
  contribuicaoAtualizada,
  contribuicaoComContribuinte,
  contribuicaoComValor,
  contribuicaoDisponivel,
  contribuicaoSemContribuinte,
  criarContribuicaoDisponivel,
  NomeContribuicaoSchema,
  StatusContribuicaoSchema,
} from './domain/arrecadacao/entities/contribuicao.js';
export type { Recebedor } from './domain/arrecadacao/entities/recebedor.js';
export {
  criarNovoRecebedor,
  criarRecebedorInicial,
  desativarRecebedor,
} from './domain/arrecadacao/entities/recebedor.js';
export type { DadosContribuinte } from './domain/arrecadacao/value-objects/dados-contribuinte.js';
export {
  DadosContribuinteSchema,
  NomeContribuinteSchema,
} from './domain/arrecadacao/value-objects/dados-contribuinte.js';
export type {
  DadosRecebedor,
  TipoChavePix,
} from './domain/arrecadacao/value-objects/dados-recebedor.js';
export {
  DadosRecebedorSchema,
  TipoChavePixSchema,
} from './domain/arrecadacao/value-objects/dados-recebedor.js';
export type {
  IdCampanha,
  IdConta,
  IdContribuicao,
  IdOpcaoContribuicao,
  IdPlataformaReferencia as IdPlataformaReferenciaArrecadacao,
  IdRecebedor,
} from './domain/arrecadacao/value-objects/ids.js';
export {
  IdCampanhaSchema,
  IdContaSchema,
  IdContribuicaoSchema,
  IdOpcaoContribuicaoSchema,
  IdPlataformaReferenciaSchema as IdPlataformaReferenciaArrecadacaoSchema,
  IdRecebedorSchema,
} from './domain/arrecadacao/value-objects/ids.js';
export { IdsAdministradoresSchema } from './domain/arrecadacao/value-objects/ids-administradores.js';
export type {
  OpcaoContribuicao,
  TipoOpcaoContribuicao,
} from './domain/arrecadacao/value-objects/opcao-contribuicao.js';
export {
  OpcaoContribuicaoSchema,
  TipoOpcaoContribuicaoSchema,
} from './domain/arrecadacao/value-objects/opcao-contribuicao.js';

// --- Domain: Cat (placeholder) ---

export type { Cat, CatId, CatName, CreateCatInput } from './domain/cat.js';
export { CatIdSchema, CatNameSchema, CreateCatInputSchema } from './domain/cat.js';

// --- Domain: Financeiro ---

export type {
  EfeitosFinanceirosPagamentoAprovado,
  IdsLancamentosFinanceiros,
  LancamentoFinanceiro,
  StatusLancamento,
  StatusPagamentoFinanceiro,
  TipoLancamentoFinanceiro,
} from './domain/financeiro/entities/lancamento-financeiro.js';
export {
  criarLancamentosParaPagamentoAprovado,
  IdsLancamentosFinanceirosSchema,
  LancamentoFinanceiroSchema,
  StatusLancamentoSchema,
  StatusPagamentoFinanceiroSchema,
  TipoLancamentoFinanceiroSchema,
  validarComposicaoFinanceiraPagamentoAprovado,
} from './domain/financeiro/entities/lancamento-financeiro.js';
export type {
  RepasseRecebedor,
  SolicitacaoRepasse,
  StatusRepasse,
} from './domain/financeiro/entities/repasse-recebedor.js';
export {
  criarRepasseRecebedorSolicitado,
  RepasseRecebedorSchema,
  StatusRepasseSchema,
} from './domain/financeiro/entities/repasse-recebedor.js';
export type { DadosRecebedorAtivo } from './domain/financeiro/value-objects/dados-recebedor-ativo.js';
export { DadosRecebedorAtivoSchema } from './domain/financeiro/value-objects/dados-recebedor-ativo.js';
export type {
  IdContribuicaoReferencia as IdContribuicaoReferenciaFinanceiro,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
} from './domain/financeiro/value-objects/ids.js';
export {
  IdLancamentoFinanceiroSchema,
  IdPagamentoReferenciaSchema,
  IdRepasseSchema,
} from './domain/financeiro/value-objects/ids.js';
export type { ReceitaPlataforma } from './domain/financeiro/value-objects/receita-plataforma.js';
export {
  calcularReceitaPlataforma,
  ReceitaPlataformaSchema,
} from './domain/financeiro/value-objects/receita-plataforma.js';
export type {
  SaldoCentavos,
  SaldoRecebedor,
} from './domain/financeiro/value-objects/saldo-recebedor.js';
export {
  calcularSaldoRecebedor,
  SaldoCentavosSchema,
  SaldoRecebedorSchema,
} from './domain/financeiro/value-objects/saldo-recebedor.js';
export type { SnapshotComposicaoValoresFinanceiro } from './domain/financeiro/value-objects/snapshot-composicao-valores-financeiro.js';
export { SnapshotComposicaoValoresFinanceiroSchema } from './domain/financeiro/value-objects/snapshot-composicao-valores-financeiro.js';

// --- Domain: Money ---

export type { MoneyCents } from './domain/money.js';
export { MoneyCentsSchema } from './domain/money.js';

// --- Domain: Pagamentos ---

export type {
  CriarPagamentoPendenteInput,
  IntencaoPagamento,
  Pagamento,
  StatusPagamento,
  StatusTransacaoExterna,
  TransacaoExterna,
} from './domain/pagamentos/entities/pagamento.js';
export {
  aprovarPagamentoPendente,
  criarEventoPagamento,
  criarPagamentoPendente,
  IntencaoPagamentoSchema,
  PagamentoSchema,
  podeAprovarPagamento,
  podeRejeitarPagamento,
  rejeitarPagamentoPendente,
  StatusPagamentoSchema,
  StatusTransacaoExternaSchema,
  TransacaoExternaSchema,
} from './domain/pagamentos/entities/pagamento.js';
export type {
  EventoPagamento,
  NomeProvedorPagamento,
  TipoEventoPagamento,
} from './domain/pagamentos/value-objects/evento-pagamento.js';
export {
  EventoPagamentoSchema,
  NomeProvedorPagamentoSchema,
  TipoEventoPagamentoSchema,
} from './domain/pagamentos/value-objects/evento-pagamento.js';
export type {
  IdContribuicaoPagamento,
  IdIntencaoPagamento,
  IdPagamento,
  IdTransacaoExterna,
} from './domain/pagamentos/value-objects/ids.js';
export {
  IdContribuicaoPagamentoSchema,
  IdIntencaoPagamentoSchema,
  IdPagamentoSchema,
  IdTransacaoExternaSchema,
} from './domain/pagamentos/value-objects/ids.js';
export type { MetodoPagamento } from './domain/pagamentos/value-objects/metodo-pagamento.js';
export { MetodoPagamentoSchema } from './domain/pagamentos/value-objects/metodo-pagamento.js';
export type { SnapshotComposicaoValores } from './domain/pagamentos/value-objects/snapshot-composicao-valores.js';
export { SnapshotComposicaoValoresSchema } from './domain/pagamentos/value-objects/snapshot-composicao-valores.js';

// --- Domain: Plataforma ---

export type {
  CriarPlataformaInput,
  Plataforma,
} from './domain/plataforma/entities/plataforma.js';
export { criarPlataforma } from './domain/plataforma/entities/plataforma.js';
export type { IdPlataforma } from './domain/plataforma/value-objects/ids.js';
export { IdPlataformaSchema } from './domain/plataforma/value-objects/ids.js';
export type { SlugPlataforma } from './domain/plataforma/value-objects/slug-plataforma.js';
export { SlugPlataformaSchema } from './domain/plataforma/value-objects/slug-plataforma.js';

// --- Domain: Taxas ---

export type {
  CriarRegraTaxaInput,
  RegraTaxa,
} from './domain/taxas/entities/regra-taxa.js';
export {
  criarRegraTaxa,
  obterTarifaPorTipo,
  RegraTaxaSchema,
} from './domain/taxas/entities/regra-taxa.js';
export type {
  CalculoTaxa,
  DadosCalculoTaxa,
} from './domain/taxas/value-objects/calculo-taxa.js';
export {
  calcularTaxa,
  calcularValorTaxaPercentual,
} from './domain/taxas/value-objects/calculo-taxa.js';
export type { ComposicaoValores } from './domain/taxas/value-objects/composicao-valores.js';
export {
  calcularComposicaoValores as calcularComposicaoValoresDominio,
  comporComposicaoValores,
} from './domain/taxas/value-objects/composicao-valores.js';
export type {
  IdContribuicaoReferencia,
  IdPlataformaReferencia as IdPlataformaReferenciaTaxas,
  IdRegraTaxa,
} from './domain/taxas/value-objects/ids.js';
export {
  IdContribuicaoReferenciaSchema,
  IdPlataformaReferenciaSchema as IdPlataformaReferenciaTaxasSchema,
  IdRegraTaxaSchema,
} from './domain/taxas/value-objects/ids.js';
export type {
  PercentualTaxaBps,
  ResponsavelTaxa,
  TarifaTipo,
  TipoOpcaoContribuicaoReferencia,
} from './domain/taxas/value-objects/tarifa-tipo.js';
export {
  PercentualTaxaBpsSchema,
  ResponsavelTaxaSchema,
  TarifaTipoSchema,
  TipoOpcaoContribuicaoReferenciaSchema,
} from './domain/taxas/value-objects/tarifa-tipo.js';

// --- Domain: Usuário ---

export type {
  Conta,
  Usuario,
} from './domain/usuario/entities/usuario.js';
export { contaTemPermissao } from './domain/usuario/entities/usuario.js';
export { deriveSlugBase, slugWithSuffix } from './domain/usuario/slug-derivation.js';
export type { EmailUsuario } from './domain/usuario/value-objects/email-usuario.js';
export { EmailUsuarioSchema } from './domain/usuario/value-objects/email-usuario.js';
export type {
  IdContaUsuario,
  IdPlataformaReferencia as IdPlataformaReferenciaUsuario,
  IdUsuario,
} from './domain/usuario/value-objects/ids.js';
export {
  IdContaUsuarioSchema,
  IdPlataformaReferenciaSchema as IdPlataformaReferenciaUsuarioSchema,
  IdUsuarioSchema,
} from './domain/usuario/value-objects/ids.js';
export type { NomeExibicaoUsuario } from './domain/usuario/value-objects/nome-exibicao-usuario.js';
export { NomeExibicaoUsuarioSchema } from './domain/usuario/value-objects/nome-exibicao-usuario.js';
export type { Permissao } from './domain/usuario/value-objects/permissao.js';
export { PERMISSOES_PADRAO, PermissaoSchema } from './domain/usuario/value-objects/permissao.js';
export type { SlugUsuario } from './domain/usuario/value-objects/slug-usuario.js';
export {
  SLUG_USUARIO_REGEX,
  SlugUsuarioSchema,
} from './domain/usuario/value-objects/slug-usuario.js';
export type { TokenSessao } from './domain/usuario/value-objects/token-sessao.js';
export { TokenSessaoSchema } from './domain/usuario/value-objects/token-sessao.js';

// --- Errors ---

export { ArrecadacaoAdministradorDuplicadoError } from './errors/arrecadacao/administrador-duplicado.error.js';
export { ArrecadacaoAdministradorNaoEncontradoError } from './errors/arrecadacao/administrador-nao-encontrado.error.js';
export { ArrecadacaoCampanhaNaoEncontradaError } from './errors/arrecadacao/campanha-nao-encontrada.error.js';
export { ArrecadacaoContribuicaoJaDisponivelError } from './errors/arrecadacao/contribuicao-ja-disponivel.error.js';
export { ArrecadacaoContribuicaoJaExisteError } from './errors/arrecadacao/contribuicao-ja-existe.error.js';
export { ArrecadacaoContribuicaoNaoDisponivelError } from './errors/arrecadacao/contribuicao-nao-disponivel.error.js';
export { ArrecadacaoContribuicaoNaoEncontradaError } from './errors/arrecadacao/contribuicao-nao-encontrada.error.js';
export { ArrecadacaoInputInvalidoError } from './errors/arrecadacao/input-invalido.error.js';
export { ArrecadacaoLimiteOpcaoExcedidoError } from './errors/arrecadacao/limite-opcao-excedido.error.js';
export { ArrecadacaoNaoAutorizadoError } from './errors/arrecadacao/nao-autorizado.error.js';
export { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from './errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
export { ArrecadacaoOpcaoIdDuplicadoError } from './errors/arrecadacao/opcao-id-duplicado.error.js';
export { ArrecadacaoPlataformaNaoEncontradaError } from './errors/arrecadacao/plataforma-nao-encontrada.error.js';
export { ArrecadacaoRecebedorNaoEncontradoError } from './errors/arrecadacao/recebedor-nao-encontrado.error.js';
export { ArrecadacaoUltimoAdministradorError } from './errors/arrecadacao/ultimo-administrador.error.js';
export { CatAlreadyExistsError } from './errors/cat-already-exists.error.js';
export { CheckoutCampanhaSemRecebedorError } from './errors/checkout/campanha-sem-recebedor.error.js';
export { CheckoutPlataformaMismatchError } from './errors/checkout/plataforma-mismatch.error.js';
export { FinanceiroInputInvalidoError } from './errors/financeiro/input-invalido.error.js';
export { FinanceiroPagamentoJaRegistradoError } from './errors/financeiro/pagamento-ja-registrado.error.js';
export { FinanceiroPagamentoNaoAprovadoError } from './errors/financeiro/pagamento-nao-aprovado.error.js';
export { FinanceiroSaldoDisponivelInsuficienteError } from './errors/financeiro/saldo-disponivel-insuficiente.error.js';
export { InvalidCatNameError } from './errors/invalid-cat-name.error.js';
export { PagamentosInputInvalidoError } from './errors/pagamentos/input-invalido.error.js';
export { PagamentoJaExisteError } from './errors/pagamentos/ja-existe.error.js';
export { PagamentoNaoEncontradoError } from './errors/pagamentos/nao-encontrado.error.js';
export { PagamentoTransicaoStatusInvalidaError } from './errors/pagamentos/transicao-status-invalida.error.js';
export { PagamentoValorDivergenteError } from './errors/pagamentos/valor-divergente.error.js';
export { PlataformaNaoEncontradaError } from './errors/plataforma/nao-encontrada.error.js';
export { TaxasInputInvalidoError } from './errors/taxas/input-invalido.error.js';
export { RegraTaxaNaoEncontradaError } from './errors/taxas/regra-nao-encontrada.error.js';
export { UsuarioEmailJaExisteError } from './errors/usuario/email-ja-existe.error.js';
export { UsuarioInputInvalidoError } from './errors/usuario/input-invalido.error.js';
export { UsuarioNaoAutorizadoError } from './errors/usuario/nao-autorizado.error.js';
export { UsuarioPlataformaNaoEncontradaError } from './errors/usuario/plataforma-nao-encontrada.error.js';
export { UsuarioSessaoInvalidaError } from './errors/usuario/sessao-invalida.error.js';
export { UsuarioSlugJaExisteError } from './errors/usuario/slug-ja-existe.error.js';

// --- Observability ---

export { ConsoleLogger } from './observability/console-logger.js';
export type { Logger } from './observability/logger.js';
export { NoopLogger } from './observability/noop-logger.js';
export type { Observability } from './observability/observability.js';
export { OtelLogger } from './observability/otel-logger.js';
export type { Span, Tracer } from './observability/tracer.js';
export { noopTracer, SpanKind, SpanStatusCode, trace } from './observability/tracer.js';

// --- Use Cases ---

export type {
  AdicionarAdministradorCampanhaDeps,
  AdicionarAdministradorCampanhaInput,
} from './use-cases/arrecadacao/adicionar-administrador-campanha.js';
export {
  AdicionarAdministradorCampanhaInputSchema,
  adicionarAdministradorCampanha,
} from './use-cases/arrecadacao/adicionar-administrador-campanha.js';
export type {
  AdicionarOpcaoContribuicaoDeps,
  AdicionarOpcaoContribuicaoInput,
} from './use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
export {
  AdicionarOpcaoContribuicaoInputSchema,
  adicionarOpcaoContribuicao,
} from './use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
export type {
  AlterarDadosRecebedorCampanhaDeps,
  AlterarDadosRecebedorCampanhaInput,
} from './use-cases/arrecadacao/alterar-dados-recebedor-campanha.js';
export {
  AlterarDadosRecebedorCampanhaInputSchema,
  alterarDadosRecebedorCampanha,
} from './use-cases/arrecadacao/alterar-dados-recebedor-campanha.js';
export type {
  AlterarValorContribuicaoDeps,
  AlterarValorContribuicaoInput,
} from './use-cases/arrecadacao/alterar-valor-contribuicao.js';
export {
  AlterarValorContribuicaoInputSchema,
  alterarValorContribuicao,
} from './use-cases/arrecadacao/alterar-valor-contribuicao.js';
export type {
  AssociarContribuinteContribuicaoDeps,
  AssociarContribuinteContribuicaoInput,
} from './use-cases/arrecadacao/associar-contribuinte-contribuicao.js';
export {
  AssociarContribuinteContribuicaoInputSchema,
  associarContribuinteContribuicao,
} from './use-cases/arrecadacao/associar-contribuinte-contribuicao.js';
export type {
  AtualizarContribuicaoDeps,
  AtualizarContribuicaoInput,
} from './use-cases/arrecadacao/atualizar-contribuicao.js';
export {
  AtualizarContribuicaoInputSchema,
  atualizarContribuicao,
} from './use-cases/arrecadacao/atualizar-contribuicao.js';
export type {
  CriarCampanhaDeps,
  CriarCampanhaInput,
} from './use-cases/arrecadacao/criar-campanha.js';
export {
  CriarCampanhaInputSchema,
  criarCampanha,
} from './use-cases/arrecadacao/criar-campanha.js';
export type {
  CriarContribuicaoDeps,
  CriarContribuicaoInput,
} from './use-cases/arrecadacao/criar-contribuicao.js';
export {
  CriarContribuicaoInputSchema,
  criarContribuicao,
} from './use-cases/arrecadacao/criar-contribuicao.js';
export type {
  CriarContribuicoesEmLoteDeps,
  CriarContribuicoesEmLoteInput,
  CriarContribuicoesEmLoteResult,
  ItemLote,
} from './use-cases/arrecadacao/criar-contribuicoes-em-lote.js';
export {
  CriarContribuicoesEmLoteInputSchema,
  criarContribuicoesEmLote,
  ItemLoteSchema,
} from './use-cases/arrecadacao/criar-contribuicoes-em-lote.js';
export type {
  DesassociarContribuinteContribuicaoDeps,
  DesassociarContribuinteContribuicaoInput,
} from './use-cases/arrecadacao/desassociar-contribuinte-contribuicao.js';
export {
  DesassociarContribuinteContribuicaoInputSchema,
  desassociarContribuinteContribuicao,
} from './use-cases/arrecadacao/desassociar-contribuinte-contribuicao.js';
export type {
  ListarContribuicoesDeOpcaoDeps,
  ListarContribuicoesDeOpcaoInput,
} from './use-cases/arrecadacao/listar-contribuicoes-de-opcao.js';
export {
  ListarContribuicoesDeOpcaoInputSchema,
  listarContribuicoesDeOpcao,
} from './use-cases/arrecadacao/listar-contribuicoes-de-opcao.js';
export type {
  RemoverAdministradorCampanhaDeps,
  RemoverAdministradorCampanhaInput,
} from './use-cases/arrecadacao/remover-administrador-campanha.js';
export {
  RemoverAdministradorCampanhaInputSchema,
  removerAdministradorCampanha,
} from './use-cases/arrecadacao/remover-administrador-campanha.js';
export type {
  RemoverContribuicaoDeps,
  RemoverContribuicaoInput,
} from './use-cases/arrecadacao/remover-contribuicao.js';
export {
  RemoverContribuicaoInputSchema,
  removerContribuicao,
} from './use-cases/arrecadacao/remover-contribuicao.js';
export type {
  FinalizarPagamentoAprovadoDeps,
  FinalizarPagamentoAprovadoInput,
  FinalizarPagamentoAprovadoResult,
} from './use-cases/checkout/finalizar-pagamento-aprovado.js';
export {
  FinalizarPagamentoAprovadoInputSchema,
  finalizarPagamentoAprovado,
} from './use-cases/checkout/finalizar-pagamento-aprovado.js';
export type {
  FinalizarPagamentoRejeitadoDeps,
  FinalizarPagamentoRejeitadoInput,
  FinalizarPagamentoRejeitadoResult,
} from './use-cases/checkout/finalizar-pagamento-rejeitado.js';
export {
  FinalizarPagamentoRejeitadoInputSchema,
  finalizarPagamentoRejeitado,
} from './use-cases/checkout/finalizar-pagamento-rejeitado.js';
export type {
  IniciarPagamentoContribuicaoDeps,
  IniciarPagamentoContribuicaoInput,
  IniciarPagamentoContribuicaoResult,
} from './use-cases/checkout/iniciar-pagamento-contribuicao.js';
export {
  IniciarPagamentoContribuicaoInputSchema,
  iniciarPagamentoContribuicao,
} from './use-cases/checkout/iniciar-pagamento-contribuicao.js';
export type {
  IniciarRepasseRecebedorDeps,
  IniciarRepasseRecebedorInput,
} from './use-cases/checkout/iniciar-repasse-recebedor.js';
export {
  IniciarRepasseRecebedorInputSchema,
  iniciarRepasseRecebedor,
} from './use-cases/checkout/iniciar-repasse-recebedor.js';
export type {
  ContribuicaoPrecalculada,
  ContribuicoesPrecalculadasCampanha,
  ObterContribuicoesPrecalculadasCampanhaDeps,
  ObterContribuicoesPrecalculadasCampanhaInput,
  OpcaoComContribuicoes,
} from './use-cases/checkout/obter-contribuicoes-precalculadas-campanha.js';
export {
  ObterContribuicoesPrecalculadasCampanhaInputSchema,
  obterContribuicoesPrecalculadasCampanha,
} from './use-cases/checkout/obter-contribuicoes-precalculadas-campanha.js';
export type { CreateCatDeps } from './use-cases/create-cat.js';
export { createCat } from './use-cases/create-cat.js';
export type { ObterReceitaPlataformaDeps } from './use-cases/financeiro/obter-receita-plataforma.js';
export { obterReceitaPlataforma } from './use-cases/financeiro/obter-receita-plataforma.js';
export type {
  ObterSaldoRecebedorDeps,
  ObterSaldoRecebedorInput,
} from './use-cases/financeiro/obter-saldo-recebedor.js';
export {
  ObterSaldoRecebedorInputSchema,
  obterSaldoRecebedor,
} from './use-cases/financeiro/obter-saldo-recebedor.js';
export type {
  RegistrarEfeitosFinanceirosPagamentoAprovadoDeps,
  RegistrarEfeitosFinanceirosPagamentoAprovadoInput,
} from './use-cases/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
export {
  RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema,
  registrarEfeitosFinanceirosPagamentoAprovado,
} from './use-cases/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
export type {
  SolicitarRepasseRecebedorDeps,
  SolicitarRepasseRecebedorInput,
} from './use-cases/financeiro/solicitar-repasse-recebedor.js';
export {
  SolicitarRepasseRecebedorInputSchema,
  solicitarRepasseRecebedor,
} from './use-cases/financeiro/solicitar-repasse-recebedor.js';
export type { AprovarPagamentoDeps } from './use-cases/pagamentos/aprovar-pagamento.js';
export { aprovarPagamento } from './use-cases/pagamentos/aprovar-pagamento.js';
export type {
  CriarIntencaoPagamentoDeps,
  CriarIntencaoPagamentoInput,
} from './use-cases/pagamentos/criar-intencao-pagamento.js';
export {
  CriarIntencaoPagamentoInputSchema,
  criarIntencaoPagamento,
} from './use-cases/pagamentos/criar-intencao-pagamento.js';
export type {
  ComandoPagamentoInput,
  ObterPagamentoPorIdDeps,
} from './use-cases/pagamentos/obter-pagamento-por-id.js';
export {
  ComandoPagamentoInputSchema,
  obterPagamentoPorId,
} from './use-cases/pagamentos/obter-pagamento-por-id.js';
export type { RejeitarPagamentoDeps } from './use-cases/pagamentos/rejeitar-pagamento.js';
export { rejeitarPagamento } from './use-cases/pagamentos/rejeitar-pagamento.js';
export type {
  CalcularComposicaoValoresDeps,
  CalcularComposicaoValoresInput,
} from './use-cases/taxas/calcular-composicao-valores.js';
export {
  CalcularComposicaoValoresInputSchema,
  calcularComposicaoValores,
} from './use-cases/taxas/calcular-composicao-valores.js';
export type {
  AtualizarPerfilUsuarioDeps,
  AtualizarPerfilUsuarioInput,
} from './use-cases/usuario/atualizar-perfil-usuario.js';
export {
  AtualizarPerfilUsuarioInputSchema,
  atualizarPerfilUsuario,
} from './use-cases/usuario/atualizar-perfil-usuario.js';
export type {
  AutorizarPermissaoUsuarioDeps,
  AutorizarPermissaoUsuarioInput,
} from './use-cases/usuario/autorizar-permissao-usuario.js';
export {
  AutorizarPermissaoUsuarioInputSchema,
  autorizarPermissaoUsuario,
} from './use-cases/usuario/autorizar-permissao-usuario.js';
export type {
  CriarSessaoUsuarioDeps,
  CriarSessaoUsuarioInput,
  CriarSessaoUsuarioResult,
} from './use-cases/usuario/criar-sessao-usuario.js';
export {
  CriarSessaoUsuarioInputSchema,
  criarSessaoUsuario,
} from './use-cases/usuario/criar-sessao-usuario.js';
export type {
  RegistrarContaUsuarioDeps,
  RegistrarContaUsuarioInput,
  RegistrarContaUsuarioResult,
} from './use-cases/usuario/registrar-conta-usuario.js';
export {
  RegistrarContaUsuarioInputSchema,
  registrarContaUsuario,
} from './use-cases/usuario/registrar-conta-usuario.js';
