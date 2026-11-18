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
import { checkQuickTool, QuickPatch, proposeTool, reviewTool } from '../../src/quickPatch';
import { AgentPatch, verifyAgentTool } from '../../src/agentPatch';
import { VantaError } from '../../src/trueforge';

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

test('MCP checks a Quick Edit draft in memory without authorizing review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vanta-mcp-edit-'));
  const scope = { path: root, isAvailable: () => true };
  const abort = new AbortController();
  let patch: QuickPatch | undefined;
  let checked = false;
  const text = 'first\nkeep\nlast\n';
  const bridge = await startOverviewBridge(scope, abort.signal, undefined, undefined, {
    stage: (replacement, explanation) => {
      patch = new QuickPatch({ path: 'source.py', text, version: 1, start: 0, end: text.length, eol: '\n' }, explanation, replacement);
      return patch;
    },
    check: ({ proposalId, checks, correction }) => {
      assert.equal(proposalId, patch!.id);
      assert.deepEqual(checks, [{ scenario: 'Unchanged line', outcome: 'The middle line stays.' }]);
      assert.equal(correction, undefined);
      checked = true;
      return patch!;
    },
    receipt: (id) => {
      if (!checked) throw new VantaError('Check the draft first.');
      return patch!.consume(id);
    },
  });
  const client = new Client({ name: 'local-test', version: '1.0.0' });
  try {
    await writeFile(join(root, 'source.py'), text);
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: bridge.authorization } } }));
    const invalid = await client.callTool({ name: proposeTool, arguments: { replacement: '', explanation: 'out of scope', path: '../elsewhere' } });
    assert.equal(invalid.isError, true);
    const proposal = await client.callTool({ name: proposeTool, arguments: { replacement: 'FIRST\nkeep\nLAST\n', explanation: 'Two changes' } });
    assert.equal(proposal.isError, undefined);
    assert.match(JSON.stringify(proposal.content), /original.*first/);
    assert.ok(patch);
    const args = { name: reviewTool, arguments: { proposalId: patch.id } };
    assert.equal((await client.callTool(args)).isError, true);
    const check = { name: checkQuickTool, arguments: { proposalId: patch.id, checks: [] as { scenario: string; outcome: string }[] } };
    assert.equal((await client.callTool(check)).isError, true);
    assert.equal(checked, false);
    check.arguments.checks = [{ scenario: 'Unchanged line', outcome: 'The middle line stays.' }];
    const checkedDraft = await client.callTool(check);
    assert.equal(checkedDraft.isError, undefined);
    assert.match(JSON.stringify(checkedDraft.content), new RegExp(patch.id));
    assert.equal((await client.callTool(args)).isError, true);
    patch.decide(1, 'rejected');
    patch.decide(2, 'accepted');
    patch.authorize();
    const review = await client.callTool(args);
    assert.match(JSON.stringify(review.content), /accepted.*2/);
    assert.equal((await client.callTool(args)).isError, true);
    const repo = await Repository.bind(scope, { ripgrep: false });
    assert.equal(await repo.diskText('source.py', abort.signal), text);
  } finally {
    await client.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent MCP bounds batched ranges and rejects an unapproved command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vanta-mcp-agent-'));
  const scope = { path: root, isAvailable: () => true };
  const signal = new AbortController().signal;
  const repo = await Repository.bind(scope, { ripgrep: false });
  const context = new ContextEngine(repo, 8000, () => undefined, true);
  const patch = new AgentPatch();
  const bridge = await startOverviewBridge(scope, signal, undefined, context, undefined, {
    stage: async (proposal) => {
      const text = await repo.diskText(proposal.path, signal);
      return patch.stage({ path: proposal.path, text, start: 0, end: text.length, eol: '\n', version: 1 }, proposal);
    }, review: (reference) => patch.consume(reference),
    verify: async () => { throw new VantaError('No local approval'); },
  });
  const client = new Client({ name: 'local-test', version: '1.0.0' });
  try {
    await writeFile(join(root, 'sample.py'), Array.from({ length: 30 }, (_, index) => `sample_${index + 1}\n`).join(''));
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: bridge.authorization } } }));
    const range = { path: 'sample.py', start: 1, end: 30 };
    const result = await client.callTool({ name: 'read_workspace_ranges', arguments: { ranges: [range, { ...range, path: '../sample.py' }] } });
    assert.match(JSON.stringify(result.content), /sample_24/);
    assert.doesNotMatch(JSON.stringify(result.content), /sample_25/);
    assert.match(JSON.stringify(result.content), /workspace policy/);
    const asText = (response: Record<string, unknown>) => (response.content as { text: string }[])[0]!.text;
    assert.match(asText(result), /"end":24,"requestedEnd":30,"status":"returned"/);
    assert.ok(asText(result).includes('sample_22\nsample_23\nsample_24'));
    const duplicate = await client.callTool({ name: 'read_file', arguments: { ...range, end: 24 } });
    assert.match(asText(duplicate), /"status":"already_shared"/);
    assert.doesNotMatch(asText(duplicate), /sample_24/);
    const newLines = await client.callTool({ name: 'read_workspace_ranges', arguments: { ranges: [{ ...range, start: 23 }] } });
    assert.match(asText(newLines), /sample_25/);
    const sharedUnion = await client.callTool({ name: 'read_file', arguments: range });
    assert.match(asText(sharedUnion), /"status":"already_shared"/);
    assert.equal((await client.callTool({ name: 'read_workspace_ranges', arguments: { ranges: Array(6).fill(range) } })).isError, true);
    for (let i = 0; i < 4; i++) {
      const listed = await client.callTool({ name: 'list_workspace_files', arguments: { query: 'sample' } });
      assert.match(asText(listed), new RegExp(`"readsRemaining":${3 - i}`));
    }
    const exhausted = await client.callTool({ name: 'read_workspace_ranges', arguments: { ranges: [range] } });
    assert.equal(exhausted.isError, true);
    assert.match(asText(exhausted), /repository read limit reached/);
    const proposal = { path: 'sample.py', summary: 'Update sample', edits: [{ old: 'sample_24\n', replacement: 'reviewed\n' }] };
    await writeFile(join(root, 'another.py'), 'sample_24\n');
    const batch = await client.callTool({ name: 'stage_related_edits', arguments: { files: [proposal, { ...proposal, path: '../sample.py' }, { ...proposal, path: 'another.py' }] } });
    const staged = JSON.parse(asText(batch));
    assert.deepEqual(staged.review, patch.reference);
    assert.equal(staged.review.revision, 2);
    assert.deepEqual(staged.results.map((item: { status: string }) => item.status), ['staged', 'rejected', 'staged']);
    assert.match(staged.results[1].error, /workspace policy/);
    assert.match(await repo.diskText('sample.py', signal), /sample_24/);
    assert.equal((await client.callTool({ name: verifyAgentTool, arguments: { target: 'sample.py' } })).isError, true);
  } finally {
    await client.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent MCP labels omitted Python source and can pace tool replies', { skip: !process.env.VANTA_TEST_PYTHON }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vanta-mcp-boundary-'));
  const scope = { path: root, isAvailable: () => true };
  const signal = new AbortController().signal;
  const lines = ['def collect():', ...Array<string>(35).fill('    pass'), '    return True', '', 'handler = collect'];
  const repo = await Repository.bind(scope, { ripgrep: false });
  const context = new ContextEngine(repo, 8000, () => undefined, true, process.env.VANTA_TEST_PYTHON);
  const blocked = () => { throw new VantaError('No local approval'); };
  const replyDelayMs = 75;
  const bridge = await startOverviewBridge(scope, signal, undefined, context, undefined,
    { stage: blocked, review: blocked, verify: blocked }, replyDelayMs);
  const client = new Client({ name: 'local-test', version: '1.0.0' });
  try {
    await writeFile(join(root, 'sample.py'), lines.join('\n'));
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: bridge.authorization } } }));
    const started = performance.now();
    await client.callTool({ name: 'list_workspace_files', arguments: { query: 'sample' } });
    assert.ok(performance.now() - started >= replyDelayMs - 5);
    const result = await client.callTool({ name: 'read_workspace_ranges', arguments: { ranges: [{ path: 'sample.py', start: 1, end: 32 }] } });
    const text = (result.content as { text: string }[])[0]!.text;
    assert.match(text, /Python function ends at line 37\. It starts at line 1\. The next top-level statement starts at line 39\./);
    assert.match(text, /Lines 21-34 omitted\. Source blocks are not adjacent\./);
    assert.match(text, /Source "sample.py" lines 35-37:\n    pass\n    pass\n    return True/);
    assert.match(text, /Source "sample.py" lines 39-39:\nhandler = collect/);
    const tool = (await client.listTools()).tools.find((item) => item.name === 'stage_file_edit');
    assert.match(tool?.description ?? '', /"old":"    return result"/);
    assert.match(tool?.description ?? '', /"replacement":"    record\(result\)\\n    return result"/);
  } finally {
    await client.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
