#!/usr/bin/env node
/** Build a public, read-only snapshot using only the checked-in bootstrap. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(appRoot, '.state/pages');
const controller = new AbortController();
const children = new Set();
let temporaryDirectory;
let signalExitCode;
let cleanupPromise;

function interrupt(signal) {
  signalExitCode = signal === 'SIGINT' ? 130 : 143;
  controller.abort(new Error(`Pages build interrupted by ${signal}`));
}
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);

function startNode(args, env, onStdout) {
  controller.signal.throwIfAborted();
  const child = spawn(process.execPath, args, {
    cwd: appRoot, env, stdio: onStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit', signal: controller.signal,
  });
  if (onStdout) child.stdout.on('data', chunk => { process.stdout.write(chunk); onStdout(chunk.toString()); });
  const entry = { child, result: null, done: null };
  children.add(entry);
  entry.done = new Promise(resolveDone => {
    child.once('error', error => {
      entry.result = { error };
      // An aborted child can still be shutting down; cleanup waits for close.
      if (!child.pid) resolveDone(entry.result);
    });
    child.once('close', (code, signal) => {
      entry.result ??= { code, signal };
      children.delete(entry);
      resolveDone(entry.result);
    });
  });
  return entry;
}

async function runNode(args, env) {
  const entry = startNode(args, env);
  let force;
  const timer = setTimeout(() => {
    entry.child.kill('SIGTERM');
    force = setTimeout(() => entry.child.kill('SIGKILL'), 4000);
  }, 180_000);
  try {
    const result = await entry.done;
    controller.signal.throwIfAborted();
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`${args[0]} failed (${result.signal ?? result.code}).`);
  } finally { clearTimeout(timer); clearTimeout(force); }
}

async function availablePort() {
  const requested = process.env.GRID_ATLAS_PAGES_PORT;
  if (requested !== undefined) {
    const port = Number(requested);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('GRID_ATLAS_PAGES_PORT must be a non-privileged local port.');
    return port;
  }
  const probe = createServer();
  return new Promise((resolvePort, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForApi(entry, origin, isListening) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    if (entry.result) throw new Error(`Temporary API exited before becoming ready: ${entry.result.error?.message ?? entry.result.code ?? entry.result.signal}`);
    if (!isListening()) {
      await delay(100, undefined, { signal: controller.signal });
      continue;
    }
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]), redirect: 'error',
      });
      if (response.ok && (await response.json()).ok === true) return;
    } catch { controller.signal.throwIfAborted(); }
    await delay(100, undefined, { signal: controller.signal });
  }
  throw new Error('Temporary Pages API did not become ready within 30 seconds.');
}

function cleanup() {
  cleanupPromise ??= (async () => {
    await Promise.all([...children].map(async entry => {
      entry.child.kill('SIGTERM');
      const force = setTimeout(() => entry.child.kill('SIGKILL'), 4000);
      try { await entry.done; } finally { clearTimeout(force); }
    }));
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

try {
  await mkdir(join(appRoot, '.state'), { recursive: true });
  temporaryDirectory = await mkdtemp(join(appRoot, '.state/.pages-build-'));
  const port = await availablePort();
  const env = {
    ...process.env,
    GRID_ATLAS_DB: join(temporaryDirectory, 'bootstrap.sqlite'),
    GRID_ATLAS_PORT: String(port),
  };
  await runNode(['scripts/seed-local.ts'], env);
  const origin = `http://127.0.0.1:${port}`;
  let apiOutput = '';
  const api = startNode(['server/local.ts'], env, chunk => { apiOutput = (apiOutput + chunk).slice(-2000); });
  // Wait for this child to bind before any request. A port collision must not
  // accidentally export another local server's database.
  await waitForApi(api, origin, () => apiOutput.includes(`Grid Atlas local API listening on 127.0.0.1:${port}`));
  const temporaryHtml = join(temporaryDirectory, 'index.html');
  await runNode(['scripts/export-preview.mjs', '--api', origin, '--output', temporaryHtml], env);
  controller.signal.throwIfAborted();
  await mkdir(outputDirectory, { recursive: true });
  await rename(temporaryHtml, join(outputDirectory, 'index.html'));
  await writeFile(join(outputDirectory, '.nojekyll'), '');
  console.log(JSON.stringify({
    output: join(outputDirectory, 'index.html'),
    bytes: (await stat(join(outputDirectory, 'index.html'))).size,
    input: 'checked-in data/bootstrap.json',
    readOnly: true,
    collectionPerformed: false,
  }, null, 2));
} catch (error) {
  console.error('Pages build failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = signalExitCode ?? 1;
} finally {
  await cleanup();
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
  if (signalExitCode) process.exitCode = signalExitCode;
}
