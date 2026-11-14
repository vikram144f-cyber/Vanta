import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OverviewBridge } from '../../src/mcp';
import { parseStudioAction } from '../../src/protocol';
import { StudioSession } from '../../src/session';
import { localServerUrl, overviewToolName } from '../../src/trueforge';
import type { ApprovalEvent, Event, Forge } from '../../src/trueforge';

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

function setup(overrides: Partial<Forge> = {}) {
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
    bridge: async () => bridge,
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
