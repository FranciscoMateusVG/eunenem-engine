// aperture-uj78j — runner do spec da prévia da NFS-e (cópia do runner 9bpre).
//
// Além do Postgres efêmero, gera um e-CNPJ A1 de teste (PFX autoassinado, senha
// aleatória) e passa NFSE_* aos servidores, para a página mostrar a DPS
// assinada. Nenhum certificado real é lido.
//
// Sobe UM Postgres efêmero com o helper existente (tests/helpers/test-db.ts,
// modo efêmero), roda o spec nativo do Playwright contra ele e derruba tudo no
// fim. Não altera playwright.config.ts, dependências nem CI.
//
// Uso (da raiz do repo, Node 22):
//   node --import tsx e2e/support/uj78j-nfse-ephemeral-run.mjs
//
// Garantias:
//   - nunca usa o Postgres de desenvolvimento (localhost:54320);
//   - a URI de conexão fica só em memória/ambiente do processo filho e nunca é
//     impressa;
//   - portas 3002–3004 precisam estar livres: CI=1 desliga o
//     reuseExistingServer, então servidor alheio faz o run falhar fechado;
//   - o ambiente repassado é uma lista curta e explícita — nenhum .env e
//     nenhuma credencial de provedor;
//   - o spec confere a identidade do banco ANTES de semear.

import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC = 'e2e/uj78j-admin-nota-fiscal.spec.ts';
const PORTS = [3002, 3003, 3004];
const DEV_DB_PORT = '54320';

function log(message) {
  console.log(`[uj78j-runner] ${message}`);
}

function portInUse(port) {
  return new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      done(false);
    });
  });
}

async function busyPorts() {
  const busy = [];
  for (const port of PORTS) if (await portInUse(port)) busy.push(port);
  return busy;
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function run(command, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', fail);
    child.once('exit', (code) => done(code ?? 1));
  });
}

const busyBefore = await busyPorts();
if (busyBefore.length > 0) {
  console.error(
    `[uj78j-runner] portas ocupadas por outro processo: ${busyBefore.join(', ')}. Abortando sem tocar em nada.`,
  );
  process.exit(2);
}

// Força o modo efêmero do helper: sem container compartilhado do vitest.
delete process.env.TEST_DATABASE_URL;
const { createTestDatabase } = await import('../../tests/helpers/test-db.ts');

let exitCode = 1;
let containerId = '';
const testDb = await createTestDatabase();
try {
  const target = new URL(testDb.connectionUri);
  if (!['localhost', '127.0.0.1'].includes(target.hostname)) {
    throw new Error('banco efêmero fora de loopback');
  }
  if (target.port === DEV_DB_PORT || target.port === '') {
    throw new Error('porta do banco efêmero coincide com o banco de desenvolvimento');
  }
  containerId = docker(['ps', '--filter', `publish=${target.port}`, '--format', '{{.ID}}']);
  if (!/^[0-9a-f]{12}$/.test(containerId)) {
    throw new Error('não foi possível ligar a porta do banco a exatamente um container');
  }
  const image = docker(['inspect', '--format', '{{.Config.Image}}', containerId]);
  const identity = await sql`
    SELECT current_database() AS name, oid::text AS oid
    FROM pg_database WHERE datname = current_database()
  `.execute(testDb.db);
  const { name, oid } = identity.rows[0];
  log(`container=${containerId} image=${image} porta=${target.port} banco=${name} oid=${oid}`);

  const { gerarPfxDeTeste } = await import('../../tests/helpers/nfse-test-pfx.ts');
  const pfx = gerarPfxDeTeste({ cnpj: '11222333000181', cadeia: 'folha_primeiro' });

  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    CI: '1',
    NODE_ENV: 'development',
    DATABASE_URL: testDb.connectionUri,
    E2E_DATABASE_URL: testDb.connectionUri,
    E2E_UJ78J_DB_NAME: name,
    E2E_UJ78J_DB_OID: oid,
    E2E_UJ78J_DB_PORT: target.port,
    E2E_UJ78J_CONTAINER: containerId,
    // Os servidores herdam o ambiente do Playwright: estes chegam ao parseNfseConfig.
    NFSE_PRESTADOR_CNPJ: '11222333000181',
    NFSE_MUNICIPIO_IBGE: '3106200',
    NFSE_CERT_BASE64: pfx.pfx.toString('base64'),
    NFSE_CERT_PASSWORD: pfx.senha,
    // O spec procura estes no HTML e nas respostas: aparecer é vazamento.
    E2E_UJ78J_CERT_B64: pfx.certificadoBase64,
  };

  log('build do bundle (apps/eunenem-server)');
  const build = await run('pnpm', ['build'], {
    cwd: resolve(ROOT, 'apps/eunenem-server'),
    env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, LANG: env.LANG },
  });
  if (build !== 0) throw new Error(`build falhou (exit ${build})`);

  log(`playwright ${SPEC}`);
  exitCode = await run(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      SPEC,
      '--project=chromium',
      '--workers=1',
      '--retries=0',
      '--reporter=list',
    ],
    { cwd: ROOT, env },
  );
  log(`playwright exit=${exitCode}`);
} catch (error) {
  console.error(`[uj78j-runner] ${error instanceof Error ? error.message : 'falha'}`);
  exitCode = exitCode === 0 ? 1 : exitCode;
} finally {
  await testDb.teardown();
  const restante = containerId
    ? docker(['ps', '-a', '--filter', `id=${containerId}`, '--format', '{{.ID}}'])
    : '';
  const busyAfter = await busyPorts();
  log(`teardown: containerAusente=${restante === ''} portasOcupadas=[${busyAfter.join(',')}]`);
  if (restante !== '' || busyAfter.length > 0) exitCode = exitCode === 0 ? 3 : exitCode;
}
process.exit(exitCode);
