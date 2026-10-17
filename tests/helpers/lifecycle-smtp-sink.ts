import { once } from 'node:events';
import { createServer, type TLSSocket } from 'node:tls';
import forge from 'node-forge';

/** Closed loopback TLS SMTP sink: no DNS/external connections, no real credentials. */
export async function createLifecycleSmtpSink() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400_000);
  cert.validity.notAfter = new Date(Date.now() + 86400_000);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const ca = forge.pki.certificateToPem(cert);
  const messages: string[] = [];
  const sockets = new Set<TLSSocket>();
  let mode: 'accept' | 'ambiguous' | 'reject' = 'accept';
  const server = createServer(
    { key: forge.pki.privateKeyToPem(keys.privateKey), cert: ca },
    (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.write('220 localhost synthetic SMTP\r\n');
      let buffer = '';
      let data = false;
      let body = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes('\r\n')) {
          const index = buffer.indexOf('\r\n');
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (data) {
            if (line === '.') {
              messages.push(body);
              data = false;
              body = '';
              if (mode === 'ambiguous') {
                socket.destroy();
                return;
              }
              socket.write('250 accepted\r\n');
            } else body += `${line}\r\n`;
          } else if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
          else if (line.startsWith('AUTH')) socket.write('235 authenticated\r\n');
          else if (line === 'DATA') {
            if (mode === 'reject') socket.write('451 temporary refusal\r\n');
            else {
              data = true;
              socket.write('354 go ahead\r\n');
            }
          } else if (line === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 OK\r\n');
        }
      });
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener');
  return {
    port: address.port,
    ca,
    messages,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    async close() {
      for (const s of sockets) s.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
