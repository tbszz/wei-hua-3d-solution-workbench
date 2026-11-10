// Backend only. The frontend is prototype/ (vite on 5182), which proxies /api and /library here.
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['server/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MAGPIE_ENABLED: process.env.MAGPIE_ENABLED ?? 'true',
    MAGPIE_BASE_URL: process.env.MAGPIE_BASE_URL ?? 'http://127.0.0.1:7897/v1',
    MAGPIE_MODEL: process.env.MAGPIE_MODEL ?? 'trae-cn/seed-code-pro-0430',
  },
});
child.on('exit', (code) => { process.exitCode = code ?? 0; });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
