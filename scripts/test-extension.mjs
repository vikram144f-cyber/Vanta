import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

const workspace = await mkdtemp(join(tmpdir(), 'vanta-extension-test-'));
await runTests({
  ...(process.env.VANTA_VSCODE_EXE ? { vscodeExecutablePath: process.env.VANTA_VSCODE_EXE } : {}),
  extensionDevelopmentPath: resolve('.'),
  extensionTestsPath: resolve('dist/extension-test.cjs'),
  launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir', join(workspace, 'user-data'), '--extensions-dir', join(workspace, 'extensions')],
});
