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
import { checkPythonSyntax, runPytest, verificationTarget } from '../../src/verification';
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

test('the verification and application receipt includes only the three accepted hunks', () => {
  const patch = new AgentPatch();
  for (const path of ['a.py', 'b.py', 'c.py', 'd.py']) {
    patch.stage(base(path, 'value = 1\n'), { path, summary: 'Update value', edits: [{ old: 'value = 1', replacement: 'value = 2' }] });
  }
  const stale = { ...patch.reference, revision: 3 };
  for (const [path, file] of patch.files) file.hunks[0]!.status = path === 'd.py' ? 'rejected' : 'accepted';
  patch.authorize(binding);
  assert.throws(() => patch.consume(stale), /matching/);
  const receipt = patch.consume(patch.reference);
  const files = patch.approved(receipt);
  assert.deepEqual(receipt.files, ['a.py', 'b.py', 'c.py']);
  assert.deepEqual(files.map(({ base: file, after }) => [file.path, after]), [
    ['a.py', 'value = 2\n'], ['b.py', 'value = 2\n'], ['c.py', 'value = 2\n'],
  ]);
  assert.throws(() => patch.consume(patch.reference), /matching/);
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

for (const verdict of ['allow', 'deferred', 'deny review', 'repeat after denial', 'revision failure', 'revision cancellation', 'rejected staging loop', 'invalid syntax', 'deny', 'cancel', 'failed test', 'interrupted', 'forged'] as const) {
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
    let repeatReview: boolean = verdict === 'repeat after denial';
    let cancellations = 0;
    let captures = 0;
    let sessions = 0;
    let workspace = root;
    let cancelNext = false;
    const inputs: string[] = [];
    const decisions: ApprovalEvent[] = [];
    const approved: string[] = [];
    const createdAt = '2026-11-14T00:00:00Z';
    const pause = function* (name: string, args: unknown, id = name): Generator<Event> {
      const deferred = verdict === 'deferred';
      yield { type: 'model.message', id, createdAt, threadId: 'main', toolCalls: [{ id, type: 'function',
        function: { name: deferred ? 'call_tool' : name, arguments: JSON.stringify(deferred ? { mcp_server: 'test-mcp', tool_name: name, input: args } : args) },
        toolInfo: deferred ? { type: 'truefoundry-system', name: 'call_tool' } : { type: 'mcp', name, serverName: 'test-mcp', serverId: 'test' } }] };
      yield { type: 'tool.approval_required', id: id + '-pause', createdAt, threadId: 'main', toolCalls: [{ id, sourceEventId: id }] };
    };
    const response = (toolCallId: string, payload: unknown): Event => ({ type: 'tool.response', id: toolCallId + '-result',
      createdAt, threadId: 'main', toolCallId, content: JSON.stringify(payload) });
    const session = new StudioSession({
      settings: () => ({ serverUrl: 'http://localhost:8790', agentName: '', model: 'fixture', workspaceOverview: true, verificationPython: python }),
      forge: (): Forge => ({
        check: async () => ({ version: 'fixture', models: ['fixture'] }),
        createSession: async () => `fixture-session-${++sessions}`,
        start: async function* (_session, input) {
          inputs.push(input);
          yield { type: 'turn.created', id: 'turn', turnId: 'turn', previousTurnId: null, createdAt, threadId: null, state: { status: 'running' } };
          if (cancelNext) {
            await session.cancel();
            return;
          }
          if (nextFails) {
            yield { type: 'turn.done', id: 'failure', createdAt, threadId: null, state: { status: 'error', message: '503 unavailable', completedAt: createdAt } };
            return;
          }
          if (verdict === 'allow' || verdict === 'rejected staging loop') {
            const bad = { path, summary: 'Invalid anchor', edits: [{ old: 'assert True\\n', replacement: 'assert 1 == 1' }] };
            await assert.rejects(tools.stage(bad), /missing an exact anchor/);
            await assert.rejects(tools.stage({ ...bad, summary: 'Same edit' }), /already rejected:.*Change the anchor/);
            assert.equal(captures, 1, 'an identical rejected edit is not captured again');
            if (verdict === 'rejected staging loop') {
              await assert.rejects(tools.stage(bad), /already rejected/);
              return;
            }
          }
          const { proposalId, revision } = await tools.stage({ path, summary: 'Add an assertion',
            edits: [{ old: '    assert True', replacement: verdict === 'invalid syntax' ? 'assert True\n    return'
            : verdict === 'failed test' && inputs.length === 1 ? '    assert False' : '    assert 1 == 1' }] }) as typeof reference;
          reference = { proposalId, revision };
          yield* pause('review_changes', reference);
        },
        resume: async function* () {
          yield { ...last, id: last.toolCallId + '-allow', createdAt };
          if (last.toolCallId === 'review_changes' && last.approval.status === 'deny') {
            yield { type: 'turn.update', id: 'running', createdAt, threadId: null, state: { status: 'running' } };
            yield response(last.toolCallId, { error: [{ type: 'text', text: JSON.stringify({ error: 'User denied tool call: The user declined this operation.' }) }] });
            // Reconnect may replay the original pause. The recorded trace then used a new call ID for the same revision.
            yield { type: 'tool.approval_required', id: 'review-replay', createdAt, threadId: 'main',
              toolCalls: [{ id: last.toolCallId, sourceEventId: 'review_changes' }] };
            if (repeatReview) {
              repeatReview = false;
              yield* pause('review_changes', reference, 'repeat-review');
              yield { type: 'turn.update', id: 'paused-again', createdAt, threadId: null, state: { status: 'paused' } };
              yield { type: 'turn.done', id: 'cancelled', createdAt, threadId: null,
                state: { status: 'cancelled', completedAt: createdAt, reason: 'client-cancelled' } };
              return;
            }
          }
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
        approve: async (_session, _turn, decision) => { last = decision; decisions.push(decision); approved.push(decision.approval.status); },
        register: async () => undefined, remove: async () => undefined, cancel: async () => { cancellations++; },
      }),
      scopeKey: () => workspace,
      agentWorkspace: async () => ({ repository: repo, capture: async () => { captures++; return base(path, source); }, preview: async () => undefined,
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
      if (verdict === 'rejected staging loop') {
        await run;
        assert.equal(session.state.phase, 'cancelled');
        assert.equal(captures, 1);
        assert.equal(cancellations, 1);
        assert.deepEqual(approved, []);
        assert.ok(session.state.activity.some(({ label, detail }) => label === 'Agent staging stopped' && detail?.includes('Change the anchor')));
        assert.equal(writes, 0);
        return;
      }
      const shown = await review;
      assert.throws(() => tools.review(reference), /local patch approval/);
      await session.decide('review_changes', true);
      assert.deepEqual(approved, []);
      if (verdict === 'invalid syntax') {
        assert.match(shown.blocked ?? '', /test_fixture\.py:\d+:\d+: IndentationError/);
        const hunk = shown.hunks[0]!;
        await session.reviewHunk(shown.id, hunk.id, 'view');
        await session.reviewHunk(shown.id, hunk.id, 'accepted');
        await session.finishReview(shown.id, true);
        assert.equal(session.state.review?.hunks[0]?.status, 'pending');
        assert.equal(approved.length, 0);
        assert.equal(session.state.verification, undefined);
      } else assert.equal(shown.blocked, undefined);
      if (verdict === 'deny review' || verdict === 'repeat after denial' || verdict === 'invalid syntax'
        || verdict === 'revision failure' || verdict === 'revision cancellation') {
        await Promise.all([session.finishReview(shown.id, false), session.finishReview(shown.id, false),
          session.finishReview(shown.id, true), session.decide('repeat-review', true)]);
        await run;
        assert.deepEqual(approved, ['deny']);
        assert.equal(decisions[0]?.toolCallId, 'review_changes');
        assert.equal(decisions[0]?.threadId, 'main');
        const discarded = session.state;
        assert.equal(discarded.error, undefined);
        assert.equal(discarded.review, undefined);
        assert.equal(discarded.approval, undefined);
        assert.ok(session.state.activity.some(({ label }) => label === 'Agent changes discarded'));
        assert.equal(session.state.phase, verdict === 'repeat after denial' ? 'cancelled' : 'completed');
        assert.equal(cancellations, verdict === 'repeat after denial' ? 1 : 0);
        assert.equal(discarded.revision?.id, shown.id);
        assert.equal(discarded.revision?.needsFeedback, verdict !== 'invalid syntax');
        if (verdict === 'revision failure' || verdict === 'revision cancellation') {
          const feedback = 'The output violates the contract.';
          workspace = join(root, 'different-workspace');
          await session.reviseProposal(shown.id, feedback);
          assert.deepEqual(inputs, ['Change the test']);
          workspace = root;
          nextFails = verdict === 'revision failure';
          cancelNext = verdict === 'revision cancellation';
          await session.reviseProposal(shown.id, feedback);
          assert.equal(inputs.length, 2);
          assert.equal(sessions, 2);
          assert.equal(session.state.phase, nextFails ? 'failed' : 'cancelled');
          assert.equal(session.state.revision, undefined);
          assert.deepEqual(approved, ['deny']);
        }
        if (verdict === 'repeat after denial') {
          await session.reviseProposal(shown.id, '');
          await session.reviseProposal('stale', 'The checker rejected the staged output.');
          assert.deepEqual(inputs, ['Change the test']);
          const nextReview = when(() => session.state.review);
          const feedback = 'The checker rejected the staged output.';
          const nextRun = session.reviseProposal(shown.id, feedback);
          await session.reviseProposal(shown.id, feedback);
          const next = await nextReview;
          assert.notEqual(next.id, shown.id);
          assert.equal(inputs.length, 2);
          assert.match(inputs[1]!, /Change the test\n\nRevise the failed proposal/);
          assert.ok(inputs[1]?.includes(feedback));
          assert.ok(inputs[1]?.includes('assert 1 == 1'));
          await session.finishReview(shown.id, false);
          assert.equal(session.state.review?.id, next.id);
          assert.deepEqual(approved, ['deny']);
          await session.finishReview(next.id, false);
          await nextRun;
          assert.deepEqual(approved, ['deny', 'deny']);
          assert.equal(session.state.phase, 'completed');
          assert.equal(session.state.revision, undefined);
          assert.equal(cancellations, 1);
        }
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
      if (verdict === 'failed test') {
        assert.equal(session.state.verification?.exitCode, 1);
        assert.deepEqual(session.state.revision, { id: shown.id, needsFeedback: true });
        assert.equal(await readFile(join(root, path), 'utf8'), source);
        const freshReview = when(() => session.state.review);
        const freshVerification = when(() => session.state.approval);
        const correction = session.reviseProposal(shown.id, 'The generated assertion is always false.');
        const revised = await freshReview;
        assert.notEqual(revised.id, shown.id);
        assert.equal(sessions, 2);
        assert.match(inputs[1]!, /failed, exit 1/);
        assert.match(inputs[1]!, /assert False/);
        await session.finishReview(shown.id, true);
        assert.deepEqual(approved, ['allow', 'allow']);
        await session.reviewHunk(revised.id, revised.hunks[0]!.id, 'accepted');
        await session.finishReview(revised.id, true);
        const fresh = await freshVerification;
        assert.equal(writes, 0);
        await session.decide(fresh.id, true);
        await correction;
        assert.deepEqual(approved, ['allow', 'allow', 'allow', 'allow']);
        assert.equal(session.state.verification?.status, 'passed');
        assert.equal(writes, 1);
        await session.undoAgent();
        assert.equal(writes, 0);
      }
      if (verdict === 'forged' || verdict === 'interrupted') assert.equal(session.state.phase, 'failed');
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

test('pre-review Python syntax check compiles staged source without importing or executing it', { skip: !python }, async () => {
  assert.ok(python);
  const signal = AbortSignal.timeout(5000);
  const result = await checkPythonSyntax(python, [
    { path: 'source/app.py', text: 'raise RuntimeError("would fail if executed")\n' },
    { path: 'docs/readme.txt', text: 'Not Python (' },
  ], signal);
  assert.equal(result?.exitCode, 0);
  assert.equal(result?.output, '');
});
