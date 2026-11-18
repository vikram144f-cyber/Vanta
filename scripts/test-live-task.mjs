import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const task = process.env.VANTA_NATIVE_TASK;
const workspace = process.env.VANTA_NATIVE_FLASK;
if (!['A', 'B', 'C', 'STOP'].includes(task) || !workspace || !process.env.VANTA_NATIVE_MODEL || !process.env.VANTA_TEST_PYTHON) {
  throw new Error('Set VANTA_NATIVE_TASK (A, B, C or STOP), VANTA_NATIVE_FLASK, VANTA_NATIVE_MODEL and VANTA_TEST_PYTHON. Use a clean pinned Flask checkout. For C, VANTA_NATIVE_MODEL is the backup.');
}
const profile = await mkdtemp(join(tmpdir(), 'vanta-native-live-'));
const entry = resolve(`dist/live-tasks-${task.toLowerCase()}.cjs`);
await build({ entryPoints: ['test/extension/liveTasks.ts'], outfile: entry, bundle: true,
  platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
process.env.VANTA_SOURCE_ROOT = resolve('.');
process.env.VANTA_NATIVE_RESULT ??= join(profile, `task-${task}-result.json`);
console.log(`Native live Task ${task} result: ${process.env.VANTA_NATIVE_RESULT}`);
const forge = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0, timeoutInSeconds: 5 });
let primary;
try {
  if (task === 'C') {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((done) => socket.close(done));
    const name = `vanta-taskc-${randomUUID().slice(0, 8)}`;
    await forge.settings.modelProviders.create({ manifest: {
      type: 'custom', name, baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [{ name: 'unreachable', modelId: 'unreachable', properties: {} }],
    } });
    primary = name;
    process.env.VANTA_NATIVE_PRIMARY = `${primary}/unreachable`;
  }
  await runTests({
    ...(process.env.VANTA_VSCODE_EXE ? { vscodeExecutablePath: process.env.VANTA_VSCODE_EXE } : {}),
    extensionDevelopmentPath: resolve('.'), extensionTestsPath: entry,
    launchArgs: [resolve(workspace), '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--user-data-dir', join(profile, 'user-data'), '--extensions-dir', join(profile, 'extensions')],
  });
} finally {
  if (primary) await forge.settings.modelProviders.delete(primary);
}
