import https from 'node:https';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { MaterialCertificado } from './assinatura.js';
import type { TipoAmbiente } from './dps.js';

/**
 * Cliente mTLS do Sistema Nacional NFS-e (aperture-wp6j6). Porta
 * nfse-sandbox/src/client.ts sem undici: `node:https` com a chave/certificado
 * PEM extraídos do PFX pelo node-forge (OpenSSL 3 recusa as cifras legadas dos
 * PFX ICP-Brasil), como o cliente do Banco Inter.
 *
 * Contrato da API (Sefin Nacional / ADN):
 *   POST {sefin}/nfse                         {dpsXmlGZipB64}
 *   GET  {sefin}/dps/{42 dígitos do Id}      → {chaveAcesso}  (SEM o prefixo
 *        "DPS": a API real responde E2400 com ele; não achou = 404 E2404)
 *   GET  {sefin}/nfse/{chave}                 → {nfseXmlGZipB64}
 *   POST {sefin}/nfse/{chave}/eventos         {pedidoRegistroEventoXmlGZipB64}
 *   GET  {sefin}/nfse/{chave}/eventos/{tipo}/{seq} → {eventos:[{arquivoXml}]}
 *        (arquivoXml = base64 do gzip+base64 — confirmado na produção restrita)
 *   GET  {adn}/danfse/{chave}                 → PDF
 *
 * Classificação: 2xx = sucesso; 4xx = recusa (nada foi registrado); qualquer
 * outra coisa (timeout, conexão, TLS, 5xx, corpo ilegível) = `incerta` — o
 * chamador consulta antes de reenviar. O cliente nunca lança por resposta.
 *
 * TLS: verificação padrão LIGADA. `caPem` existe só para o fake dos testes.
 * Corpos e XML não entram em spans (têm CPF do tomador).
 */

const tracer = trace.getTracer('eunenem-server');

export interface HostsSefin {
  readonly sefin: string;
  readonly adn: string;
}

export const HOSTS_SEFIN: Readonly<Record<TipoAmbiente, HostsSefin>> = {
  '1': { sefin: 'https://sefin.nfse.gov.br/SefinNacional', adn: 'https://adn.nfse.gov.br' },
  '2': {
    sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    adn: 'https://adn.producaorestrita.nfse.gov.br',
  },
};

const TIMEOUT_PADRAO_MS = 60_000;

export interface ErroSefin {
  readonly codigo: string;
  readonly descricao: string;
  readonly complemento: string | null;
}

export type MotivoIncerteza = 'conexao' | 'http' | 'resposta_invalida';

export type Incerta = { readonly tipo: 'incerta'; readonly motivo: MotivoIncerteza; readonly httpStatus: number | null };

export type RespostaEmissao =
  | { readonly tipo: 'autorizada'; readonly chaveAcesso: string; readonly nfseXml: string }
  | { readonly tipo: 'rejeitada'; readonly httpStatus: number; readonly erros: readonly ErroSefin[] }
  | Incerta;

export type RespostaConsultaDps =
  | { readonly tipo: 'encontrada'; readonly chaveAcesso: string }
  | { readonly tipo: 'nao_encontrada' }
  | Incerta;

export type RespostaConsultaNfse =
  | { readonly tipo: 'encontrada'; readonly nfseXml: string }
  | { readonly tipo: 'nao_encontrada' }
  | Incerta;

export type RespostaEvento =
  | { readonly tipo: 'registrado'; readonly eventoXml: string }
  | { readonly tipo: 'rejeitado'; readonly httpStatus: number; readonly erros: readonly ErroSefin[] }
  | Incerta;

export type RespostaConsultaEvento =
  | { readonly tipo: 'encontrado'; readonly eventoXml: string }
  | { readonly tipo: 'nao_encontrado' }
  | Incerta;

export type RespostaDanfse =
  | { readonly tipo: 'ok'; readonly pdf: Buffer }
  | { readonly tipo: 'nao_encontrado' }
  | Incerta;

export interface ClienteSefin {
  emitirDps(dpsXmlAssinado: string): Promise<RespostaEmissao>;
  consultarDps(idDps: string): Promise<RespostaConsultaDps>;
  consultarNfse(chaveAcesso: string): Promise<RespostaConsultaNfse>;
  registrarEvento(chaveAcesso: string, pedidoXmlAssinado: string): Promise<RespostaEvento>;
  consultarEvento(chaveAcesso: string, tipoEvento: string, sequencia: number): Promise<RespostaConsultaEvento>;
  baixarDanfse(chaveAcesso: string): Promise<RespostaDanfse>;
}

export interface OpcoesClienteSefin {
  readonly hosts: HostsSefin;
  readonly material: MaterialCertificado;
  /** Só testes: AC extra em que confiar (o fake). Produção: cadeia padrão. */
  readonly caPem?: string;
  readonly timeoutMs?: number;
}

interface RespostaHttp {
  readonly status: number;
  readonly corpo: Buffer;
}

const gzipB64 = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
const gunzipB64 = (b64: string) => gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

function lerJson(corpo: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(corpo.toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Campo do JSON sem depender da caixa (a API mistura `idDps`/`idDPS`, `Codigo`/`codigo`). */
function campo(obj: Record<string, unknown>, nome: string): unknown {
  const alvo = nome.toLowerCase();
  for (const [k, v] of Object.entries(obj)) if (k.toLowerCase() === alvo) return v;
  return undefined;
}

function texto(obj: Record<string, unknown>, nome: string): string | null {
  const v = campo(obj, nome);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function lerErros(json: Record<string, unknown> | null, status: number): ErroSefin[] {
  const brutos = json ? campo(json, 'erros') ?? campo(json, 'erro') : undefined;
  const lista = Array.isArray(brutos) ? brutos : brutos && typeof brutos === 'object' ? [brutos] : [];
  const erros = lista
    .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
    .map((e) => ({
      codigo: texto(e, 'codigo') ?? 'sem_codigo',
      descricao: texto(e, 'descricao') ?? '',
      complemento: texto(e, 'complemento'),
    }));
  return erros.length > 0 ? erros : [{ codigo: `HTTP_${status}`, descricao: 'Recusado sem lista de erros.', complemento: null }];
}

function xmlDoCampo(json: Record<string, unknown> | null, nome: string): string | null {
  const b64 = json ? texto(json, nome) : null;
  if (b64 === null) return null;
  try {
    return gunzipB64(b64);
  } catch {
    return null;
  }
}

/**
 * `arquivoXml` da consulta de eventos: base64 do texto gzip+base64 (visto na
 * produção restrita). Tolera também gzip+base64 direto e XML cru.
 */
function decodificarArquivoXml(arquivo: string): string | null {
  const tentar = (f: () => string) => {
    try {
      const x = f();
      return x.trimStart().startsWith('<') ? x : null;
    } catch {
      return null;
    }
  };
  if (arquivo.trimStart().startsWith('<')) return arquivo;
  return (
    tentar(() => gunzipB64(Buffer.from(arquivo, 'base64').toString('utf8').trim())) ??
    tentar(() => gunzipB64(arquivo)) ??
    tentar(() => Buffer.from(arquivo, 'base64').toString('utf8'))
  );
}

const incerta = (motivo: MotivoIncerteza, httpStatus: number | null = null): Incerta => ({ tipo: 'incerta', motivo, httpStatus });

/** Chave de acesso (Id "NFS" + 50 dígitos) e nNFSe do XML da NFS-e. */
export function extrairDadosNfse(nfseXml: string): { chaveAcesso: string | null; numero: string | null } {
  return {
    chaveAcesso: /<infNFSe\b[^>]*\bId="NFS(\d{50})"/.exec(nfseXml)?.[1] ?? null,
    numero: /<nNFSe>(\d+)<\/nNFSe>/.exec(nfseXml)?.[1] ?? null,
  };
}

export function criarClienteSefin(opcoes: OpcoesClienteSefin): ClienteSefin {
  const agent = new https.Agent({
    key: opcoes.material.privateKeyPem,
    cert: opcoes.material.certificatePem,
    ...(opcoes.caPem === undefined ? {} : { ca: opcoes.caPem }),
    keepAlive: false,
  });
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS;

  /** Resolve com qualquer status HTTP; rejeita só em falha de conexão/timeout. */
  function requisitar(method: 'GET' | 'POST', url: string, corpo?: string, accept = 'application/json'): Promise<RespostaHttp> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          agent,
          timeout: timeoutMs,
          headers: {
            Accept: accept,
            ...(corpo === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) }),
          },
        },
        (res) => {
          const partes: Buffer[] = [];
          res.on('data', (p: Buffer) => partes.push(p));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, corpo: Buffer.concat(partes) }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('nfse_sefin_timeout')));
      req.on('error', reject);
      if (corpo !== undefined) req.write(corpo);
      req.end();
    });
  }

  async function chamar<T>(
    operacao: string,
    method: 'GET' | 'POST',
    url: string,
    corpo: string | undefined,
    interpretar: (r: RespostaHttp) => T,
    accept?: string,
  ): Promise<T | Incerta> {
    return tracer.startActiveSpan(`nfse.sefin.${operacao}`, async (span) => {
      try {
        span.setAttribute('http.request.method', method);
        let r: RespostaHttp;
        try {
          r = await requisitar(method, url, corpo, accept);
        } catch (error: unknown) {
          // Mensagens de erro de rede não carregam corpo nem segredo; só o código.
          span.setAttribute('nfse.sefin.erro', (error as { code?: string }).code ?? 'conexao');
          span.setStatus({ code: SpanStatusCode.ERROR });
          return incerta('conexao');
        }
        span.setAttribute('http.response.status_code', r.status);
        const resultado = interpretar(r);
        if ((resultado as { tipo: string }).tipo === 'incerta') span.setStatus({ code: SpanStatusCode.ERROR });
        return resultado;
      } finally {
        span.end();
      }
    });
  }

  const { sefin, adn } = opcoes.hosts;

  return {
    emitirDps: (dpsXmlAssinado) =>
      chamar('emitirDps', 'POST', `${sefin}/nfse`, JSON.stringify({ dpsXmlGZipB64: gzipB64(dpsXmlAssinado) }), (r): RespostaEmissao => {
        const json = lerJson(r.corpo);
        if (r.status >= 200 && r.status < 300) {
          const nfseXml = xmlDoCampo(json, 'nfseXmlGZipB64');
          const chaveAcesso = (json && texto(json, 'chaveAcesso')) ?? (nfseXml ? extrairDadosNfse(nfseXml).chaveAcesso : null);
          if (nfseXml === null || chaveAcesso === null) return incerta('resposta_invalida', r.status);
          return { tipo: 'autorizada', chaveAcesso, nfseXml };
        }
        if (r.status >= 400 && r.status < 500) return { tipo: 'rejeitada', httpStatus: r.status, erros: lerErros(json, r.status) };
        return incerta('http', r.status);
      }),

    consultarDps: (idDps) =>
      chamar('consultarDps', 'GET', `${sefin}/dps/${idDps.replace(/^DPS/, '')}`, undefined, (r): RespostaConsultaDps => {
        if (r.status === 404) return { tipo: 'nao_encontrada' };
        const json = lerJson(r.corpo);
        const chaveAcesso = json ? texto(json, 'chaveAcesso') : null;
        if (r.status === 200 && chaveAcesso !== null) return { tipo: 'encontrada', chaveAcesso };
        return incerta(r.status === 200 ? 'resposta_invalida' : 'http', r.status);
      }),

    consultarNfse: (chaveAcesso) =>
      chamar('consultarNfse', 'GET', `${sefin}/nfse/${chaveAcesso}`, undefined, (r): RespostaConsultaNfse => {
        if (r.status === 404) return { tipo: 'nao_encontrada' };
        const nfseXml = xmlDoCampo(lerJson(r.corpo), 'nfseXmlGZipB64');
        if (r.status === 200 && nfseXml !== null) return { tipo: 'encontrada', nfseXml };
        return incerta(r.status === 200 ? 'resposta_invalida' : 'http', r.status);
      }),

    registrarEvento: (chaveAcesso, pedidoXmlAssinado) =>
      chamar(
        'registrarEvento',
        'POST',
        `${sefin}/nfse/${chaveAcesso}/eventos`,
        JSON.stringify({ pedidoRegistroEventoXmlGZipB64: gzipB64(pedidoXmlAssinado) }),
        (r): RespostaEvento => {
          const json = lerJson(r.corpo);
          if (r.status >= 200 && r.status < 300) {
            const eventoXml = xmlDoCampo(json, 'eventoXmlGZipB64');
            return eventoXml === null ? incerta('resposta_invalida', r.status) : { tipo: 'registrado', eventoXml };
          }
          if (r.status >= 400 && r.status < 500) return { tipo: 'rejeitado', httpStatus: r.status, erros: lerErros(json, r.status) };
          return incerta('http', r.status);
        },
      ),

    consultarEvento: (chaveAcesso, tipoEvento, sequencia) =>
      chamar(
        'consultarEvento',
        'GET',
        `${sefin}/nfse/${chaveAcesso}/eventos/${tipoEvento}/${sequencia}`,
        undefined,
        (r): RespostaConsultaEvento => {
          if (r.status === 404) return { tipo: 'nao_encontrado' };
          const json = lerJson(r.corpo);
          if (r.status !== 200 || json === null) return incerta(r.status === 200 ? 'resposta_invalida' : 'http', r.status);
          // Forma real (smoke 26/11/2026): { eventos: [{ arquivoXml }] }, com
          // arquivoXml = base64 do texto gzip+base64. Aceita também a forma
          // antiga eventoXmlGZipB64.
          const eventos = campo(json, 'eventos');
          if (Array.isArray(eventos)) {
            if (eventos.length === 0) return { tipo: 'nao_encontrado' };
            const primeiro = eventos[0];
            const arquivo = primeiro && typeof primeiro === 'object' ? texto(primeiro as Record<string, unknown>, 'arquivoXml') : null;
            const eventoXml = arquivo === null ? null : decodificarArquivoXml(arquivo);
            return eventoXml === null ? incerta('resposta_invalida', r.status) : { tipo: 'encontrado', eventoXml };
          }
          const eventoXml = xmlDoCampo(json, 'eventoXmlGZipB64');
          return eventoXml === null ? incerta('resposta_invalida', r.status) : { tipo: 'encontrado', eventoXml };
        },
      ),

    baixarDanfse: (chaveAcesso) =>
      chamar('baixarDanfse', 'GET', `${adn}/danfse/${chaveAcesso}`, undefined, (r): RespostaDanfse => {
        if (r.status === 404) return { tipo: 'nao_encontrado' };
        if (r.status === 200 && r.corpo.subarray(0, 5).toString('latin1') === '%PDF-') return { tipo: 'ok', pdf: r.corpo };
        return incerta(r.status === 200 ? 'resposta_invalida' : 'http', r.status);
      }, 'application/pdf'),
  };
}
