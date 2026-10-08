import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const seed = spawn(process.execPath, ['scripts/seed-local.ts'], { stdio: 'inherit' });
const code = await new Promise(resolve => seed.once('exit', resolve));
if (code !== 0) process.exit(Number(code ?? 1));
const children = [
  spawn(process.execPath, ['server/local.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, [join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js')], { stdio: 'inherit' }),
];
let closing = false;
function close(code = 0) { if (closing) return; closing = true; children.forEach(child => child.kill('SIGTERM')); process.exitCode = code; }
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
children.forEach(child => child.once('exit', code => close(code ?? 1)));
