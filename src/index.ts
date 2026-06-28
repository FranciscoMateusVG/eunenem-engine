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
export type { ConviteRepository } from './adapters/evento/convite-repository.js';
export { ConviteRepositoryMemory } from './adapters/evento/convite-repository.memory.js';
export { ConviteRepositoryPostgres } from './adapters/evento/convite-repository.postgres.js';
export type { EventoRepository } from './adapters/evento/evento-repository.js';
export { EventoRepositoryMemory } from './adapters/evento/evento-repository.memory.js';
export { EventoRepositoryPostgres } from './adapters/evento/evento-repository.postgres.js';
export type { ListaDeConvidadosRepository } from './adapters/evento/lista-de-convidados-repository.js';
export { ListaDeConvidadosRepositoryMemory } from './adapters/evento/lista-de-convidados-repository.memory.js';
export { ListaDeConvidadosRepositoryPostgres } from './adapters/evento/lista-de-convidados-repository.postgres.js';
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
export type { LivroFinanceiroRepository } from './adapters/pagamentos/financeiro/livro-repository.js';
export { LivroFinanceiroRepositoryMemory } from './adapters/pagamentos/financeiro/livro-repository.memory.js';
export { LivroFinanceiroRepositoryPostgres } from './adapters/pagamentos/financeiro/livro-repository.postgres.js';
export { PagamentoProviderFake } from './adapters/pagamentos/provider.fake.js';
export type { PagamentoProvider, SolicitarPagamentoInput } from './adapters/pagamentos/provider.js';
export { PagamentoProviderStripe } from './adapters/pagamentos/provider.stripe.js';
export type {
  AdminRecadoRow,
  MuralRecadoProjection,
  PagamentoRepository,
} from './adapters/pagamentos/repository.js';
export { PagamentoRepositoryMemory } from './adapters/pagamentos/repository.memory.js';
export { PagamentoRepositoryPostgres } from './adapters/pagamentos/repository.postgres.js';
export type { PlataformaRepository } from './adapters/plataforma/repository.js';
export {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
  PLATAFORMAS_SEED,
  PlataformaRepositoryMemory,
} from './adapters/plataforma/repository.memory.js';
// aperture-kcasm: object storage — presigned-PUT photo uploads (infra boundary).
export type {
  EmitirUrlUploadInput,
  EmitirUrlUploadItemInput,
  ObjectStorage,
  SlotFoto,
  UrlUploadPresignada,
} from './adapters/storage/object-storage.js';
export { CONTENT_TYPE_EXTENSAO } from './adapters/storage/object-storage.js';
// aperture-lwx2k — shared email transport (magic-link + future transactional).
export type { EmailMessage, EmailTransport } from './adapters/email/email-transport.js';
export type { SmtpConfig } from './adapters/email/email-transport.nodemailer.js';
export { EmailTransportNodemailer } from './adapters/email/email-transport.nodemailer.js';
export { EmailTransportNoop } from './adapters/email/email-transport.noop.js';
export type { UploadRegistrado } from './adapters/storage/object-storage.memory.js';
export { ObjectStorageMemory } from './adapters/storage/object-storage.memory.js';
export type { ObjectStorageMinioConfig } from './adapters/storage/object-storage.minio.js';
export { ObjectStorageMinio } from './adapters/storage/object-storage.minio.js';
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
export type { DadosRecebimentoRepository } from './adapters/usuario/dados-recebimento-repository.js';
export { DadosRecebimentoRepositoryMemory } from './adapters/usuario/dados-recebimento-repository.memory.js';
export { DadosRecebimentoRepositoryPostgres } from './adapters/usuario/dados-recebimento-repository.postgres.js';
export type { PerfilCriadorRepository } from './adapters/usuario/perfil-criador-repository.js';
export { PerfilCriadorRepositoryMemory } from './adapters/usuario/perfil-criador-repository.memory.js';
export { PerfilCriadorRepositoryPostgres } from './adapters/usuario/perfil-criador-repository.postgres.js';
export type { UsuarioRepository } from './adapters/usuario/repository.js';
export { UsuarioRepositoryMemory } from './adapters/usuario/repository.memory.js';
export { UsuarioRepositoryPostgres } from './adapters/usuario/repository.postgres.js';
export type { ResgatePendenteRepository } from './adapters/usuario/resgate-pendente-repository.js';
export { ResgatePendenteRepositoryMemory } from './adapters/usuario/resgate-pendente-repository.memory.js';
export { ResgatePendenteRepositoryPostgres } from './adapters/usuario/resgate-pendente-repository.postgres.js';
export type {
  StripeDispatchResult,
  StripePipelineArgs,
  StripePipelineResult,
} from './adapters/webhook-archive/stripe-webhook-pipeline.js';
export { archiveAndDispatchStripeEvent } from './adapters/webhook-archive/stripe-webhook-pipeline.js';
// aperture-1n6u8: payment webhook event archive (infrastructure boundary).
// aperture-2sp6m: findByPagamentoId + FindByPagamentoIdOptions for admin trail.
export type {
  FindByPagamentoIdOptions,
  SaveReceivedInput,
  SaveReceivedResult,
  WebhookEventArchive,
  WebhookEventRecord,
} from './adapters/webhook-archive/webhook-event-archive.js';
export { PROCESSING_ERROR_MAX_LENGTH } from './adapters/webhook-archive/webhook-event-archive.js';
export { WebhookEventArchiveMemory } from './adapters/webhook-archive/webhook-event-archive.memory.js';
export { WebhookEventArchivePostgres } from './adapters/webhook-archive/webhook-event-archive.postgres.js';
// Pre-existing duplicate block of webhook-archive + stripe-webhook-pipeline
// exports removed here (aperture-aqlv2 cleanup). They live at lines ~26-41
// of this file; a recent merge of the convite/evento/lista-convidados PRs
// double-added them. See PR description for context. Don't re-add without
// removing the canonical copy above first.
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
export type { Contribuicao } from './domain/arrecadacao/entities/contribuicao.js';
// Plan 0015 (aperture-7pqee): `criarContribuicaoDisponivel` was renamed to
// `criarContribuicao` (no status field to qualify). The entity factory is
// NOT re-exported from the barrel to avoid collision with the use-case
// `criarContribuicao`. Adapters/tests that need the factory import it
// directly from the entity module.
export {
  contribuicaoAtualizada,
  LIMITE_CONTRIBUICOES_POR_OPCAO,
  NomeContribuicaoSchema,
} from './domain/arrecadacao/entities/contribuicao.js';
export type { Recebedor } from './domain/arrecadacao/entities/recebedor.js';
export {
  criarNovoRecebedor,
  criarRecebedorInicial,
  desativarRecebedor,
} from './domain/arrecadacao/entities/recebedor.js';
export type {
  DadosRecebedor,
  DadosRecebedorConta,
  DadosRecebedorPix,
  TipoChavePix,
  TipoConta,
} from './domain/arrecadacao/value-objects/dados-recebedor.js';
export {
  cnpjValido,
  cpfValido,
  DadosRecebedorContaSchema,
  DadosRecebedorPixSchema,
  DadosRecebedorSchema,
  mensagemChavePixInvalida,
  TipoChavePixSchema,
  TipoContaSchema,
  telefoneBrValido,
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
// Plan 0015 (aperture-7pqee): DadosContribuinte moved to the Pagamentos BC
// since it now lives on IntencaoPagamento, not on the Contribuição
// aggregate. The arrecadacao path keeps a deprecated re-export for one
// release cycle; consumers should import from the pagamentos path.
export type { DadosContribuinte } from './domain/pagamentos/value-objects/dados-contribuinte.js';
export {
  DadosContribuinteSchema,
  NomeContribuinteSchema,
} from './domain/pagamentos/value-objects/dados-contribuinte.js';

// --- Domain: Cat (placeholder) ---

export type { Cat, CatId, CatName, CreateCatInput } from './domain/cat.js';
export { CatIdSchema, CatNameSchema, CreateCatInputSchema } from './domain/cat.js';

// --- Domain: Evento (supporting) ---

export type {
  AtualizarConviteCampos,
  Convite,
  CriarConviteInput as CriarConviteDominioInput,
} from './domain/evento/entities/convite.js';
export {
  conviteComCamposAtualizados,
  criarConvite as criarConviteDominio,
} from './domain/evento/entities/convite.js';
export type {
  AtualizarEventoCampos,
  CriarEventoInput as CriarEventoDominioInput,
  Evento,
} from './domain/evento/entities/evento.js';
export {
  criarEvento as criarEventoDominio,
  eventoComCamposAtualizados,
  eventoComDataHora,
  eventoComEndereco,
  eventoComModalidade,
  eventoComTipo,
} from './domain/evento/entities/evento.js';
export type {
  AtualizarListaDeConvidadosCampos,
  Convidado,
  CriarListaDeConvidadosInput as CriarListaDeConvidadosDominioInput,
  ListaDeConvidados,
} from './domain/evento/entities/lista-de-convidados.js';
export {
  convidadoComPresencaAtualizada,
  criarListaDeConvidados as criarListaDeConvidadosDominio,
  listaDeConvidadosComCamposAtualizados,
  listaDeConvidadosComPresencaAlterada,
} from './domain/evento/entities/lista-de-convidados.js';
export type { DataHoraEvento } from './domain/evento/value-objects/data-hora-evento.js';
export { DataHoraEventoSchema } from './domain/evento/value-objects/data-hora-evento.js';
export type { EnderecoEvento } from './domain/evento/value-objects/endereco-evento.js';
export {
  EnderecoEventoNullableSchema,
  EnderecoEventoSchema,
} from './domain/evento/value-objects/endereco-evento.js';
export type { FonteConvite } from './domain/evento/value-objects/fonte-convite.js';
export { FonteConviteSchema } from './domain/evento/value-objects/fonte-convite.js';
export type {
  IdCampanha as IdCampanhaEvento,
  IdConvidado,
  IdConvite,
  IdEvento,
  IdListaDeConvidados,
} from './domain/evento/value-objects/ids.js';
export {
  IdCampanhaSchema as IdCampanhaEventoSchema,
  IdConvidadoSchema,
  IdConviteSchema,
  IdEventoSchema,
  IdListaDeConvidadosSchema,
} from './domain/evento/value-objects/ids.js';
export type { ImagemUrlConvite } from './domain/evento/value-objects/imagem-url-convite.js';
export { ImagemUrlConviteSchema } from './domain/evento/value-objects/imagem-url-convite.js';
export type { LinkConfirmacao } from './domain/evento/value-objects/link-confirmacao-lista.js';
export { LinkConfirmacaoSchema } from './domain/evento/value-objects/link-confirmacao-lista.js';
export type { MensagemConvite } from './domain/evento/value-objects/mensagem-convite.js';
export { MensagemConviteSchema } from './domain/evento/value-objects/mensagem-convite.js';
export type { ModalidadeEvento } from './domain/evento/value-objects/modalidade-evento.js';
export { ModalidadeEventoSchema } from './domain/evento/value-objects/modalidade-evento.js';
export type { ModeloConvite } from './domain/evento/value-objects/modelo-convite.js';
export { ModeloConviteSchema } from './domain/evento/value-objects/modelo-convite.js';
export type { NomeConvidado } from './domain/evento/value-objects/nome-convidado.js';
export { NomeConvidadoSchema } from './domain/evento/value-objects/nome-convidado.js';
export type { NomeExibidoConvite } from './domain/evento/value-objects/nome-exibido-convite.js';
export { NomeExibidoConviteSchema } from './domain/evento/value-objects/nome-exibido-convite.js';
export type { NumeroCelularConvidado } from './domain/evento/value-objects/numero-celular-convidado.js';
export { NumeroCelularConvidadoSchema } from './domain/evento/value-objects/numero-celular-convidado.js';
export type { PaletaConvite } from './domain/evento/value-objects/paleta-convite.js';
export { PaletaConviteSchema } from './domain/evento/value-objects/paleta-convite.js';
export type { RemetenteConvite } from './domain/evento/value-objects/remetente-convite.js';
export { RemetenteConviteSchema } from './domain/evento/value-objects/remetente-convite.js';
export type { StatusPresencaConvidado } from './domain/evento/value-objects/status-presenca-convidado.js';
export { StatusPresencaConvidadoSchema } from './domain/evento/value-objects/status-presenca-convidado.js';
export type { TipoEvento } from './domain/evento/value-objects/tipo-evento.js';
export { TipoEventoSchema } from './domain/evento/value-objects/tipo-evento.js';

// --- Domain: Financeiro ---

export type {
  EfeitosFinanceirosPagamentoAprovado,
  IdsLancamentosFinanceirosPorPagamento,
  IdsLancamentosPorItem,
  ItemDoPagamentoFinanceiro,
  LancamentoFinanceiro,
  StatusPagamentoFinanceiro,
  TipoLancamentoFinanceiro,
} from './domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
export {
  criarLancamentosParaPagamentoAprovado,
  LancamentoFinanceiroSchema,
  StatusPagamentoFinanceiroSchema,
  TipoLancamentoFinanceiroSchema,
  validarComposicaoFinanceiraPagamentoAprovado,
} from './domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
export type {
  RepasseRecebedor,
  SolicitacaoRepasse,
  StatusRepasse,
} from './domain/pagamentos/financeiro/entities/repasse-recebedor.js';
export {
  aprovarRepasse,
  criarRepasseRecebedorSolicitado,
  RepasseRecebedorSchema,
  StatusRepasseSchema,
} from './domain/pagamentos/financeiro/entities/repasse-recebedor.js';
export type { DadosRecebedorAtivo } from './domain/pagamentos/financeiro/value-objects/dados-recebedor-ativo.js';
export { DadosRecebedorAtivoSchema } from './domain/pagamentos/financeiro/value-objects/dados-recebedor-ativo.js';
// Plan 0015 (aperture-7pqee): maturation rule removed. Lançamento has no
// FSM; predicted maturation dates replaced by observed transferidoEm /
// canceladoEm columns. See plans/0015-contribuicao-pagamento-financeiro-collapse.md.
export type {
  IdContribuicaoReferencia as IdContribuicaoReferenciaFinanceiro,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
} from './domain/pagamentos/financeiro/value-objects/ids.js';
export {
  IdLancamentoFinanceiroSchema,
  IdPagamentoReferenciaSchema,
  IdRepasseSchema,
} from './domain/pagamentos/financeiro/value-objects/ids.js';
export type { ReceitaPlataforma } from './domain/pagamentos/financeiro/value-objects/receita-plataforma.js';
export {
  calcularReceitaPlataforma,
  ReceitaPlataformaSchema,
} from './domain/pagamentos/financeiro/value-objects/receita-plataforma.js';
export type {
  SaldoCentavos,
  SaldoRecebedor,
} from './domain/pagamentos/financeiro/value-objects/saldo-recebedor.js';
export {
  calcularSaldoRecebedor,
  SaldoCentavosSchema,
  SaldoRecebedorSchema,
} from './domain/pagamentos/financeiro/value-objects/saldo-recebedor.js';
// Plan 0016 (aperture-aj8qw): the single SnapshotComposicaoValoresFinanceiro
// retires; replaced by per-item + aggregate financeiro mirrors below.
export type {
  ResponsavelTaxaFinanceiro,
  SnapshotComposicaoValoresAggregateFinanceiro,
  SnapshotComposicaoValoresItemFinanceiro,
  SnapshotComposicaoValoresItemFinanceiroContribuicao,
  SnapshotComposicaoValoresItemFinanceiroSurcharge,
} from './domain/pagamentos/financeiro/value-objects/snapshot-composicao-valores-financeiro.js';
export {
  ResponsavelTaxaFinanceiroSchema,
  SnapshotComposicaoValoresAggregateFinanceiroSchema,
  SnapshotComposicaoValoresItemFinanceiroContribuicaoSchema,
  SnapshotComposicaoValoresItemFinanceiroSchema,
  SnapshotComposicaoValoresItemFinanceiroSurchargeSchema,
} from './domain/pagamentos/financeiro/value-objects/snapshot-composicao-valores-financeiro.js';

// --- Domain: Money ---

export type { MoneyCents } from './domain/money.js';
export { MoneyCentsSchema } from './domain/money.js';

// --- Domain: Pagamentos ---

// Plan 0016 (aperture-aj8qw): ItemDoPagamento entity inside the
// IntencaoPagamento child of the Pagamento aggregate.
export type {
  ItemDoPagamento,
  ItemDoPagamentoContribuicao,
  ItemDoPagamentoPassthroughSurcharge,
} from './domain/pagamentos/entities/item-do-pagamento.js';
export {
  criarItemContribuicao,
  criarItemPassthroughSurcharge,
  ItemDoPagamentoContribuicaoSchema,
  ItemDoPagamentoPassthroughSurchargeSchema,
  ItemDoPagamentoSchema,
} from './domain/pagamentos/entities/item-do-pagamento.js';
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
  estornarPagamentoAprovado,
  IntencaoPagamentoSchema,
  iniciarProcessamentoPagamento,
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
  IdItemDoPagamento,
  IdPagamento,
  IdTransacaoExterna,
} from './domain/pagamentos/value-objects/ids.js';
export {
  IdContribuicaoPagamentoSchema,
  IdIntencaoPagamentoSchema,
  IdItemDoPagamentoSchema,
  IdPagamentoSchema,
  IdTransacaoExternaSchema,
} from './domain/pagamentos/value-objects/ids.js';
export type { MetodoPagamento } from './domain/pagamentos/value-objects/metodo-pagamento.js';
export { MetodoPagamentoSchema } from './domain/pagamentos/value-objects/metodo-pagamento.js';
// Plan 0016 (aperture-aj8qw): the single SnapshotComposicaoValores VO
// retires; replaced by the per-item + aggregate split below.
export type {
  ResponsavelTaxaPagamento,
  SnapshotComposicaoValoresAggregate,
} from './domain/pagamentos/value-objects/snapshot-composicao-valores-aggregate.js';
export {
  ResponsavelTaxaPagamentoSchema,
  SnapshotComposicaoValoresAggregateSchema,
  validarComposicaoAggregate,
} from './domain/pagamentos/value-objects/snapshot-composicao-valores-aggregate.js';
export type {
  SnapshotComposicaoValoresItem,
  SnapshotComposicaoValoresItemContribuicao,
  SnapshotComposicaoValoresItemSurcharge,
} from './domain/pagamentos/value-objects/snapshot-composicao-valores-item.js';
export {
  SnapshotComposicaoValoresItemContribuicaoSchema,
  SnapshotComposicaoValoresItemSchema,
  SnapshotComposicaoValoresItemSurchargeSchema,
  validarComposicaoItem,
} from './domain/pagamentos/value-objects/snapshot-composicao-valores-item.js';

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
  AtualizarDadosRecebimentoUsuarioInput,
  CriarDadosRecebimentoUsuarioInput,
  DadosRecebimentoUsuario,
} from './domain/usuario/entities/dados-recebimento-usuario.js';
export {
  atualizarDadosRecebimentoUsuario,
  criarDadosRecebimentoUsuario,
} from './domain/usuario/entities/dados-recebimento-usuario.js';
export type {
  AtualizarConteudoPerfilCriadorInput,
  CriarPerfilCriadorInput,
  PerfilCriador,
} from './domain/usuario/entities/perfil-criador.js';
export {
  atualizarConteudoPerfilCriador,
  criarPerfilCriador,
} from './domain/usuario/entities/perfil-criador.js';
export type {
  Conta,
  Usuario,
} from './domain/usuario/entities/usuario.js';
export { contaTemPermissao } from './domain/usuario/entities/usuario.js';
export { deriveSlugBase, slugWithSuffix } from './domain/usuario/slug-derivation.js';
export type { ConteudoPerfilCriador } from './domain/usuario/value-objects/conteudo-perfil-criador.js';
export {
  ConteudoPerfilCriadorSchema,
  conteudoPerfilCriadorVazio,
} from './domain/usuario/value-objects/conteudo-perfil-criador.js';
export type { EmailUsuario } from './domain/usuario/value-objects/email-usuario.js';
export { EmailUsuarioSchema } from './domain/usuario/value-objects/email-usuario.js';
export type {
  IdContaUsuario,
  IdPerfilCriador,
  IdPlataformaReferencia as IdPlataformaReferenciaUsuario,
  IdUsuario,
} from './domain/usuario/value-objects/ids.js';
export {
  IdContaUsuarioSchema,
  IdPerfilCriadorSchema,
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
export type { TipoEventoPerfil } from './domain/usuario/value-objects/tipo-evento-perfil.js';
export { TipoEventoPerfilSchema } from './domain/usuario/value-objects/tipo-evento-perfil.js';
export type { GeneroBebe } from './domain/usuario/value-objects/genero-bebe.js';
export { GeneroBebeSchema } from './domain/usuario/value-objects/genero-bebe.js';
export type { TokenSessao } from './domain/usuario/value-objects/token-sessao.js';
export { TokenSessaoSchema } from './domain/usuario/value-objects/token-sessao.js';

// --- Errors ---

export { ArrecadacaoAdministradorDuplicadoError } from './errors/arrecadacao/administrador-duplicado.error.js';
export { ArrecadacaoAdministradorNaoEncontradoError } from './errors/arrecadacao/administrador-nao-encontrado.error.js';
export { ArrecadacaoCampanhaNaoEncontradaError } from './errors/arrecadacao/campanha-nao-encontrada.error.js';
// Plan 0015 (aperture-ucgok): the ja-disponivel / nao-disponivel errors
// were replaced by a single ContribuicaoIndisponivelError with the
// EXISTS-aprovado-pagamento semantic.
export { ArrecadacaoContribuicaoIndisponivelError } from './errors/arrecadacao/contribuicao-indisponivel.error.js';
export { ArrecadacaoContribuicaoJaExisteError } from './errors/arrecadacao/contribuicao-ja-existe.error.js';
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
export { CheckoutRecebedorNaoPagavelViaPixError } from './errors/checkout/recebedor-nao-pagavel-via-pix.error.js';
export { EventoCampanhaJaTemEventoError } from './errors/evento/campanha-ja-tem-evento.error.js';
export { EventoCampanhaNaoEncontradaError } from './errors/evento/campanha-nao-encontrada.error.js';
export { ConvidadoNaoEncontradoError } from './errors/evento/convidado-nao-encontrado.error.js';
export { ConviteInputInvalidoError } from './errors/evento/convite-input-invalido.error.js';
export { ConviteJaExisteError } from './errors/evento/convite-ja-existe.error.js';
export { ConviteNaoEncontradoError } from './errors/evento/convite-nao-encontrado.error.js';
export { EventoInputInvalidoError } from './errors/evento/input-invalido.error.js';
export { ListaDeConvidadosInputInvalidoError } from './errors/evento/lista-de-convidados-input-invalido.error.js';
export { ListaDeConvidadosJaExisteError } from './errors/evento/lista-de-convidados-ja-existe.error.js';
export { ListaDeConvidadosNaoEncontradaError } from './errors/evento/lista-de-convidados-nao-encontrada.error.js';
export { EventoNaoEncontradoError } from './errors/evento/nao-encontrado.error.js';
export { InvalidCatNameError } from './errors/invalid-cat-name.error.js';
export { FinanceiroInputInvalidoError } from './errors/pagamentos/financeiro/input-invalido.error.js';
export { FinanceiroPagamentoJaRegistradoError } from './errors/pagamentos/financeiro/pagamento-ja-registrado.error.js';
export { FinanceiroPagamentoNaoAprovadoError } from './errors/pagamentos/financeiro/pagamento-nao-aprovado.error.js';
export { FinanceiroSaldoDisponivelInsuficienteError } from './errors/pagamentos/financeiro/saldo-disponivel-insuficiente.error.js';
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

export { ArrecadacaoRecebedorJaExisteError } from './errors/arrecadacao/recebedor-ja-existe.error.js';
// Plan 0016 Phase 2 (aperture-eg1s2): cart-multi-campanha error.
export { CarrinhoMultiplasCampanhasError } from './errors/checkout/carrinho-multiplas-campanhas.error.js';
export { FinanceiroRepasseJaPendenteError } from './errors/pagamentos/financeiro/repasse-ja-pendente.error.js';
export { FinanceiroRepasseNaoEncontradoError } from './errors/pagamentos/financeiro/repasse-nao-encontrado.error.js';
export { FinanceiroRepasseStatusInvalidoError } from './errors/pagamentos/financeiro/repasse-status-invalido.error.js';
export { UsuarioNaoEncontradoError } from './errors/usuario/nao-encontrado.error.js';
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
// aperture-0bynm — recebedor first-time create (backend half of aperture-kbmel).
export type {
  CriarRecebedorParaCampanhaDeps,
  CriarRecebedorParaCampanhaInput,
  CriarRecebedorParaCampanhaResult,
} from './use-cases/arrecadacao/criar-recebedor-para-campanha.js';
export {
  CriarRecebedorParaCampanhaInputSchema,
  criarRecebedorParaCampanha,
} from './use-cases/arrecadacao/criar-recebedor-para-campanha.js';
// Plan 0015 (aperture-7pqee): desassociarContribuinteContribuicao removed.
// No saga compensation needed — there's no claim step to undo. Estorno
// path uses estornar-pagamento (Phase 2).
export type {
  ListarContribuicoesDeOpcaoDeps,
  ListarContribuicoesDeOpcaoInput,
} from './use-cases/arrecadacao/listar-contribuicoes-de-opcao.js';
export {
  ListarContribuicoesDeOpcaoInputSchema,
  listarContribuicoesDeOpcao,
} from './use-cases/arrecadacao/listar-contribuicoes-de-opcao.js';
// Plan 0016 Phase 2 (aperture-eg1s2). Replaces the pre-0016
// contribuicaoEstaIndisponivel binary predicate with the
// quantidadeRestante (count of remaining slots) + esgotada
// (derived boolean) pair. Pure rename per operator review nit C —
// no @deprecated alias for the old name.
export type {
  QuantidadeRestanteDeps,
  QuantidadeRestanteInput,
} from './use-cases/arrecadacao/quantidade-restante.js';
export {
  esgotada,
  QuantidadeRestanteInputSchema,
  quantidadeRestante,
} from './use-cases/arrecadacao/quantidade-restante.js';
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
// Plan 0015 (aperture-ucgok): admin estorno + admin batch transfer.
export type {
  EstornarPagamentoDeps,
  EstornarPagamentoInput,
  EstornarPagamentoResult,
} from './use-cases/checkout/estornar-pagamento.js';
export {
  EstornarPagamentoInputSchema,
  estornarPagamento,
  PagamentoEstornoLancamentoJaTransferidoError,
  PagamentoEstornoRecusadoPeloProvedorError,
} from './use-cases/checkout/estornar-pagamento.js';
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
// Plan 0016 Phase 2 (aperture-eg1s2): saga renamed to multi-item carrinho.
export type {
  IniciarPagamentoCarrinhoDeps,
  IniciarPagamentoCarrinhoInput,
  IniciarPagamentoCarrinhoResult,
} from './use-cases/checkout/iniciar-pagamento-carrinho.js';
export {
  IniciarPagamentoCarrinhoInputSchema,
  iniciarPagamentoCarrinho,
} from './use-cases/checkout/iniciar-pagamento-carrinho.js';
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
export type {
  AlterarPresencaConvidadoDeps,
  AlterarPresencaConvidadoInput,
} from './use-cases/evento/alterar-presenca-convidado.js';
export {
  AlterarPresencaConvidadoInputSchema,
  alterarPresencaConvidado,
} from './use-cases/evento/alterar-presenca-convidado.js';
export type {
  AtualizarConviteDeps,
  AtualizarConviteInput,
} from './use-cases/evento/atualizar-convite.js';
export {
  AtualizarConviteInputSchema,
  atualizarConvite,
} from './use-cases/evento/atualizar-convite.js';
export type {
  AtualizarEventoDeps,
  AtualizarEventoInput,
} from './use-cases/evento/atualizar-evento.js';
export {
  AtualizarEventoInputSchema,
  atualizarEvento,
} from './use-cases/evento/atualizar-evento.js';
export type {
  AtualizarListaDeConvidadosDeps,
  AtualizarListaDeConvidadosInput,
} from './use-cases/evento/atualizar-lista-de-convidados.js';
export {
  AtualizarListaDeConvidadosInputSchema,
  atualizarListaDeConvidados,
} from './use-cases/evento/atualizar-lista-de-convidados.js';
export type { CriarConviteDeps, CriarConviteInput } from './use-cases/evento/criar-convite.js';
export { CriarConviteInputSchema, criarConvite } from './use-cases/evento/criar-convite.js';
export type { CriarEventoDeps, CriarEventoInput } from './use-cases/evento/criar-evento.js';
export { CriarEventoInputSchema, criarEvento } from './use-cases/evento/criar-evento.js';
export type {
  CriarListaDeConvidadosDeps,
  CriarListaDeConvidadosInput,
} from './use-cases/evento/criar-lista-de-convidados.js';
export {
  CriarListaDeConvidadosInputSchema,
  criarListaDeConvidados,
} from './use-cases/evento/criar-lista-de-convidados.js';
export type {
  ObterConvitePorIdDeps,
  ObterConvitePorIdInput,
} from './use-cases/evento/obter-convite-por-id.js';
export {
  ObterConvitePorIdInputSchema,
  obterConvitePorId,
} from './use-cases/evento/obter-convite-por-id.js';
export type {
  ObterConvitePorIdEventoDeps,
  ObterConvitePorIdEventoInput,
} from './use-cases/evento/obter-convite-por-id-evento.js';
export {
  ObterConvitePorIdEventoInputSchema,
  obterConvitePorIdEvento,
} from './use-cases/evento/obter-convite-por-id-evento.js';
export type {
  ObterEventoPorIdDeps,
  ObterEventoPorIdInput,
} from './use-cases/evento/obter-evento-por-id.js';
export {
  ObterEventoPorIdInputSchema,
  obterEventoPorId,
} from './use-cases/evento/obter-evento-por-id.js';
export type {
  ObterEventoPorIdCampanhaDeps,
  ObterEventoPorIdCampanhaInput,
} from './use-cases/evento/obter-evento-por-id-campanha.js';
export {
  ObterEventoPorIdCampanhaInputSchema,
  obterEventoPorIdCampanha,
} from './use-cases/evento/obter-evento-por-id-campanha.js';
export type {
  ObterListaDeConvidadosPorIdDeps,
  ObterListaDeConvidadosPorIdInput,
} from './use-cases/evento/obter-lista-de-convidados-por-id.js';
export {
  ObterListaDeConvidadosPorIdInputSchema,
  obterListaDeConvidadosPorId,
} from './use-cases/evento/obter-lista-de-convidados-por-id.js';
export type {
  ObterListaDeConvidadosPorIdEventoDeps,
  ObterListaDeConvidadosPorIdEventoInput,
} from './use-cases/evento/obter-lista-de-convidados-por-id-evento.js';
export {
  ObterListaDeConvidadosPorIdEventoInputSchema,
  obterListaDeConvidadosPorIdEvento,
} from './use-cases/evento/obter-lista-de-convidados-por-id-evento.js';
// aperture-16wrk — admin mensagens backend (5v766 Phase A). SHARED with
// the frontend (Vance / Phase B) — the schemas + use-case Result types
// are the contract.
export type {
  AdminMensagensResponse,
  AdminRecadoProjection,
} from './use-cases/pagamentos/admin-recado-projection.js';
export {
  AdminMensagensResponseSchema,
  AdminRecadoProjectionSchema,
} from './use-cases/pagamentos/admin-recado-projection.js';
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
  AprovarRepasseRecebedorDeps,
  AprovarRepasseRecebedorInput,
  AprovarRepasseRecebedorOutput,
} from './use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
export {
  AprovarRepasseRecebedorInputSchema,
  aprovarRepasseRecebedor,
} from './use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
export type {
  MarcarLancamentoTransferidoDeps,
  MarcarLancamentoTransferidoInput,
  MarcarLancamentoTransferidoResult,
} from './use-cases/pagamentos/financeiro/marcar-lancamento-transferido.js';
export {
  MarcarLancamentoTransferidoBloqueadoError,
  MarcarLancamentoTransferidoInputSchema,
  marcarLancamentoTransferido,
} from './use-cases/pagamentos/financeiro/marcar-lancamento-transferido.js';
// aperture-led0r: maturation use-case.
export type { ObterReceitaPlataformaDeps } from './use-cases/pagamentos/financeiro/obter-receita-plataforma.js';
export { obterReceitaPlataforma } from './use-cases/pagamentos/financeiro/obter-receita-plataforma.js';
export type {
  ObterSaldoRecebedorDeps,
  ObterSaldoRecebedorInput,
} from './use-cases/pagamentos/financeiro/obter-saldo-recebedor.js';
export {
  ObterSaldoRecebedorInputSchema,
  obterSaldoRecebedor,
} from './use-cases/pagamentos/financeiro/obter-saldo-recebedor.js';
// Plan 0015 (aperture-7pqee): maturarLancamentosPendentes removed.
// Lançamento has no FSM; admin manually marks transferidoEm via the new
// marcar-lancamento-transferido use-case (Phase 2).
export type {
  RegistrarEfeitosFinanceirosPagamentoAprovadoDeps,
  RegistrarEfeitosFinanceirosPagamentoAprovadoInput,
} from './use-cases/pagamentos/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
export {
  RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema,
  registrarEfeitosFinanceirosPagamentoAprovado,
} from './use-cases/pagamentos/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
export type {
  SolicitarRepasseRecebedorDeps,
  SolicitarRepasseRecebedorInput,
} from './use-cases/pagamentos/financeiro/solicitar-repasse-recebedor.js';
export {
  SolicitarRepasseRecebedorInputSchema,
  solicitarRepasseRecebedor,
} from './use-cases/pagamentos/financeiro/solicitar-repasse-recebedor.js';
export type {
  MarcarRecadoComoLidoDeps,
  MarcarRecadoComoLidoResult,
} from './use-cases/pagamentos/marcar-recado-como-lido.js';
export { marcarRecadoComoLido } from './use-cases/pagamentos/marcar-recado-como-lido.js';
export type {
  MarcarTodosRecadosComoLidosDeps,
  MarcarTodosRecadosComoLidosResult,
} from './use-cases/pagamentos/marcar-todos-recados-como-lidos.js';
export { marcarTodosRecadosComoLidos } from './use-cases/pagamentos/marcar-todos-recados-como-lidos.js';
export type {
  ComandoPagamentoInput,
  ObterPagamentoPorIdDeps,
} from './use-cases/pagamentos/obter-pagamento-por-id.js';
export {
  ComandoPagamentoInputSchema,
  obterPagamentoPorId,
} from './use-cases/pagamentos/obter-pagamento-por-id.js';
export type { ObterRecadosAdminDeCampanhaDeps } from './use-cases/pagamentos/obter-recados-admin-de-campanha.js';
export { obterRecadosAdminDeCampanha } from './use-cases/pagamentos/obter-recados-admin-de-campanha.js';
export type { RejeitarPagamentoDeps } from './use-cases/pagamentos/rejeitar-pagamento.js';
export { rejeitarPagamento } from './use-cases/pagamentos/rejeitar-pagamento.js';
// Plan 0016 Phase 2 (aperture-eg1s2): split per-item + cart-wide surcharge.
export type {
  CalcularComposicaoValoresParaItemDeps,
  CalcularComposicaoValoresParaItemInput,
} from './use-cases/taxas/calcular-composicao-valores-para-item.js';
export {
  CalcularComposicaoValoresParaItemInputSchema,
  calcularComposicaoValoresParaItem,
} from './use-cases/taxas/calcular-composicao-valores-para-item.js';
export type {
  CalcularSurchargeParaCarrinhoDeps,
  CalcularSurchargeParaCarrinhoInput,
} from './use-cases/taxas/calcular-surcharge-para-carrinho.js';
export {
  CalcularSurchargeParaCarrinhoInputSchema,
  calcularSurchargeParaCarrinho,
} from './use-cases/taxas/calcular-surcharge-para-carrinho.js';
export type {
  AtualizarPerfilCriadorDeps,
  AtualizarPerfilCriadorInput,
} from './use-cases/usuario/atualizar-perfil-criador.js';
export {
  AtualizarPerfilCriadorInputSchema,
  atualizarPerfilCriador,
} from './use-cases/usuario/atualizar-perfil-criador.js';
export type {
  AtualizarPerfilUsuarioDeps,
  AtualizarPerfilUsuarioInput,
} from './use-cases/usuario/atualizar-perfil-usuario.js';
export {
  AtualizarPerfilUsuarioInputSchema,
  atualizarPerfilUsuario,
} from './use-cases/usuario/atualizar-perfil-usuario.js';
export type {
  AtualizarSlugUsuarioDeps,
  AtualizarSlugUsuarioInput,
} from './use-cases/usuario/atualizar-slug-usuario.js';
export {
  AtualizarSlugUsuarioInputSchema,
  atualizarSlugUsuario,
} from './use-cases/usuario/atualizar-slug-usuario.js';
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
  EmitirUrlUploadFotoDeps,
  EmitirUrlUploadFotoInput,
} from './use-cases/usuario/emitir-url-upload-foto.js';
export {
  EmitirUrlUploadFotoInputSchema,
  emitirUrlUploadFoto,
} from './use-cases/usuario/emitir-url-upload-foto.js';
export type {
  EmitirUrlUploadImagemItemDeps,
  EmitirUrlUploadImagemItemInput,
} from './use-cases/usuario/emitir-url-upload-imagem-item.js';
export {
  EmitirUrlUploadImagemItemInputSchema,
  emitirUrlUploadImagemItem,
} from './use-cases/usuario/emitir-url-upload-imagem-item.js';
export type {
  MarcarResgatePendenteDeps,
  MarcarResgatePendenteInput,
  MarcarResgatePendenteResult,
} from './use-cases/usuario/marcar-resgate-pendente.js';
export {
  MarcarResgatePendenteInputSchema,
  marcarResgatePendente,
} from './use-cases/usuario/marcar-resgate-pendente.js';
export type { MarcarTutorialUsuarioComoCompletadoDeps } from './use-cases/usuario/marcar-tutorial-usuario-como-completado.js';
export { marcarTutorialUsuarioComoCompletado } from './use-cases/usuario/marcar-tutorial-usuario-como-completado.js';
export type { ObterDadosRecebimentoUsuarioDeps } from './use-cases/usuario/obter-dados-recebimento-usuario.js';
export { obterDadosRecebimentoUsuario } from './use-cases/usuario/obter-dados-recebimento-usuario.js';
export type {
  ObterPerfilCriadorDeps,
  PerfilProprioDTO,
} from './use-cases/usuario/obter-perfil-criador.js';
export {
  obterPerfilCriador,
  PerfilProprioDTOSchema,
} from './use-cases/usuario/obter-perfil-criador.js';
export type {
  ObterPerfilPublicoBySlugDeps,
  PerfilPublicoDTO,
} from './use-cases/usuario/obter-perfil-publico-by-slug.js';
export {
  obterPerfilPublicoBySlug,
  PerfilPublicoDTOSchema,
} from './use-cases/usuario/obter-perfil-publico-by-slug.js';
export type { ObterResgatePendenteDeps } from './use-cases/usuario/obter-resgate-pendente.js';
export { obterResgatePendente } from './use-cases/usuario/obter-resgate-pendente.js';
export type { ObterStatusTutorialUsuarioDeps } from './use-cases/usuario/obter-status-tutorial-usuario.js';
export { obterStatusTutorialUsuario } from './use-cases/usuario/obter-status-tutorial-usuario.js';
export type {
  ProvisionarContaUsuarioDominioDeps,
  ProvisionarContaUsuarioDominioInput,
  RegistrarContaUsuarioDeps,
  RegistrarContaUsuarioInput,
  RegistrarContaUsuarioResult,
} from './use-cases/usuario/registrar-conta-usuario.js';
export {
  ProvisionarContaUsuarioDominioInputSchema,
  provisionarContaUsuarioDominio,
  RegistrarContaUsuarioInputSchema,
  registrarContaUsuario,
} from './use-cases/usuario/registrar-conta-usuario.js';
export type {
  SalvarDadosRecebimentoUsuarioDeps,
  SalvarDadosRecebimentoUsuarioInput,
} from './use-cases/usuario/salvar-dados-recebimento-usuario.js';
export {
  SalvarDadosRecebimentoUsuarioInputSchema,
  salvarDadosRecebimentoUsuario,
} from './use-cases/usuario/salvar-dados-recebimento-usuario.js';
// Plan 0018 Phase A (aperture-omswg) — first-time tutorial.
export type { TutorialStatusResponse } from './use-cases/usuario/tutorial-status-response.js';
export { TutorialStatusResponseSchema } from './use-cases/usuario/tutorial-status-response.js';
export type {
  VerificarDisponibilidadeSlugDeps,
  VerificarDisponibilidadeSlugInput,
  VerificarDisponibilidadeSlugResult,
} from './use-cases/usuario/verificar-disponibilidade-slug.js';
export {
  VerificarDisponibilidadeSlugInputSchema,
  verificarDisponibilidadeSlug,
} from './use-cases/usuario/verificar-disponibilidade-slug.js';
