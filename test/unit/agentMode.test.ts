import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { AgentPatch, stageAgentSchema } from '../../src/agentPatch';
import { applyBatch } from '../../src/agentWorkspace';
import { Repository } from '../../src/repository';
import { StudioSession } from '../../src/session';
import { agentModeDefinition } from '../../src/trueforge';
import type { AgentTools } from '../../src/mcp';
import type { ApprovalEvent, Event, Forge } from '../../src/trueforge';
import { runPytest, verificationTarget } from '../../src/verification';
import type { BaseSelection } from '../../src/quickPatch';

const base = (path: string, text = 'old\nuntouched\nold end\n'): BaseSelection =>
  ({ path, text, start: 0, end: text.length, version: 1, eol: '\n' });
const binding = { call: 'call', turn: 'turn', session: 'session', workspace: 'workspace' };

test('Agent Mode exposes its first context call and preserves deferred tools and approvals', () => {
  const definition = agentModeDefinition('test/model', 'test-mcp', {
    stage: 'stage_file_edit', review: 'review_changes', verify: 'run_verification',
  });
  assert.ok('spec' in definition);
  const { spec } = definition;
  const [connector] = spec.mcpServers ?? [];
  assert.match(spec.instructions ?? '', /calling preloaded get_context_bundle once/);
  assert.ok(connector?.preloadTools);
  assert.equal(connector?.preload, false);
  assert.ok(connector.preloadTools.includes('get_context_bundle'));
  assert.ok(connector.enableTools?.includes('find_symbol'));
  assert.ok(!connector.preloadTools.includes('find_symbol'));
  assert.deepEqual(connector.requireApprovalForTools, ['review_changes', 'run_verification']);
});

test('multi-file receipt seals the exact selected hunks and revision once', () => {
  const patch = new AgentPatch();
  const edit = { old: 'old\n', replacement: 'new\n' };
  const stage = (path: string) => patch.stage(base(path), { path, summary: path, edits: [edit,
    { old: 'old end', replacement: 'new end' }] });
  const first = stage('first.py');
  stage('second.py');
  assert.equal(patch.matches(first), false);
  assert.throws(() => patch.consume(first), /matching/);
  assert.throws(() => patch.authorize(binding), /every hunk/);
  for (const file of patch.files.values()) for (const hunk of file.hunks) hunk.status = hunk.id % 2 ? 'accepted' : 'rejected';
  patch.authorize(binding);
  assert.throws(() => stage('late.py'), /sealed/);
  const receipt = patch.consume(patch.reference);
  assert.deepEqual(receipt.files, ['first.py', 'second.py']);
  assert.deepEqual(patch.approved(receipt).map((file) => [file.after, file.ids]),
    [['new\nuntouched\nold end\n', [1]], ['new\nuntouched\nold end\n', [3]]]);
  assert.throws(() => patch.consume(patch.reference), /matching/);
  assert.throws(() => patch.approved({ ...receipt }), /matching/);
  patch.close();
  assert.throws(() => patch.approved(receipt), /matching/);
});

test('missing and ambiguous anchors, overlapping edits, and malformed arguments fail', () => {
  const patch = new AgentPatch();
  const file = base('app.py', 'two two\nend\n');
  const stage = (...anchors: string[]) => patch.stage(file, { path: file.path, summary: 'Edit',
    edits: anchors.map((old) => ({ old, replacement: 'new' })) });
  assert.throws(() => stage('two'), /ambiguous/);
  assert.throws(() => stage('missing'), /missing/);
  assert.throws(() => stage('two two\\nend'), /Edit 1.*real line breaks/);
  assert.throws(() => stage('two two\n', '\nend'), /overlapping/);
  assert.equal(patch.files.size, 0);
  assert.equal(stageAgentSchema.safeParse({ path: file.path, summary: 'Edit', edits: [], script: 'unexpected' }).success, false);
  for (const path of ['../x.py', '-x.py', 'tests/x.py::test', 'tests/x.py -k test', 'tests\\x.py', 'CON.py']) {
    assert.equal(verificationTarget(path), false, path);
  }
  assert.equal(verificationTarget('tests/test_cli.py'), true);
});

test('batch failure compensates an earlier write and preserves a divergent buffer', async () => {
  const contents = new Map([['a', 'before'], ['b', 'before']]);
  const files = [...contents.keys()].map((path) => ({ path, before: 'before', after: 'after', current: () => contents.get(path)! }));
  await assert.rejects(applyBatch(files, async (selected, undo) => {
    if (undo) {
      assert.deepEqual(selected.map((file) => file.path), ['a']);
      contents.set('a', 'before');
      return true;
    }
    contents.set('a', 'after');
    contents.set('b', 'later user edit');
    throw new Error('injected write failure');
  }), /manually: b/);
  assert.equal(contents.get('a'), 'before');
  assert.equal(contents.get('b'), 'later user edit');
  await assert.rejects(applyBatch(files, async () => { assert.fail('stale batch wrote'); }), /preflight/);
});

const python = process.env.VANTA_TEST_PYTHON;

for (const verdict of ['allow', 'deferred', 'deny review', 'deny', 'cancel', 'failed test', 'interrupted', 'forged'] as const) {
  test(`Agent Mode patch and verification gates · ${verdict}`, { skip: !python, timeout: 15_000 }, async () => {
    assert.ok(python);
    const path = 'test_fixture.py';
    const source = 'def test_fixture():\n    assert True\n';
    const root = await mkdtemp(join(tmpdir(), 'vanta-agent-gates-'));
    await writeFile(join(root, path), source);
    const repo = await Repository.bind({ path: root, isAvailable: () => true }, { ripgrep: false });
    let tools!: AgentTools;
    let reference: Parameters<AgentTools['review']>[0];
    let last: ApprovalEvent;
    let writes = 0;
    let nextFails = false;
    const approved: string[] = [];
    const createdAt = '2026-11-14T00:00:00Z';
    const pause = function* (name: string, args: unknown): Generator<Event> {
      const deferred = verdict === 'deferred';
      yield { type: 'model.message', id: name, createdAt, threadId: 'main', toolCalls: [{ id: name, type: 'function',
        function: { name: deferred ? 'call_tool' : name, arguments: JSON.stringify(deferred ? { mcp_server: 'test-mcp', tool_name: name, input: args } : args) },
        toolInfo: deferred ? { type: 'truefoundry-system', name: 'call_tool' } : { type: 'mcp', name, serverName: 'test-mcp', serverId: 'test' } }] };
      yield { type: 'tool.approval_required', id: name + '-pause', createdAt, threadId: 'main', toolCalls: [{ id: name, sourceEventId: name }] };
    };
    const response = (toolCallId: string, payload: unknown): Event => ({ type: 'tool.response', id: toolCallId + '-result',
      createdAt, threadId: 'main', toolCallId, content: JSON.stringify(payload) });
    const session = new StudioSession({
      settings: () => ({ serverUrl: 'http://localhost:8790', agentName: '', model: 'fixture', workspaceOverview: true, verificationPython: python }),
      forge: (): Forge => ({
        check: async () => ({ version: 'fixture', models: ['fixture'] }),
        createSession: async () => 'fixture-session',
        start: async function* () {
          yield { type: 'turn.created', id: 'turn', turnId: 'turn', previousTurnId: null, createdAt, threadId: null, state: { status: 'running' } };
          if (nextFails) {
            yield { type: 'turn.done', id: 'failure', createdAt, threadId: null, state: { status: 'error', message: '503 unavailable', completedAt: createdAt } };
            return;
          }
          const { proposalId, revision } = await tools.stage({ path, summary: 'Add an assertion',
            edits: [{ old: '    assert True', replacement: verdict === 'failed test' ? '    assert False' : '    assert 1 == 1' }] }) as typeof reference;
          reference = { proposalId, revision };
          yield* pause('review_changes', reference);
        },
        resume: async function* () {
          yield { ...last, id: last.toolCallId + '-allow', createdAt };
          if (last.toolCallId === 'review_changes' && last.approval.status === 'allow') {
            yield response('review_changes', tools.review(reference));
            yield* pause('run_verification', { target: path });
            return;
          }
          if (last.approval.status === 'allow') yield response('run_verification',
            verdict === 'forged' ? { status: 'passed', exitCode: 0 } : await tools.verify(path));
          if (verdict === 'interrupted') return;
          yield { type: 'turn.done', id: 'done', createdAt, threadId: null,
            state: { status: 'done', completedAt: createdAt, output: null, requiredActions: [] } };
        },
        approve: async (_session, _turn, decision) => { last = decision; approved.push(decision.approval.status); },
        register: async () => undefined, remove: async () => undefined, cancel: async () => undefined,
      }),
      scopeKey: () => root,
      agentWorkspace: async () => ({ repository: repo, capture: async () => base(path, source), preview: async () => undefined,
        apply: async (files, _signal, begin) => {
          begin();
          assert.equal(files[0]?.after, source.replace('True', '1 == 1'));
          writes++;
          return async () => { writes--; };
        } }),
      bridge: async (signal, _name, context, _quick, agent) => {
        assert.ok(context && agent);
        tools = agent;
        await context.read(path, 1, 2, signal);
        return { name: 'test-mcp', url: 'http://127.0.0.1:6000/mcp', authorization: 'fixture',
          grant: () => assert.fail('overview grant'), revoke: () => undefined, close: async () => undefined };
      },
    });
    const when = <T>(select: () => T | undefined) => new Promise<T>((resolve) => {
      const release = session.listen(() => {
        const value = select();
        if (value) { release(); resolve(value); }
      });
    });
    try {
      await session.refresh();
      const review = when(() => session.state.review);
      const verification = when(() => session.state.approval);
      const run = session.submit('Change the test', true, undefined, true);
      const shown = await review;
      assert.throws(() => tools.review(reference), /local patch approval/);
      await session.decide('review_changes', true);
      assert.deepEqual(approved, []);
      if (verdict === 'deny review') {
        await session.finishReview(shown.id, false);
        await run;
        assert.deepEqual(approved, ['deny']);
        assert.equal(writes, 0);
        assert.equal(await readFile(join(root, path), 'utf8'), source);
        return;
      }
      await session.reviewHunk(shown.id, shown.hunks[0]!.id, 'accepted');
      await session.finishReview(shown.id, true);
      const command = await verification;
      await assert.rejects(tools.verify(path), /matching local approval/);
      assert.equal(writes, 0);
      if (verdict === 'cancel') await session.cancel();
      else await session.decide(command.id, verdict !== 'deny');
      await run;
      assert.equal(writes, verdict === 'allow' || verdict === 'deferred' ? 1 : 0);
      assert.deepEqual(approved, verdict === 'cancel' ? ['allow'] : ['allow', verdict === 'deny' ? 'deny' : 'allow']);
      if (verdict === 'allow' || verdict === 'deferred') assert.equal(session.state.verification?.status, 'passed');
      if (verdict === 'deny') assert.equal(session.state.verification?.status, 'denied');
      if (verdict === 'cancel') assert.equal(session.state.phase, 'cancelled');
      if (verdict === 'failed test') assert.equal(session.state.verification?.exitCode, 1);
      if (verdict === 'forged' || verdict === 'failed test' || verdict === 'interrupted') assert.equal(session.state.phase, 'failed');
      if (verdict === 'allow') {
        nextFails = true;
        await session.submit('Follow-up change', true, undefined, true);
        assert.equal(session.state.phase, 'failed');
        assert.equal(writes, 1, 'an earlier approved edit must survive model failure');
        assert.deepEqual(session.state.changes, { paths: [path], status: 'applied' });
        assert.deepEqual(approved, ['allow', 'allow']);
        await session.undoAgent();
        assert.equal(writes, 0);
        assert.deepEqual(session.state.changes, { paths: [path], status: 'undone' });
      }
      assert.equal(await readFile(join(root, path), 'utf8'), source);
    } finally { await session.dispose(); await rm(root, { recursive: true, force: true }); }
  });
}

test('pytest verifies the overlay, bounds output, and stops the Windows process tree', { skip: !python, timeout: 35_000 }, async () => {
  assert.ok(python);
  const root = await mkdtemp(join(tmpdir(), 'vanta-agent-fixture-'));
  const snapshots = async () => (await readdir(tmpdir())).filter((file) => file.startsWith('vanta-verify-')).sort();
  const before = await snapshots();
  const target = 'test_calc.py';
  const prepare = (text: string) => writeFile(join(root, target), text);
  const repo = await Repository.bind({ path: root, isAvailable: () => true }, { ripgrep: false });
  const original = 'VALUE = 1\n';
  await writeFile(join(root, 'calc.py'), original);
  try {
    await prepare('from calc import VALUE\n\ndef test_value():\n    assert VALUE == 2\n');
    const files = [{ base: base('calc.py', original), after: 'VALUE = 2\n', ids: [1] }];
    const pass = await runPytest(repo, python, target, files, new AbortController().signal);
    assert.equal(pass.status, 'passed', pass.output);
    assert.match(pass.output, /1 passed/);
    assert.equal(await readFile(join(root, 'calc.py'), 'utf8'), original);
    await prepare('def test_bad():\n    print("Authorization: Bearer test-fixture-credential")\n    print("A" * 10000)\n    assert False\n');
    const fail = await runPytest(repo, python, target, [], new AbortController().signal);
    assert.equal(fail.exitCode, 1);
    assert.match(fail.output, /Potential credential redacted/);
    assert.match(fail.output, /Output truncated/);
    assert.doesNotMatch(fail.output, /test-fixture-credential/);
    const spawned = join(root, 'spawned.txt');
    const escaped = join(root, 'escaped.txt');
    const child = `from pathlib import Path; import time; time.sleep(4); Path(${JSON.stringify(escaped)}).touch()`;
    await prepare(`import subprocess, sys, time\nfrom pathlib import Path\n\ndef test_child():\n    subprocess.Popen([sys.executable, '-c', ${JSON.stringify(child)}])\n    Path(${JSON.stringify(spawned)}).touch()\n    time.sleep(30)\n`);
    const controller = new AbortController();
    const verification = runPytest(repo, python, target, [], controller.signal);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await access(spawned).then(() => true, () => false)) break;
      await sleep(100);
    }
    await access(spawned);
    controller.abort();
    const cancelled = await verification;
    assert.equal(cancelled.status, 'cancelled', cancelled.output);
    await sleep(4200);
    await assert.rejects(access(escaped));
    const timedOut = await runPytest(repo, python, target, [], new AbortController().signal, 50);
    assert.equal(timedOut.status, 'timed out');
    assert.deepEqual(await snapshots(), before);
    await rm(join(root, 'calc.py'));
    await assert.rejects(runPytest(repo, python, target, files, new AbortController().signal), /missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
