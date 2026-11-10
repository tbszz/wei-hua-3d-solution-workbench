import { spawn } from 'node:child_process';

const processes = [
  spawn(process.execPath, ['server/index.js'], { stdio: 'inherit', env: { ...process.env, MAGPIE_ENABLED: process.env.MAGPIE_ENABLED ?? 'true', MAGPIE_BASE_URL: process.env.MAGPIE_BASE_URL ?? 'http://127.0.0.1:7897/v1', MAGPIE_MODEL: process.env.MAGPIE_MODEL ?? 'trae-cn/seed-code-pro-0430' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5181', '--strictPort'], { stdio: 'inherit' }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill();
  process.exitCode = code;
};

for (const child of processes) {
  child.on('error', () => stop(1));
  child.on('exit', (code, signal) => {
    if (!stopping && (code ?? 1) !== 0) stop(code ?? 1);
    else if (!stopping && signal) stop(1);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
