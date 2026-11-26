import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import forge from 'node-forge';

/**
 * Fake HTTPS do Sefin Nacional + ADN (aperture-wp6j6) para testes de
 * fronteira: TLS de verdade com `requestCert` — o fake só responde se o
 * cliente apresentar o certificado esperado (mTLS) — e os caminhos/JSON da
 * API (dpsXmlGZipB64, pedidoRegistroEventoXmlGZipB64, nfseXmlGZipB64…).
 *
 * Estado mínimo: DPS recebidas viram NFS-e com chave sintética de 50 dígitos.
 * `proximaEmissao` programa a reação ao próximo POST /nfse.
 */

export type ReacaoEmissao =
  | 'autorizar'
  | { rejeitar: { codigo: string; descricao: string } }
  /** Registra a NFS-e e derruba a conexão sem responder (timeout ambíguo). */
  | 'registrar_e_derrubar'
  /** Derruba sem registrar. */
  | 'derrubar'
  | 'erro_500';

export interface RequisicaoRecebida {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  /** XML descomprimido do corpo, quando houver. */
  readonly xml: string | null;
  readonly certificadoClienteCn: string | null;
}

export interface NotaFake {
  readonly idDps: string;
  readonly chave: string;
  readonly numero: string;
  readonly dpsXml: string;
  cancelada: boolean;
  eventoXml: string | null;
}

export interface FakeSefin {
  readonly baseUrl: string;
  /** PEM da AC do servidor, para o cliente de teste confiar nele. */
  readonly caPem: string;
  readonly requisicoes: RequisicaoRecebida[];
  readonly notas: Map<string, NotaFake>;
  proximaEmissao: ReacaoEmissao[];
  reacaoEvento:
    | 'registrar'
    | { rejeitar: { codigo: string; descricao: string } }
    | 'registrar_e_derrubar';
  fechar(): Promise<void>;
}

function certificadoServidor(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${randomBytes(6).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '127.0.0.1' },
        { type: 2, value: 'localhost' },
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

const gz = (s: string) => gzipSync(Buffer.from(s, 'utf8')).toString('base64');
const ungz = (b64: string) => gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

function nfseXml(nota: { chave: string; numero: string; dpsXml: string }): string {
  const dps = nota.dpsXml.replace(/^<\?xml[^>]*\?>/, '');
  return (
    '<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">' +
    `<infNFSe Id="NFS${nota.chave}"><xLocEmi>Belo Horizonte</xLocEmi><nNFSe>${nota.numero}</nNFSe>` +
    `<cStat>100</cStat>${dps}</infNFSe></NFSe>`
  );
}

export async function iniciarFakeSefin(opts: {
  readonly clienteCertPem: string;
}): Promise<FakeSefin> {
  const servidor = certificadoServidor();
  const requisicoes: RequisicaoRecebida[] = [];
  const notas = new Map<string, NotaFake>();
  let sequencia = 0;

  const fake = {
    requisicoes,
    notas,
    proximaEmissao: [] as ReacaoEmissao[],
    reacaoEvento: 'registrar' as FakeSefin['reacaoEvento'],
    reacaoConsultaDps: 'normal' as FakeSefin['reacaoConsultaDps'],
  };

  const server: Server = createServer(
    {
      key: servidor.key,
      cert: servidor.cert,
      requestCert: true,
      rejectUnauthorized: true,
      ca: [opts.clienteCertPem],
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const path = (req.url ?? '').replace(/^\/SefinNacional/, '');
        const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
        let xml: string | null = null;
        try {
          const json = body ? (JSON.parse(body) as Record<string, string>) : {};
          const campo = json.dpsXmlGZipB64 ?? json.pedidoRegistroEventoXmlGZipB64;
          if (campo) xml = ungz(campo);
        } catch {
          xml = null;
        }
        requisicoes.push({
          method: req.method ?? '',
          path,
          body,
          xml,
          certificadoClienteCn: typeof peer?.subject?.CN === 'string' ? peer.subject.CN : null,
        });

        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const base = {
          tipoAmbiente: 2,
          versaoAplicativo: 'fake-1',
          dataHoraProcessamento: new Date().toISOString(),
        };

        if (req.method === 'POST' && path === '/nfse') {
          const reacao = fake.proximaEmissao.shift() ?? 'autorizar';
          const idDps = xml ? (/Id="(DPS\d{42})"/.exec(xml)?.[1] ?? null) : null;
          if (!xml || !idDps)
            return json(400, {
              ...base,
              erros: [{ Codigo: 'E9999', Descricao: 'corpo invalido' }],
            });
          if (reacao === 'derrubar') return req.socket.destroy();
          if (reacao === 'erro_500') return json(500, { message: 'erro interno' });
          if (typeof reacao === 'object') {
            return json(400, {
              ...base,
              idDPS: idDps,
              erros: [{ Codigo: reacao.rejeitar.codigo, Descricao: reacao.rejeitar.descricao }],
            });
          }
          if ([...notas.values()].some((n) => n.idDps === idDps)) {
            return json(400, {
              ...base,
              idDPS: idDps,
              erros: [{ Codigo: 'E0014', Descricao: 'DPS ja utilizada' }],
            });
          }
          sequencia += 1;
          const chave = `3106200${String(sequencia).padStart(43, '0')}`;
          const nota: NotaFake = {
            idDps,
            chave,
            numero: String(sequencia),
            dpsXml: xml,
            cancelada: false,
            eventoXml: null,
          };
          notas.set(chave, nota);
          if (reacao === 'registrar_e_derrubar') return req.socket.destroy();
          return json(201, {
            ...base,
            idDps,
            chaveAcesso: chave,
            nfseXmlGZipB64: gz(nfseXml(nota)),
            alertas: [],
          });
        }

        // Como a API real: o identificador vai SEM o prefixo "DPS" (42 dígitos).
        const dps = /^\/dps\/([^/]+)$/.exec(path);
        if (dps && req.method === 'GET') {
          if (fake.reacaoConsultaDps === 'erro_500') return json(500, { message: 'erro interno' });
          if (!/^\d{42}$/.test(dps[1] ?? '')) {
            return json(400, {
              ...base,
              erro: {
                codigo: 'E2400',
                descricao: 'Identificador mal formado. O ID da DPS deve conter 42 números.',
              },
            });
          }
          const nota = [...notas.values()].find((n) => n.idDps === `DPS${dps[1]}`);
          if (!nota)
            return json(404, {
              ...base,
              erro: {
                codigo: 'E2404',
                descricao: 'Não foi gerada uma NFS-e com o identificador de DPS informado',
              },
            });
          return json(200, { ...base, idDps: nota.idDps, chaveAcesso: nota.chave });
        }

        const nfse = /^\/nfse\/(\d{50})$/.exec(path);
        if (nfse && req.method === 'GET') {
          const nota = notas.get(nfse[1] ?? '');
          if (!nota)
            return json(404, {
              ...base,
              erros: [{ Codigo: 'E404', Descricao: 'NFS-e nao encontrada' }],
            });
          return json(200, { ...base, chaveAcesso: nota.chave, nfseXmlGZipB64: gz(nfseXml(nota)) });
        }

        const evento = /^\/nfse\/(\d{50})\/eventos(?:\/(\d{6})\/(\d+))?$/.exec(path);
        if (evento) {
          const nota = notas.get(evento[1] ?? '');
          if (!nota)
            return json(404, {
              ...base,
              erros: [{ Codigo: 'E404', Descricao: 'NFS-e nao encontrada' }],
            });
          if (req.method === 'GET') {
            if (!nota.eventoXml)
              return json(404, {
                ...base,
                erros: [{ Codigo: 'E404', Descricao: 'evento nao encontrado' }],
              });
            // Forma real (smoke 26/11/2026): lista `eventos`, com `arquivoXml` =
            // base64 do texto gzip+base64 (base64 dupla).
            return json(200, {
              ...base,
              eventos: [
                {
                  chaveAcesso: nota.chave,
                  tipoEvento: 101101,
                  numeroPedidoRegistroEvento: 1,
                  dataHoraRecebimento: new Date().toISOString(),
                  arquivoXml: Buffer.from(gz(nota.eventoXml), 'utf8').toString('base64'),
                },
              ],
            });
          }
          if (req.method === 'POST') {
            if (!xml)
              return json(400, {
                ...base,
                erros: [{ Codigo: 'E9999', Descricao: 'corpo invalido' }],
              });
            const reacao = fake.reacaoEvento;
            if (typeof reacao === 'object') {
              return json(400, {
                ...base,
                erros: [{ Codigo: reacao.rejeitar.codigo, Descricao: reacao.rejeitar.descricao }],
              });
            }
            if (nota.cancelada)
              return json(400, {
                ...base,
                erros: [{ Codigo: 'E0840', Descricao: 'evento ja registrado' }],
              });
            nota.cancelada = true;
            nota.eventoXml = `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento>${xml.replace(/^<\?xml[^>]*\?>/, '')}</infEvento></evento>`;
            if (reacao === 'registrar_e_derrubar') return req.socket.destroy();
            return json(201, { ...base, eventoXmlGZipB64: gz(nota.eventoXml) });
          }
        }

        json(404, { erros: [{ Codigo: 'E404', Descricao: `rota desconhecida ${path}` }] });
      });
    },
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(fake, {
    baseUrl: `https://127.0.0.1:${port}`,
    caPem: servidor.cert,
    fechar: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
