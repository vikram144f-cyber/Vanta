import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startOverviewBridge } from '../../src/mcp';
import { overviewToolName } from '../../src/trueforge';
import { bindOverview } from '../../src/workspace';
import { ContextEngine, contextTools } from '../../src/context';
import { Repository } from '../../src/repository';

test('workspace overview stays in the trusted root and filters names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vanta-root-'));
  const root = join(dir, 'workspace');
  let allowed = true;
  try {
    await mkdir(root);
    await mkdir(join(root, 'docs'));
    await mkdir(join(dir, 'outside'));
    await symlink(join(dir, 'outside'), join(root, 'shortcut'), 'junction');
    await writeFile(join(root, 'README.md'), 'file content must not be returned');
    await writeFile(join(root, '.env'), 'synthetic');
    await writeFile(join(root, 'private.pem'), 'synthetic');
    const editorPath = root.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    const overview = await bindOverview({ path: editorPath, isAvailable: () => allowed });
    assert.deepEqual(await overview(), { root: 'workspace', files: ['README.md'], folders: ['docs'], fileCount: 1, folderCount: 1, truncated: false });
    await assert.rejects(bindOverview({ path: join(root, 'shortcut'), isAvailable: () => true }), /canonical/);
    allowed = false;
    await assert.rejects(overview, /trusted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP MCP requires loopback auth, honors one grant and closes on cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vanta-mcp-'));
  const abort = new AbortController();
  const bridge = await startOverviewBridge({ path: root, isAvailable: () => true }, abort.signal);
  const client = new Client({ name: 'local-test', version: '1.0.0' });
  try {
    await mkdir(join(root, 'visible-folder'));
    assert.equal((await fetch(bridge.url)).status, 403);
    assert.equal((await fetch(bridge.url, { headers: { Authorization: bridge.authorization, Origin: 'https://example.test' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: bridge.authorization } } }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [overviewToolName, ...contextTools]);
    const unavailable = await client.callTool({ name: 'list_workspace_files', arguments: {} });
    assert.equal(unavailable.isError, true);
    assert.match(JSON.stringify(unavailable.content), /Enable workspace context/);
    assert.equal((await client.callTool({ name: overviewToolName, arguments: {} })).isError, true);
    bridge.grant();
    const result = await client.callTool({ name: overviewToolName, arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /visible-folder/);
    assert.equal((await client.callTool({ name: overviewToolName, arguments: {} })).isError, true);
    abort.abort();
    await bridge.close();
    await assert.rejects(fetch(bridge.url));
  } finally {
    await client.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('authorized HTTP repository reads are bounded and reject traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vanta-mcp-context-'));
  const scope = { path: root, isAvailable: () => true };
  const abort = new AbortController();
  const repository = await Repository.bind(scope, { ripgrep: false });
  const bridge = await startOverviewBridge(scope, abort.signal, undefined, new ContextEngine(repository, 2000, () => undefined));
  const client = new Client({ name: 'local-test', version: '1.0.0' });
  try {
    await writeFile(join(root, 'sample.py'), 'def sample():\n    return 42\n');
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: bridge.authorization } } }));
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'sample.py', start: 2, end: 2 } });
    assert.match(JSON.stringify(result.content), /return 42/);
    assert.doesNotMatch(JSON.stringify(result.content), /def sample/);
    assert.equal((await client.callTool({ name: 'read_file', arguments: { path: '../sample.py' } })).isError, true);
  } finally {
    await client.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
