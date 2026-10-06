// aperture-9bpre — runner do gate visual da aba Receita EuNeném.
//
// Sobe UM Postgres efêmero com o helper existente (tests/helpers/test-db.ts,
// modo efêmero), roda o spec nativo do Playwright contra ele e derruba tudo no
// fim. Não altera playwright.config.ts, dependências nem CI.
//
// Uso (da raiz do repo, Node 22):
//   node --import tsx e2e/support/9bpre-ephemeral-run.mjs [spec]
//
// `spec` é opcional (padrão: o spec do 9bpre). Outros specs que seguem o
// mesmo contrato de identidade do banco (E2E_9BPRE_*) reusam este runner —
// ex.: e2e/q4pfz-receita-1b.spec.ts.
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
const SPEC_PADRAO = 'e2e/9bpre-admin-receita.spec.ts';
const SPEC = process.argv[2] ?? SPEC_PADRAO;
if (!/^e2e\/[\w.-]+\.spec\.ts$/.test(SPEC)) {
  console.error('[9bpre-runner] spec inválido: use e2e/<nome>.spec.ts');
  process.exit(2);
}
const PORTS = [3002, 3003, 3004];
const DEV_DB_PORT = '54320';

function log(message) {
  console.log(`[9bpre-runner] ${message}`);
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
    `[9bpre-runner] portas ocupadas por outro processo: ${busyBefore.join(', ')}. Abortando sem tocar em nada.`,
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

  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    CI: '1',
    NODE_ENV: 'development',
    DATABASE_URL: testDb.connectionUri,
    E2E_DATABASE_URL: testDb.connectionUri,
    E2E_9BPRE_DB_NAME: name,
    E2E_9BPRE_DB_OID: oid,
    E2E_9BPRE_DB_PORT: target.port,
    E2E_9BPRE_CONTAINER: containerId,
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
  console.error(`[9bpre-runner] ${error instanceof Error ? error.message : 'falha'}`);
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
