import { spawn } from 'node:child_process';
import { join } from 'node:path';

const tsxBin = join(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

const child = spawn(
  tsxBin,
  ['watch', '--env-file-if-exists=.env', 'server.tsx'],
  {
    shell: process.platform === 'win32',
    // `tsx watch` can stall on Windows when it inherits stdin from a
    // parent orchestrator like concurrently. Closing stdin keeps watch
    // mode working on Windows without changing Unix behavior.
    stdio:
      process.platform === 'win32'
        ? ['ignore', 'inherit', 'inherit']
        : 'inherit',
  },
);

child.once('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}
