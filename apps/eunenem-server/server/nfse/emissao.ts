import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql, type Updateable } from 'kysely';
import type { NfseEmissoes } from '../../../../src/adapters/db-types.generated.js';
import type { Database } from '../../../../src/adapters/database.js';
import { assinarDps, assinarPedidoEvento, carregarCertificado, type MaterialCertificado } from './assinatura.js';
import type { NfseConfig } from './config.js';
import { dhEmiSaoPaulo, montarDpsXml, montarIdDps, type TipoAmbiente } from './dps.js';
import { montarPedidoCancelamento, type MotivoCancelamento, TIPO_EVENTO_CANCELAMENTO } from './evento.js';
import { montarPlanoEmissao, type NotaFixada, type NotaPlanejada, type PlanoEmissao } from './plano-emissao.js';
import { carregarPreviaMensal, montarDpsDaNota } from './previa-mensal.js';
import { type ClienteSefin, type ErroSefin, extrairDadosNfse } from './sefin-cliente.js';

/**
 * Emissão REAL da NFS-e mensal no Sistema Nacional (aperture-wp6j6).
 *
 * Só roda por ação explícita do admin (router `notaFiscal.emitir`); não há
 * job nem cron. Garantias:
 *
 *   - NOTAS GRAVADAS: cada clique grava as notas que vai enviar (CPF, valor,
 *     campanhas, nDPS) numa transação antes de qualquer envio. Retries enviam
 *     os valores gravados; pendências resolvidas depois entram como notas
 *     novas; recálculo divergente (ex.: recebedor trocado) bloqueia — ver
 *     plano-emissao.ts.
 *   - IDEMPOTÊNCIA: uma linha em `nfse_emissoes` por (ambiente, competência,
 *     CPF). Nota autorizada ou cancelada nunca é reenviada.
 *   - NUMERAÇÃO: nDPS sequencial por ambiente e série, reservado na fixação.
 *     O Id da DPS fica estável para todas as tentativas daquela nota.
 *   - CONFIRMAÇÃO: o admin confirma a impressão (sha256) do plano completo;
 *     ambiente, série, CPFs, valores, campanhas e campos fiscais entram nela.
 *   - TIMEOUT: qualquer tentativa depois da primeira consulta GET /dps/{Id}
 *     antes de reenviar; se a NFS-e já existe, só é registrada.
 *   - CONCORRÊNCIA: cada envio "reivindica" a linha (status → enviando) com
 *     UPDATE condicional; um segundo clique simultâneo não reenvia.
 *
 * Segredos: o material do certificado vive só na memória desta chamada.
 * O banco guarda XML assinado/devolvido (que têm CPF do tomador) — nunca
 * entra em log nem em span.
 */

const tracer = trace.getTracer('eunenem-server');

export const VER_APLIC_EMISSAO = 'eunenem-1';

/** `enviando` mais velho que isso é tratado como tentativa interrompida (incerta). */
const ENVIANDO_EXPIRA_MS = 5 * 60_000;

export type StatusEmissao = 'pendente' | 'enviando' | 'incerta' | 'rejeitada' | 'autorizada' | 'cancelada';

export type FabricaClienteSefin = (input: { readonly ambiente: TipoAmbiente; readonly material: MaterialCertificado }) => ClienteSefin;

export interface EmissaoNfse {
  readonly id: string;
  readonly ambiente: TipoAmbiente;
  readonly competencia: string;
  readonly tomadorCpf: string;
  readonly tomadorNome: string;
  readonly valorCents: number;
  readonly serie: string;
  readonly nDps: string;
  readonly idDps: string;
  readonly status: StatusEmissao;
  readonly tentativas: number;
  readonly chaveAcesso: string | null;
  readonly numeroNfse: string | null;
  readonly erros: readonly ErroSefin[] | null;
  readonly cancelamentoStatus: 'incerto' | 'rejeitado' | null;
  readonly cancelamentoMotivo: MotivoCancelamento | null;
  readonly cancelamentoTexto: string | null;
  readonly criadaEm: Date;
  readonly atualizadaEm: Date;
  readonly enviadaEm: Date | null;
  readonly autorizadaEm: Date | null;
  readonly canceladaEm: Date | null;
  readonly temDpsXml: boolean;
  readonly temNfseXml: boolean;
}

// ────────────────────────────────────────────────────────────────────
//  Erros
// ────────────────────────────────────────────────────────────────────

export class EmissaoBloqueadaError extends Error {
  constructor(readonly bloqueios: PlanoEmissao['bloqueios']) {
    super('nfse_emissao_bloqueada');
    this.name = 'EmissaoBloqueadaError';
  }
}

/** O plano recalculado no clique não é o que o admin confirmou. */
export class PlanoMudouError extends Error {
  constructor() {
    super('nfse_plano_mudou');
    this.name = 'PlanoMudouError';
  }
}

export class EmissaoNaoEncontradaError extends Error {
  constructor() {
    super('nfse_emissao_nao_encontrada');
    this.name = 'EmissaoNaoEncontradaError';
  }
}

export type MotivoOperacaoInvalida =
  | 'nao_autorizada'
  | 'ja_cancelada'
  | 'outro_ambiente'
  | 'sem_chave'
  | 'certificado_indisponivel'
  | 'producao_nao_liberada';

export class OperacaoInvalidaError extends Error {
  constructor(readonly motivo: MotivoOperacaoInvalida) {
    super(`nfse_operacao_invalida:${motivo}`);
    this.name = 'OperacaoInvalidaError';
  }
}

// ────────────────────────────────────────────────────────────────────
//  Persistência
// ────────────────────────────────────────────────────────────────────

type Linha = Awaited<ReturnType<typeof buscarLinha>>;

function buscarLinha(db: Database, id: string) {
  return db.selectFrom('nfse_emissoes').selectAll().where('id', '=', id).executeTakeFirst();
}

function paraEmissao(l: NonNullable<Linha>): EmissaoNfse {
  return {
    id: l.id,
    ambiente: l.ambiente as TipoAmbiente,
    competencia: l.competencia,
    tomadorCpf: l.tomador_cpf,
    tomadorNome: l.tomador_nome,
    valorCents: Number(l.valor_cents),
    serie: l.serie,
    nDps: String(l.n_dps),
    idDps: l.id_dps,
    status: l.status as StatusEmissao,
    tentativas: l.tentativas,
    chaveAcesso: l.chave_acesso,
    numeroNfse: l.numero_nfse,
    erros: (l.erros as ErroSefin[] | null) ?? null,
    cancelamentoStatus: l.cancelamento_status as EmissaoNfse['cancelamentoStatus'],
    cancelamentoMotivo: l.cancelamento_motivo as MotivoCancelamento | null,
    cancelamentoTexto: l.cancelamento_texto,
    criadaEm: l.criada_em,
    atualizadaEm: l.atualizada_em,
    enviadaEm: l.enviada_em,
    autorizadaEm: l.autorizada_em,
    canceladaEm: l.cancelada_em,
    temDpsXml: l.dps_xml_assinado !== null,
    temNfseXml: l.nfse_xml !== null,
  };
}

export async function listarEmissoes(db: Database, input: { readonly ambiente: TipoAmbiente; readonly mes: string }): Promise<EmissaoNfse[]> {
  const linhas = await db
    .selectFrom('nfse_emissoes')
    .selectAll()
    .where('ambiente', '=', input.ambiente)
    .where('competencia', '=', input.mes)
    .orderBy('n_dps')
    .execute();
  return linhas.map(paraEmissao);
}

export async function listarEmissaoPorId(db: Database, id: string): Promise<EmissaoNfse | undefined> {
  const l = await buscarLinha(db, id);
  return l ? paraEmissao(l) : undefined;
}

export async function xmlDaEmissao(
  db: Database,
  input: { readonly id: string; readonly tipo: 'dps' | 'nfse' | 'cancelamento' },
): Promise<string | null> {
  const l = await buscarLinha(db, input.id);
  if (!l) throw new EmissaoNaoEncontradaError();
  return input.tipo === 'dps' ? l.dps_xml_assinado : input.tipo === 'nfse' ? l.nfse_xml : l.cancelamento_evento_xml;
}

/**
 * GRAVA as notas novas do plano (valor + campanhas) e reserva os nDPS em
 * sequência, numa transação, ANTES de qualquer envio. `idsEsperados` são as
 * notas já gravadas que o plano confirmado considerou: se o conjunto mudou
 * desde então (outro clique gravou), desfaz tudo — nenhum número é consumido
 * — e devolve null. Sucesso: os ids das linhas criadas.
 */
export async function gravarNotas(
  db: Database,
  input: {
    readonly ambiente: TipoAmbiente;
    readonly serie: string;
    readonly mes: string;
    readonly notas: readonly NotaPlanejada[];
    readonly idsEsperados: readonly string[];
    readonly idDps: (nDps: string) => string;
    readonly autorId: string;
    readonly now: Date;
  },
): Promise<string[] | null> {
  try {
    return await db.transaction().execute(async (trx) => {
      const criadas: string[] = [];
      // Serializa a gravação por (ambiente, competência) e relê DENTRO da
      // transação: dois cliques com planos de CPFs disjuntos (ex.: recebedor
      // trocado entre eles) não podem gravar a mesma receita duas vezes.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`nfse_competencia:${input.ambiente}:${input.mes}`}))`.execute(trx);
      const atuais = await trx
        .selectFrom('nfse_emissoes')
        .select('id')
        .where('ambiente', '=', input.ambiente)
        .where('competencia', '=', input.mes)
        .execute();
      const esperados = [...input.idsEsperados].sort().join(',');
      if (atuais.map((l) => l.id).sort().join(',') !== esperados) throw new CompetenciaJaFixada();
      for (const nota of input.notas) {
        const { proximo } = await trx
          .insertInto('nfse_numeracao')
          .values({ ambiente: input.ambiente, serie: input.serie, proximo: 2 })
          .onConflict((oc) => oc.columns(['ambiente', 'serie']).doUpdateSet({ proximo: sql`nfse_numeracao.proximo + 1` }))
          .returning('proximo')
          .executeTakeFirstOrThrow();
        const nDps = String(BigInt(proximo) - 1n);
        const inserida = await trx
          .insertInto('nfse_emissoes')
          .values({
            id: randomUUID(),
            ambiente: input.ambiente,
            competencia: input.mes,
            tomador_cpf: nota.tomadorCpf,
            tomador_nome: nota.tomadorNome,
            valor_cents: nota.valorCents,
            campanhas: [...nota.campanhas],
            serie: input.serie,
            n_dps: nDps,
            id_dps: input.idDps(nDps),
            status: 'pendente',
            solicitada_por: input.autorId,
            criada_em: input.now,
            atualizada_em: input.now,
          })
          .onConflict((oc) => oc.columns(['ambiente', 'competencia', 'tomador_cpf']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!inserida) throw new CompetenciaJaFixada();
        criadas.push(inserida.id);
      }
      return criadas;
    });
  } catch (e: unknown) {
    if (e instanceof CompetenciaJaFixada) return null;
    throw e;
  }
}

class CompetenciaJaFixada extends Error {}

function linhasDaCompetencia(db: Database, ambiente: TipoAmbiente, mes: string) {
  return db
    .selectFrom('nfse_emissoes')
    .selectAll()
    .where('ambiente', '=', ambiente)
    .where('competencia', '=', mes)
    .orderBy('n_dps')
    .execute();
}

function notaDaLinha(l: NonNullable<Linha>): NotaFixada {
  return {
    id: l.id,
    tomadorCpf: l.tomador_cpf,
    tomadorNome: l.tomador_nome,
    valorCents: Number(l.valor_cents),
    campanhas: [...l.campanhas].sort(),
    serie: l.serie,
    status: l.status as StatusEmissao,
  };
}

/**
 * Reivindica a linha para UMA tentativa de envio. Devolve o número de
 * tentativas ANTERIORES, ou null se outra chamada está enviando agora.
 */
async function reivindicar(db: Database, id: string, now: Date): Promise<number | null> {
  const expira = new Date(now.getTime() - ENVIANDO_EXPIRA_MS);
  const r = await db
    .updateTable('nfse_emissoes')
    .set({ status: 'enviando', tentativas: sql`tentativas + 1`, atualizada_em: now })
    .where('id', '=', id)
    .where((eb) =>
      eb.or([
        eb('status', 'in', ['pendente', 'incerta', 'rejeitada']),
        eb.and([eb('status', '=', 'enviando'), eb('atualizada_em', '<', expira)]),
      ]),
    )
    .returning('tentativas')
    .executeTakeFirst();
  return r ? r.tentativas - 1 : null;
}

async function atualizar(db: Database, id: string, valores: Updateable<NfseEmissoes>): Promise<void> {
  await db.updateTable('nfse_emissoes').set(valores).where('id', '=', id).execute();
}

function errosJson(erros: readonly ErroSefin[]) {
  return JSON.stringify(erros);
}

// ────────────────────────────────────────────────────────────────────
//  Certificado + cliente
// ────────────────────────────────────────────────────────────────────

function prepararCliente(config: NfseConfig, fabrica: FabricaClienteSefin): { material: MaterialCertificado; cliente: ClienteSefin } {
  if (config.certificado === null) throw new OperacaoInvalidaError('certificado_indisponivel');
  let material: MaterialCertificado;
  try {
    material = carregarCertificado(config.certificado);
  } catch {
    throw new OperacaoInvalidaError('certificado_indisponivel');
  }
  return { material, cliente: fabrica({ ambiente: config.ambiente.valor, material }) };
}

function exigirProducaoLiberada(config: NfseConfig): void {
  if (config.ambiente.valor === '1' && !config.emissaoProducaoLiberada) throw new OperacaoInvalidaError('producao_nao_liberada');
}

async function comSpan<T>(nome: string, atributos: Record<string, string | number>, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(nome, async (span) => {
    try {
      for (const [k, v] of Object.entries(atributos)) span.setAttribute(k, v);
      return await fn();
    } catch (error: unknown) {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

// ────────────────────────────────────────────────────────────────────
//  Emitir competência
// ────────────────────────────────────────────────────────────────────

export interface DepsEmissao {
  readonly db: Database;
  readonly config: NfseConfig;
  readonly clienteSefin: FabricaClienteSefin;
  readonly clock: () => Date;
}

export async function carregarPlanoEmissao(
  deps: Pick<DepsEmissao, 'db' | 'config' | 'clock'>,
  input: { readonly platformId: string; readonly mes: string },
): Promise<PlanoEmissao> {
  const previa = await carregarPreviaMensal(deps.db, { platformId: input.platformId, mes: input.mes, now: deps.clock(), config: deps.config });
  const fixadas = (await linhasDaCompetencia(deps.db, deps.config.ambiente.valor, input.mes)).map(notaDaLinha);
  return montarPlanoEmissao({ previa, config: deps.config, fixadas });
}

export type ResultadoNota = { readonly tomadorCpf: string; readonly resultado: 'ja_emitida' | 'em_andamento' | StatusEmissao };

export async function emitirCompetencia(
  deps: DepsEmissao,
  input: {
    readonly platformId: string;
    readonly mes: string;
    readonly autorId: string;
    /** Impressão do plano que o admin viu e confirmou. */
    readonly confirmacao: { readonly impressao: string };
  },
): Promise<{ readonly plano: PlanoEmissao; readonly resultados: readonly ResultadoNota[] }> {
  return comSpan('nfse.emitirCompetencia', { 'nfse.mes': input.mes }, async () => {
    const { db, config } = deps;
    exigirProducaoLiberada(config);
    const plano = await carregarPlanoEmissao(deps, input);
    if (plano.bloqueios.length > 0) throw new EmissaoBloqueadaError(plano.bloqueios);
    if (plano.impressao !== input.confirmacao.impressao) throw new PlanoMudouError();
    const { material, cliente } = prepararCliente(config, deps.clienteSefin);
    const ambiente = config.ambiente.valor;
    const { prestadorCnpj, municipioIbge } = config;
    if (prestadorCnpj === null || municipioIbge === null) throw new EmissaoBloqueadaError(['config_incompleta']);

    const linhasVistas = (await linhasDaCompetencia(db, ambiente, input.mes)).filter((l) => plano.idsFixados.includes(l.id));
    const jaGravados = new Set(linhasVistas.map((l) => l.tomador_cpf));
    const cpfsConfirmados = new Set(plano.notas.map((n) => n.tomadorCpf));
    // Só envia o que o admin confirmou: as notas gravadas que o plano viu e
    // que estão nele, mais as que ESTE clique grava agora. Linhas gravadas por
    // outro clique concorrente ficam para ele (ou para uma nova confirmação).
    const autorizadas = new Set(linhasVistas.filter((l) => cpfsConfirmados.has(l.tomador_cpf)).map((l) => l.id));
    const novas = plano.notas.filter((n) => !jaGravados.has(n.tomadorCpf));
    if (novas.length > 0) {
      const criadas = await gravarNotas(db, {
        ambiente,
        serie: plano.serie,
        mes: input.mes,
        notas: novas,
        idsEsperados: plano.idsFixados,
        autorId: input.autorId,
        now: deps.clock(),
        idDps: (nDps) => montarIdDps({ cLocEmi: municipioIbge, cnpj: prestadorCnpj, serie: plano.serie, nDPS: nDps }),
      });
      // Outro clique gravou notas agora: o plano confirmado não vale mais.
      if (criadas === null) throw new PlanoMudouError();
      for (const id of criadas) autorizadas.add(id);
    }

    // Envia o que está GRAVADO (valores gravados), nunca um recálculo.
    const resultados: ResultadoNota[] = [];
    for (const linha of await linhasDaCompetencia(db, ambiente, input.mes)) {
      if (linha.status === 'autorizada' || linha.status === 'cancelada') {
        resultados.push({ tomadorCpf: linha.tomador_cpf, resultado: 'ja_emitida' });
        continue;
      }
      if (!autorizadas.has(linha.id)) continue;
      const status = await enviarNota(deps, { linha, material, cliente });
      resultados.push({ tomadorCpf: linha.tomador_cpf, resultado: status });
    }
    trace.getActiveSpan()?.setAttribute('nfse.notas', resultados.length);
    return { plano, resultados };
  });
}

function dpsOuFalha(
  config: NfseConfig,
  mes: string,
  nota: NotaPlanejada,
  now: Date,
  numeracao: { readonly serie: string; readonly nDPS: string },
) {
  const r = montarDpsDaNota({
    tomador: { cpf: nota.tomadorCpf, nome: nota.tomadorNome },
    mes,
    resultadoCents: nota.valorCents,
    config,
    now,
    numeracao: { ...numeracao, verAplic: VER_APLIC_EMISSAO },
  });
  // O plano já barrou sem_valor/config_incompleta; chegar aqui é bug.
  if (r.status !== 'pronta') throw new Error('nfse_dps_inconsistente_com_plano');
  return r.dps;
}

/** Uma tentativa de envio de uma nota já reservada. Nunca lança por resposta do Sefin. */
async function enviarNota(
  deps: DepsEmissao,
  input: { readonly linha: NonNullable<Linha>; readonly material: MaterialCertificado; readonly cliente: ClienteSefin },
): Promise<StatusEmissao | 'em_andamento'> {
  const { db, config } = deps;
  const { linha, material, cliente } = input;
  const nota = notaDaLinha(linha);
  const anteriores = await reivindicar(db, linha.id, deps.clock());
  if (anteriores === null) return 'em_andamento';

  if (anteriores > 0) {
    // Pode já ter sido registrada numa tentativa sem resposta: consultar antes.
    const recuperada = await recuperarPorDps(db, cliente, linha.id, linha.id_dps, deps.clock());
    if (recuperada !== 'nao_encontrada') return recuperada;
  }

  // Ainda não existe no Sistema Nacional: monta com os valores FIXADOS.
  const dps = dpsOuFalha(config, linha.competencia, nota, deps.clock(), { serie: linha.serie, nDPS: String(linha.n_dps) });
  const { xml, idDps } = montarDpsXml(dps);
  if (idDps !== linha.id_dps) throw new Error('nfse_id_dps_mudou');
  const assinado = assinarDps(xml, idDps, material);
  await atualizar(db, linha.id, {
    dps_xml_assinado: assinado,
    enviada_em: deps.clock(),
    atualizada_em: deps.clock(),
  });

  const r = await cliente.emitirDps(assinado);
  const now = deps.clock();
  if (r.tipo === 'autorizada') {
    await registrarAutorizada(db, linha.id, r.chaveAcesso, r.nfseXml, now);
    return 'autorizada';
  }
  if (r.tipo === 'rejeitada') {
    await atualizar(db, linha.id, { status: 'rejeitada', erros: errosJson(r.erros), atualizada_em: now });
    return 'rejeitada';
  }
  await atualizar(db, linha.id, { status: 'incerta', atualizada_em: now });
  return 'incerta';
}

async function registrarAutorizada(db: Database, id: string, chave: string, nfseXml: string | null, now: Date): Promise<void> {
  await atualizar(db, id, {
    status: 'autorizada',
    chave_acesso: chave,
    numero_nfse: nfseXml ? extrairDadosNfse(nfseXml).numero : null,
    nfse_xml: nfseXml,
    erros: null,
    autorizada_em: now,
    atualizada_em: now,
  });
}

/** GET /dps/{Id}: se a NFS-e já existe, registra como autorizada. */
async function recuperarPorDps(
  db: Database,
  cliente: ClienteSefin,
  id: string,
  idDps: string,
  now: Date,
  opcoes: { readonly marcarIncerta: boolean } = { marcarIncerta: true },
): Promise<'autorizada' | 'incerta' | 'nao_encontrada'> {
  const consulta = await cliente.consultarDps(idDps);
  if (consulta.tipo === 'nao_encontrada') return 'nao_encontrada';
  if (consulta.tipo === 'incerta') {
    if (opcoes.marcarIncerta) await atualizar(db, id, { status: 'incerta', atualizada_em: now });
    return 'incerta';
  }
  const nfse = await cliente.consultarNfse(consulta.chaveAcesso);
  await registrarAutorizada(db, id, consulta.chaveAcesso, nfse.tipo === 'encontrada' ? nfse.nfseXml : null, now);
  return 'autorizada';
}

// ────────────────────────────────────────────────────────────────────
//  Consultar / cancelar
// ────────────────────────────────────────────────────────────────────

async function linhaDoAmbiente(db: Database, config: NfseConfig, id: string): Promise<NonNullable<Linha>> {
  const linha = await buscarLinha(db, id);
  if (!linha) throw new EmissaoNaoEncontradaError();
  if (linha.ambiente !== config.ambiente.valor) throw new OperacaoInvalidaError('outro_ambiente');
  return linha;
}

/** Atualiza a linha com o que o Sistema Nacional diz agora. */
export async function consultarEmissao(deps: DepsEmissao, input: { readonly id: string }): Promise<EmissaoNfse> {
  return comSpan('nfse.consultarEmissao', {}, async () => {
    const { db, config } = deps;
    const linha = await linhaDoAmbiente(db, config, input.id);
    const { cliente } = prepararCliente(config, deps.clienteSefin);
    const now = deps.clock();

    if (linha.chave_acesso === null) {
      const expirada = linha.status === 'enviando' && linha.atualizada_em.getTime() < now.getTime() - ENVIANDO_EXPIRA_MS;
      if (linha.tentativas > 0 && (linha.status === 'incerta' || linha.status === 'rejeitada' || expirada)) {
        // Rejeitada continua rejeitada se a consulta for inconclusiva: a
        // rejeição foi uma resposta definitiva (nada registrado).
        const r = await recuperarPorDps(db, cliente, linha.id, linha.id_dps, now, {
          marcarIncerta: linha.status !== 'rejeitada',
        });
        // Interrompida e inexistente no Sistema Nacional: pode ser reenviada.
        if (r === 'nao_encontrada' && expirada) await atualizar(db, linha.id, { status: 'incerta', atualizada_em: now });
      }
    } else {
      const nfse = await cliente.consultarNfse(linha.chave_acesso);
      if (nfse.tipo === 'encontrada') {
        await atualizar(db, linha.id, { nfse_xml: nfse.nfseXml, numero_nfse: extrairDadosNfse(nfse.nfseXml).numero ?? linha.numero_nfse, atualizada_em: now });
      }
      if (linha.status === 'autorizada') {
        const evento = await cliente.consultarEvento(linha.chave_acesso, TIPO_EVENTO_CANCELAMENTO, 1);
        if (evento.tipo === 'encontrado') await registrarCancelada(db, linha.id, evento.eventoXml, now);
      }
    }
    const atual = await buscarLinha(db, linha.id);
    return paraEmissao(atual as NonNullable<Linha>);
  });
}

async function registrarCancelada(db: Database, id: string, eventoXml: string, now: Date): Promise<void> {
  await atualizar(db, id, {
    status: 'cancelada',
    cancelamento_status: null,
    cancelamento_evento_xml: eventoXml,
    cancelada_em: now,
    atualizada_em: now,
  });
}

export async function cancelarEmissao(
  deps: DepsEmissao,
  input: { readonly id: string; readonly motivo: MotivoCancelamento; readonly texto: string; readonly autorId: string },
): Promise<EmissaoNfse> {
  return comSpan('nfse.cancelarEmissao', { 'nfse.cancelamento.motivo': input.motivo }, async () => {
    const { db, config } = deps;
    exigirProducaoLiberada(config);
    const linha = await linhaDoAmbiente(db, config, input.id);
    if (linha.status === 'cancelada') throw new OperacaoInvalidaError('ja_cancelada');
    if (linha.status !== 'autorizada') throw new OperacaoInvalidaError('nao_autorizada');
    const chave = linha.chave_acesso;
    if (chave === null) throw new OperacaoInvalidaError('sem_chave');
    const { material, cliente } = prepararCliente(config, deps.clienteSefin);
    const cnpj = config.prestadorCnpj;
    if (cnpj === null) throw new EmissaoBloqueadaError(['config_incompleta']);

    // Tentativa anterior sem resposta: o evento pode já estar registrado.
    if (linha.cancelamento_status === 'incerto') {
      const evento = await cliente.consultarEvento(chave, TIPO_EVENTO_CANCELAMENTO, 1);
      if (evento.tipo === 'encontrado') {
        await registrarCancelada(db, linha.id, evento.eventoXml, deps.clock());
        return paraEmissao((await buscarLinha(db, linha.id)) as NonNullable<Linha>);
      }
      if (evento.tipo === 'incerta') return paraEmissao(linha);
    }

    const { xml, idPedido } = montarPedidoCancelamento({
      tpAmb: config.ambiente.valor,
      verAplic: VER_APLIC_EMISSAO,
      dhEvento: dhEmiSaoPaulo(deps.clock()),
      cnpjAutor: cnpj,
      chaveAcesso: chave,
      cMotivo: input.motivo,
      xMotivo: input.texto,
    });
    const assinado = assinarPedidoEvento(xml, idPedido, material);
    await atualizar(db, linha.id, {
      cancelamento_motivo: input.motivo,
      cancelamento_texto: input.texto,
      cancelada_por: input.autorId,
      atualizada_em: deps.clock(),
    });
    const r = await cliente.registrarEvento(chave, assinado);
    const now = deps.clock();
    if (r.tipo === 'registrado') await registrarCancelada(db, linha.id, r.eventoXml, now);
    else {
      // Condicional: um cancelamento concorrente que já registrou não é sobrescrito.
      await db
        .updateTable('nfse_emissoes')
        .set(r.tipo === 'rejeitado' ? { cancelamento_status: 'rejeitado', erros: errosJson(r.erros), atualizada_em: now } : { cancelamento_status: 'incerto', atualizada_em: now })
        .where('id', '=', linha.id)
        .where('status', '=', 'autorizada')
        .execute();
    }
    return paraEmissao((await buscarLinha(db, linha.id)) as NonNullable<Linha>);
  });
}
