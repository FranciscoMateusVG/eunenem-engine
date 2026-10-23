import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { TransferenciaProviderInter } from '../../../src/adapters/pagamentos/transferencia-provider.inter.js';

it('45h33: preserves same-amount PIX debits even without a bank request ID (HTTP boundary)', async () => {
  const calls: string[] = [];
  let malformed = false;
  const server = createServer((req, res) => {
    calls.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if (malformed) {
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify(
        req.url === '/oauth/v2/token'
          ? { access_token: 'synthetic-token', expires_in: 3600 }
          : {
              ultimaPagina: true,
              transacoes: [
                {
                  tipoOperacao: 'D',
                  tipoTransacao: 'PIX',
                  valor: '195.00',
                  dataInclusao: '2026-10-14',
                  detalhes: {
                    chavePixRecebedor: 'recipient@example.test',
                    endToEndId: 'E_SYNTHETIC_1',
                    nomeRecebedor: 'Synthetic Recipient',
                    cpfCnpjRecebedor: '12345678901',
                  },
                },
                {
                  tipoOperacao: 'D',
                  tipoTransacao: 'PIX',
                  valor: '195.00',
                  dataInclusao: '2026-10-14',
                  detalhes: {},
                },
                { tipoOperacao: 'C', tipoTransacao: 'PIX', valor: '195.00', detalhes: {} },
              ],
            },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const provider = new TransferenciaProviderInter(
      {
        baseUrl: 'https://inter.test',
        clientId: 'synthetic',
        clientSecret: 'synthetic',
        scope: 'extrato.read',
        certPem: 'unused',
        keyPem: 'unused',
      },
      async (method, path, headers, body) => {
        const result = await fetch(origin + path, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        });
        return { statusCode: result.status, body: await result.text() };
      },
    );
    const debits = await provider.buscarPagamentos({
      dataInicio: '2026-10-13',
      dataFim: '2026-10-15',
    });
    expect(debits).toHaveLength(2);
    expect(debits[0]).toMatchObject({
      valorCents: 19500,
      chave: 'recipient@example.test',
      e2eId: 'E_SYNTHETIC_1',
      recipientName: 'Synthetic Recipient',
      recipientDocument: '12345678901',
    });
    expect(debits[1]?.chave).toBeUndefined();
    malformed = true;
    await expect(
      provider.buscarPagamentos({ dataInicio: '2026-10-13', dataFim: '2026-10-15' }),
    ).rejects.toThrow('ilegível');
    expect(calls.filter((path) => path.startsWith('/banking/v2/pix'))).toHaveLength(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
