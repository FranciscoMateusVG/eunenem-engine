// --- Domain ---

export type { CampanhaRepository } from './adapters/arrecadacao/campanha-repository.js';
export { CampanhaRepositoryMemory } from './adapters/arrecadacao/campanha-repository.memory.js';
export type { ContribuicaoRepository } from './adapters/arrecadacao/contribuicao-repository.js';
export { ContribuicaoRepositoryMemory } from './adapters/arrecadacao/contribuicao-repository.memory.js';
// --- Adapter Interfaces (public contract — implement your own) ---
export type { CatRepository } from './adapters/cat-repository.js';
export type { Database } from './adapters/database.js';
// --- Database utilities ---
export { createDatabase } from './adapters/database.js';
export type { LivroFinanceiroRepository } from './adapters/financeiro/livro-repository.js';
export { LivroFinanceiroRepositoryMemory } from './adapters/financeiro/livro-repository.memory.js';
export type { PagamentoEventPublisher } from './adapters/pagamentos/event-publisher.js';
export { PagamentoEventPublisherMemory } from './adapters/pagamentos/event-publisher.memory.js';
export { PagamentoProviderFake } from './adapters/pagamentos/provider.fake.js';
export type { PagamentoProvider, SolicitarPagamentoInput } from './adapters/pagamentos/provider.js';
export type { PagamentoRepository } from './adapters/pagamentos/repository.js';
export { PagamentoRepositoryMemory } from './adapters/pagamentos/repository.memory.js';
export type { ProvedorRegraTaxa } from './adapters/taxas/regra-provider.js';
export { ProvedorRegraTaxaMemory } from './adapters/taxas/regra-provider.memory.js';
export type { UsuarioRepository } from './adapters/usuario/repository.js';
export { UsuarioRepositoryMemory } from './adapters/usuario/repository.memory.js';
export type { SessaoUsuarioRepository } from './adapters/usuario/sessao-repository.js';
export { SessaoUsuarioRepositoryMemory } from './adapters/usuario/sessao-repository.memory.js';
export type {
  AdicionarAdministradorCampanhaInput,
  AdicionarOpcaoContribuicaoInput,
  Campanha,
  CriarCampanhaInput,
  IdCampanha,
  IdConta,
  IdOpcaoContribuicao,
  IdRecebedor,
  OpcaoContribuicao,
  RemoverAdministradorCampanhaInput,
} from './domain/arrecadacao/campanha.js';
export {
  AdicionarAdministradorCampanhaInputSchema,
  AdicionarOpcaoContribuicaoInputSchema,
  CriarCampanhaInputSchema,
  campanhaComAdministrador,
  campanhaComOpcao,
  campanhaPossuiAdministrador,
  campanhaSemAdministrador,
  encontrarOpcaoContribuicao,
  IdCampanhaSchema,
  IdContaSchema,
  IdOpcaoContribuicaoSchema,
  IdRecebedorSchema,
  IdsAdministradoresSchema,
  OpcaoContribuicaoSchema,
  RemoverAdministradorCampanhaInputSchema,
} from './domain/arrecadacao/campanha.js';
export type {
  Contribuicao,
  CriarContribuicaoInput,
  DadosContribuinte,
  IdContribuicao,
  StatusContribuicao,
} from './domain/arrecadacao/contribuicao.js';
export {
  CriarContribuicaoInputSchema,
  DadosContribuinteSchema,
  IdContribuicaoSchema,
  NomeExibicaoContribuinteSchema,
} from './domain/arrecadacao/contribuicao.js';
export type { Cat, CatId, CatName, CreateCatInput } from './domain/cat.js';
export { CatIdSchema, CatNameSchema, CreateCatInputSchema } from './domain/cat.js';
export type {
  IdContribuicaoReferencia as IdContribuicaoReferenciaFinanceiro,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRecebedorFinanceiro,
  IdRepasse,
  LancamentoFinanceiro,
  ObterSaldoRecebedorInput,
  ReceitaPlataforma,
  RegistrarEfeitosFinanceirosPagamentoAprovadoInput,
  RepasseRecebedor,
  SaldoCentavos,
  SaldoRecebedor,
  SnapshotComposicaoValoresFinanceiro,
  SolicitarRepasseRecebedorInput,
  StatusLancamento,
  StatusPagamentoFinanceiro,
  StatusRepasse,
  TipoLancamentoFinanceiro,
} from './domain/financeiro/financeiro.js';
export {
  calcularReceitaPlataforma,
  calcularSaldoRecebedor,
  criarLancamentosParaPagamentoAprovado,
  criarRepasseRecebedorSolicitado,
  IdLancamentoFinanceiroSchema,
  IdPagamentoReferenciaSchema,
  IdRecebedorFinanceiroSchema,
  IdRepasseSchema,
  IdsLancamentosFinanceirosSchema,
  LancamentoFinanceiroSchema,
  ObterSaldoRecebedorInputSchema,
  ReceitaPlataformaSchema,
  RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema,
  RepasseRecebedorSchema,
  SaldoCentavosSchema,
  SaldoRecebedorSchema,
  SnapshotComposicaoValoresFinanceiroSchema,
  SolicitarRepasseRecebedorInputSchema,
  StatusLancamentoSchema,
  StatusPagamentoFinanceiroSchema,
  StatusRepasseSchema,
  TipoLancamentoFinanceiroSchema,
  validarComposicaoFinanceiraPagamentoAprovado,
} from './domain/financeiro/financeiro.js';
export type { MoneyCents } from './domain/money.js';
export { MoneyCentsSchema } from './domain/money.js';
export type {
  ComandoPagamentoInput,
  CriarIntencaoPagamentoInput,
  CriarPagamentoPendenteInput,
  EventoPagamento,
  IdContribuicaoPagamento,
  IdIntencaoPagamento,
  IdPagamento,
  IdTransacaoExterna,
  IntencaoPagamento,
  MetodoPagamento,
  NomeProvedorPagamento,
  Pagamento,
  SnapshotComposicaoValores,
  StatusPagamento,
  StatusTransacaoExterna,
  TipoEventoPagamento,
  TransacaoExterna,
} from './domain/pagamentos/pagamentos.js';
export {
  aprovarPagamentoPendente,
  ComandoPagamentoInputSchema,
  CriarIntencaoPagamentoInputSchema,
  criarEventoPagamento,
  criarPagamentoPendente,
  EventoPagamentoSchema,
  IdContribuicaoPagamentoSchema,
  IdIntencaoPagamentoSchema,
  IdPagamentoSchema,
  IdTransacaoExternaSchema,
  IntencaoPagamentoSchema,
  MetodoPagamentoSchema,
  NomeProvedorPagamentoSchema,
  PagamentoSchema,
  podeAprovarPagamento,
  podeRejeitarPagamento,
  rejeitarPagamentoPendente,
  SnapshotComposicaoValoresSchema,
  StatusPagamentoSchema,
  StatusTransacaoExternaSchema,
  TipoEventoPagamentoSchema,
  TransacaoExternaSchema,
} from './domain/pagamentos/pagamentos.js';
export type {
  CalcularComposicaoValoresInput,
  CalculoTaxa,
  ComposicaoValores,
  IdContribuicaoReferencia,
  PercentualTaxaBps,
  RegraTaxa,
  ResponsavelTaxa,
} from './domain/taxas/taxas.js';
export {
  CalcularComposicaoValoresInputSchema,
  calcularComposicaoValores as calcularComposicaoValoresDominio,
  calcularTaxa,
  calcularValorTaxaPercentual,
  comporComposicaoValores,
  DEFAULT_FEE_PERCENTAGE_BPS,
  IdContribuicaoReferenciaSchema,
  PercentualTaxaBpsSchema,
  REGRA_TAXA_PADRAO,
  RegraTaxaSchema,
  ResponsavelTaxaSchema,
} from './domain/taxas/taxas.js';
export type {
  AtualizarPerfilUsuarioInput,
  AutorizarPermissaoUsuarioInput,
  Conta,
  CredencialSimulada,
  CriarSessaoUsuarioInput,
  EmailUsuario,
  IdContaUsuario,
  IdUsuario,
  NomeExibicaoUsuario,
  Permissao,
  RegistrarContaUsuarioInput,
  SenhaSimulada,
  Sessao,
  TokenSessao,
  Usuario,
} from './domain/usuario/usuario.js';
export {
  AtualizarPerfilUsuarioInputSchema,
  AutorizarPermissaoUsuarioInputSchema,
  CriarSessaoUsuarioInputSchema,
  contaTemPermissao,
  EmailUsuarioSchema,
  IdContaUsuarioSchema,
  IdUsuarioSchema,
  NomeExibicaoUsuarioSchema,
  PERMISSOES_PADRAO,
  PermissaoSchema,
  RegistrarContaUsuarioInputSchema,
  SenhaSimuladaSchema,
  sessaoExpirada,
  TokenSessaoSchema,
} from './domain/usuario/usuario.js';

// --- Errors ---
export { ArrecadacaoAdministradorDuplicadoError } from './errors/arrecadacao/administrador-duplicado.error.js';
export { ArrecadacaoAdministradorNaoEncontradoError } from './errors/arrecadacao/administrador-nao-encontrado.error.js';
export { ArrecadacaoCampanhaNaoEncontradaError } from './errors/arrecadacao/campanha-nao-encontrada.error.js';
export { ArrecadacaoContribuicaoJaExisteError } from './errors/arrecadacao/contribuicao-ja-existe.error.js';
export { ArrecadacaoInputInvalidoError } from './errors/arrecadacao/input-invalido.error.js';
export { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from './errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
export { ArrecadacaoOpcaoIdDuplicadoError } from './errors/arrecadacao/opcao-id-duplicado.error.js';
export { ArrecadacaoUltimoAdministradorError } from './errors/arrecadacao/ultimo-administrador.error.js';
export { CatAlreadyExistsError } from './errors/cat-already-exists.error.js';
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
export { TaxasInputInvalidoError } from './errors/taxas/input-invalido.error.js';
export { UsuarioEmailJaExisteError } from './errors/usuario/email-ja-existe.error.js';
export { UsuarioInputInvalidoError } from './errors/usuario/input-invalido.error.js';
export { UsuarioNaoAutorizadoError } from './errors/usuario/nao-autorizado.error.js';
export { UsuarioSessaoInvalidaError } from './errors/usuario/sessao-invalida.error.js';
export { ConsoleLogger } from './observability/console-logger.js';
// --- Observability ---
export type { Logger } from './observability/logger.js';
export { NoopLogger } from './observability/noop-logger.js';
export type { Observability } from './observability/observability.js';
export { OtelLogger } from './observability/otel-logger.js';
export type { Span, Tracer } from './observability/tracer.js';
export { noopTracer, SpanKind, SpanStatusCode, trace } from './observability/tracer.js';
// --- Use Cases ---
export type { AdicionarAdministradorCampanhaDeps } from './use-cases/arrecadacao/adicionar-administrador-campanha.js';
export { adicionarAdministradorCampanha } from './use-cases/arrecadacao/adicionar-administrador-campanha.js';
export type { AdicionarOpcaoContribuicaoDeps } from './use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
export { adicionarOpcaoContribuicao } from './use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
export type { CriarCampanhaDeps } from './use-cases/arrecadacao/criar-campanha.js';
export { criarCampanha } from './use-cases/arrecadacao/criar-campanha.js';
export type { CriarContribuicaoDeps } from './use-cases/arrecadacao/criar-contribuicao.js';
export { criarContribuicao } from './use-cases/arrecadacao/criar-contribuicao.js';
export type { RemoverAdministradorCampanhaDeps } from './use-cases/arrecadacao/remover-administrador-campanha.js';
export { removerAdministradorCampanha } from './use-cases/arrecadacao/remover-administrador-campanha.js';
export type { CreateCatDeps } from './use-cases/create-cat.js';
export { createCat } from './use-cases/create-cat.js';
export type { ObterReceitaPlataformaDeps } from './use-cases/financeiro/obter-receita-plataforma.js';
export { obterReceitaPlataforma } from './use-cases/financeiro/obter-receita-plataforma.js';
export type { ObterSaldoRecebedorDeps } from './use-cases/financeiro/obter-saldo-recebedor.js';
export { obterSaldoRecebedor } from './use-cases/financeiro/obter-saldo-recebedor.js';
export type { RegistrarEfeitosFinanceirosPagamentoAprovadoDeps } from './use-cases/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
export { registrarEfeitosFinanceirosPagamentoAprovado } from './use-cases/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
export type { SolicitarRepasseRecebedorDeps } from './use-cases/financeiro/solicitar-repasse-recebedor.js';
export { solicitarRepasseRecebedor } from './use-cases/financeiro/solicitar-repasse-recebedor.js';
export type { AprovarPagamentoDeps } from './use-cases/pagamentos/aprovar-pagamento.js';
export { aprovarPagamento } from './use-cases/pagamentos/aprovar-pagamento.js';
export type { CriarIntencaoPagamentoDeps } from './use-cases/pagamentos/criar-intencao-pagamento.js';
export { criarIntencaoPagamento } from './use-cases/pagamentos/criar-intencao-pagamento.js';
export type { ObterPagamentoPorIdDeps } from './use-cases/pagamentos/obter-pagamento-por-id.js';
export { obterPagamentoPorId } from './use-cases/pagamentos/obter-pagamento-por-id.js';
export type { RejeitarPagamentoDeps } from './use-cases/pagamentos/rejeitar-pagamento.js';
export { rejeitarPagamento } from './use-cases/pagamentos/rejeitar-pagamento.js';
export type { CalcularComposicaoValoresDeps } from './use-cases/taxas/calcular-composicao-valores.js';
export { calcularComposicaoValores } from './use-cases/taxas/calcular-composicao-valores.js';
export type { AtualizarPerfilUsuarioDeps } from './use-cases/usuario/atualizar-perfil-usuario.js';
export { atualizarPerfilUsuario } from './use-cases/usuario/atualizar-perfil-usuario.js';
export type { AutorizarPermissaoUsuarioDeps } from './use-cases/usuario/autorizar-permissao-usuario.js';
export { autorizarPermissaoUsuario } from './use-cases/usuario/autorizar-permissao-usuario.js';
export type { CriarSessaoUsuarioDeps } from './use-cases/usuario/criar-sessao-usuario.js';
export { criarSessaoUsuario } from './use-cases/usuario/criar-sessao-usuario.js';
export type {
  RegistrarContaUsuarioDeps,
  RegistrarContaUsuarioResult,
} from './use-cases/usuario/registrar-conta-usuario.js';
export { registrarContaUsuario } from './use-cases/usuario/registrar-conta-usuario.js';
