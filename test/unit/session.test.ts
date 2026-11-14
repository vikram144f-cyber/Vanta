import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OverviewBridge } from '../../src/mcp';
import { parseStudioAction } from '../../src/protocol';
import { StudioSession } from '../../src/session';
import { localServerUrl, overviewToolName } from '../../src/trueforge';
import type { ApprovalEvent, Event, Forge } from '../../src/trueforge';
import type { QuickTools } from '../../src/mcp';
import type { QuickEditTarget } from '../../src/session';
import { applyHunks, reviewTool } from '../../src/quickPatch';
import type { ReviewReceipt } from '../../src/quickPatch';

const model = 'fixture/model';
const createdAt = '2026-11-14T00:00:00.000Z';
const created: Event = { type: 'turn.created', turnId: 'turn-1', previousTurnId: null, id: 'turn-created', createdAt, threadId: null, state: { status: 'running' } };
const done: Event = { type: 'turn.done', id: 'done', createdAt, threadId: null, state: { status: 'done', completedAt: createdAt, output: null, requiredActions: [] } };
const source: Event = {
  type: 'model.message', id: 'source', threadId: 'main', createdAt,
  toolCalls: [{ id: 'tool', type: 'function', function: { name: overviewToolName, arguments: '{}' },
    toolInfo: { type: 'mcp', name: overviewToolName, serverName: 'connector', serverId: 'connector' } }],
};
const pending: Event = { type: 'tool.approval_required', id: 'pending', createdAt, threadId: 'main', toolCalls: [{ id: 'tool', sourceEventId: 'source' }] };

function setup(overrides: Partial<Forge> = {}, edit?: (tools: QuickTools) => void) {
  const calls: string[] = [];
  const decisions: ApprovalEvent[] = [];
  const bridge: OverviewBridge = {
    name: 'connector', url: 'http://127.0.0.1:5000/mcp', authorization: 'fixture',
    grant: () => { calls.push('grant'); }, revoke: () => { calls.push('revoke'); },
    close: async () => { calls.push('close'); },
  };
  const forge: Forge = {
    check: async () => ({ version: 'fixture', models: [model] }),
    createSession: async () => { calls.push('session'); return 'session-1'; },
    start: async function* () { yield created; yield done; },
    resume: async function* () { yield done; },
    approve: async (_sessionId, _turnId, event) => { decisions.push(event); },
    cancel: async () => { calls.push('cancel'); },
    register: async () => { calls.push('register'); },
    remove: async () => { calls.push('remove'); },
    ...overrides,
  };
  const session = new StudioSession({
    settings: () => ({ serverUrl: 'http://localhost:8790', model, agentName: '', workspaceOverview: true }),
    forge: () => forge,
    bridge: async (_signal, _name, _context, tools) => { if (tools) edit?.(tools); return bridge; },
  });
  return { session, calls, decisions };
}

test('webview actions validate text and approval payloads', () => {
  assert.deepEqual(parseStudioAction({ type: 'submitPrompt', text: '  hello  ' }), { type: 'submitPrompt', text: 'hello' });
  assert.equal(parseStudioAction({ type: 'submitPrompt', text: 'x'.repeat(12_001) }), undefined);
  assert.equal(parseStudioAction({ type: 'submitPrompt', text: '   ' }), undefined);
  assert.equal(parseStudioAction({ type: 'decideApproval', id: 'other', allow: 'yes' }), undefined);
  assert.deepEqual(parseStudioAction({ type: 'decideApproval', id: 'id', allow: false }), { type: 'decideApproval', id: 'id', allow: false });
});

for (const mode of ['apply', 'discard', 'early cancel', 'stream cancel', 'staged cancel', 'pause cancel', 'missing receipt', 'stale'] as const) {
  test(`Quick Edit state machine · ${mode}`, async () => {
    let tools: QuickTools | undefined;
    let proposalId = '';
    let receipt: ReviewReceipt | undefined;
    let transferred: ApprovalEvent | undefined;
    const original = 'one\nkeep\nthree\n';
    let buffer = original;
    const base = { path: 'source.py', version: 1, text: original, start: 0, end: original.length, eol: '\n' as const };
    const requireTools = () => { assert.ok(tools); return tools; };
    const harness = setup({
      start: async function* () {
        if (mode === 'early cancel') { await harness.session.cancel(); return; }
        yield created;
        if (mode === 'stream cancel') {
          yield { type: 'model.message.delta', id: 'text', threadId: 'main', content: 'Planning' };
          await harness.session.cancel();
          return;
        }
        proposalId = requireTools().stage('ONE\nkeep\nTHREE\n', 'Change two lines').id;
        if (mode === 'staged cancel') { await harness.session.cancel(); return; }
        yield { type: 'model.message', id: 'source', threadId: 'main', createdAt };
        yield { type: 'model.message.delta', id: 'source', threadId: 'main', toolCalls: [{ index: 0, id: 'tool', type: 'function',
          toolInfo: { type: 'mcp', name: reviewTool, serverName: 'connector', serverId: 'connector' },
          function: { name: reviewTool, arguments: '{"proposalId":"' } }] };
        yield { type: 'model.message.delta', id: 'source', threadId: 'main', toolCalls: [{ index: 0, function: { arguments: `${proposalId}"}` } }] };
        yield pending;
        yield pending;
      },
      approve: async (_sessionId, _turnId, decision) => {
        transferred = decision;
        if (decision.approval.status === 'allow' && mode !== 'missing receipt') receipt = requireTools().receipt(proposalId);
      },
      resume: async function* () {
        if (transferred) yield { ...transferred, id: 'approval', createdAt };
        if (receipt) yield { type: 'tool.response', id: 'receipt', threadId: 'main', toolCallId: 'tool', content: JSON.stringify(receipt), createdAt };
        yield done;
      },
    }, (value) => { tools = value; });
    const { session } = harness;
    let reviewId = '';
    const target: QuickEditTarget = { base, evidence: '{"selected":"fixture"}', verify: async () => {
      if (mode === 'stale' && reviewId) throw new Error('stale');
    }, preview: async () => { assert.equal(buffer, original); }, apply: async (hunks, _digest, _signal, commit) => {
      commit();
      buffer = applyHunks(base, hunks);
    } };
    await session.refresh();
    const shown = new Promise<string>((resolve) => session.listen(() => {
      if (session.state.review) resolve(session.state.review.id);
    }));
    const running = session.submit('Edit', true, target);
    if (!['early cancel', 'stream cancel', 'staged cancel'].includes(mode)) {
      reviewId = await shown;
      assert.throws(() => requireTools().receipt(proposalId), /authorization/);
      await session.decide('tool', true); // Overview controls cannot approve a patch.
      assert.equal(transferred, undefined);
      assert.equal(buffer, original);
      if (mode === 'pause cancel') await session.cancel();
      else if (mode === 'discard') await session.finishReview(reviewId, false);
      else {
        await session.reviewHunk(reviewId, 1, 'rejected');
        await session.reviewHunk(reviewId, 2, 'accepted');
        await session.finishReview(reviewId, true);
        if (mode === 'stale') { assert.ok(session.state.error); await session.cancel(); }
      }
    }
    await running;
    assert.equal(buffer, mode === 'apply' ? 'one\nkeep\nTHREE\n' : original);
    assert.equal(session.state.review, undefined);
    if (mode === 'missing receipt') assert.equal(session.state.phase, 'failed');
    if (mode === 'discard') assert.equal((transferred as ApprovalEvent | undefined)?.approval.status, 'deny');
    if (mode.includes('cancel')) assert.equal(session.state.phase, 'cancelled');
    await session.cancel();
    await session.dispose();
  });
}

test('server settings reject non-local endpoints and embedded credentials', () => {
  assert.equal(localServerUrl('http://localhost:8790').origin, 'http://localhost:8790');
  for (const url of ['http://localhost.example.com', 'ftp://localhost', 'http://token@localhost', 'http://localhost/path']) {
    assert.throws(() => localServerUrl(url));
  }
});

test('connection errors are actionable and omit raw error details', async () => {
  const { session } = setup({ check: async () => { throw new Error('fixture-private-data'); } });
  await session.refresh();
  assert.equal(session.state.connection.status, 'offline');
  assert.match(session.state.connection.detail, /local server/);
  assert.doesNotMatch(session.state.connection.detail, /fixture-private-data/);
  await session.dispose();
});

test('real event shapes update the transcript incrementally and release run resources', async () => {
  const { session, calls } = setup({ start: async function* () {
    yield created;
    yield { type: 'model.message.delta', id: 'text', threadId: 'main', content: 'First ' };
    yield { type: 'model.message.delta', id: 'text', threadId: 'main', content: 'second' };
    yield done;
  } });
  await session.refresh();
  let interim = false;
  const unlisten = session.listen(() => { interim ||= session.state.messages.some((message) => message.text === 'First '); });
  await Promise.all([session.submit('test'), session.submit('duplicate')]);
  assert.ok(interim);
  assert.equal(session.state.messages.at(-1)?.text, 'First second');
  assert.equal(session.state.phase, 'completed');
  assert.deepEqual(calls, ['register', 'session', 'close', 'remove']);
  unlisten();
  await session.dispose();
});

test('reject posts a native deny, ignores stale approvals and never grants tool access', async () => {
  const { session, decisions, calls } = setup({ start: async function* () { yield created; yield source; yield pending; } });
  await session.refresh();
  const unlisten = session.listen(() => {
    if (session.state.approval) {
      void session.decide('stale', true);
      void session.decide(session.state.approval.id, false);
    }
  });
  await session.submit('test');
  assert.equal(session.state.phase, 'completed');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.approval.status, 'deny');
  assert.ok(!calls.includes('grant'));
  unlisten();
  await session.dispose();
});

test('disposing a paused run revokes the bridge, cancels the remote session and removes the connector', async () => {
  const { session, calls } = setup({ start: async function* () { yield created; yield source; yield pending; } });
  await session.refresh();
  const pause = new Promise<void>((resolve) => { session.listen(() => { if (session.state.approval) resolve(); }); });
  const running = session.submit('test');
  await pause;
  await session.dispose();
  await running;
  assert.equal(session.state.phase, 'cancelled');
  assert.deepEqual(calls, ['register', 'session', 'revoke', 'cancel', 'close', 'remove']);
});

test('follow-ups reuse the session and chain from the completed turn until explicitly reset', async () => {
  const starts: [string, string | undefined][] = [];
  const { session, calls } = setup({ start: async function* (id, _prompt, _signal, previous) {
    starts.push([id, previous]); yield created; yield done;
  } });
  await session.refresh();
  await session.submit('first');
  await session.submit('follow up');
  assert.deepEqual(starts, [['session-1', undefined], ['session-1', 'turn-1']]);
  assert.equal(calls.filter((call) => call === 'session').length, 1);
  assert.equal(calls.filter((call) => call === 'remove').length, 2);
  session.clear();
  await session.submit('new conversation');
  assert.equal(calls.filter((call) => call === 'session').length, 2);
  await session.dispose();
});
