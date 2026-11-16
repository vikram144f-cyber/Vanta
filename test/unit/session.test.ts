import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { TrueForgeError, TrueForgeTimeoutError } from '@truefoundry/trueforge-sdk';
import type { OverviewBridge } from '../../src/mcp';
import { parseStudioAction } from '../../src/protocol';
import { StudioSession } from '../../src/session';
import { localServerUrl, modelFailure, overviewToolName } from '../../src/trueforge';
import type { ApprovalEvent, Event, Forge } from '../../src/trueforge';
import type { QuickTools } from '../../src/mcp';
import type { QuickEditTarget, Settings } from '../../src/session';
import { applyHunks, reviewTool } from '../../src/quickPatch';
import type { ReviewReceipt } from '../../src/quickPatch';

const model = 'fixture/model';
const createdAt = '2026-11-14T00:00:00.000Z';
const created: Event = { type: 'turn.created', turnId: 'turn-1', previousTurnId: null, id: 'turn-created', createdAt, threadId: null, state: { status: 'running' } };
const done: Event = { type: 'turn.done', id: 'done', createdAt, threadId: null, state: { status: 'done', completedAt: createdAt, output: null, requiredActions: [] } };
const failure = (message: string): Event => ({ type: 'turn.done', id: 'failure', threadId: null, createdAt,
  state: { status: 'error', message, completedAt: createdAt } });
const secondary = 'fixture/secondary';
const source: Event = {
  type: 'model.message', id: 'source', threadId: 'main', createdAt,
  toolCalls: [{ id: 'tool', type: 'function', function: { name: overviewToolName, arguments: '{}' },
    toolInfo: { type: 'mcp', name: overviewToolName, serverName: 'connector', serverId: 'connector' } }],
};
const pending: Event = { type: 'tool.approval_required', id: 'pending', createdAt, threadId: 'main', toolCalls: [{ id: 'tool', sourceEventId: 'source' }] };

test('provider limit classification preserves retry guidance and omits raw details', () => {
  assert.equal(modelFailure('429 GenerateRequestsPerDayPerProjectPerModel Please retry in 20s').limit, 'daily');
  assert.equal(modelFailure('429 GenerateRequestsPerDayPerProjectPerModel Please retry in 20s').retrySeconds, undefined);
  assert.equal(modelFailure('429 GenerateContentRequestsPerMinutePerProjectPerRegion Please retry in 5.2s').limit, 'rpm');
  assert.equal(modelFailure('429 GenerateContentRequestsPerMinutePerProjectPerRegion Please retry in 5.2s').retrySeconds, 6);
  assert.equal(modelFailure('RESOURCE_EXHAUSTED GenerateContentInputTokenCountPerMinute quota').limit, 'tpm');
  assert.equal(modelFailure('503 overload').limit, 'overload');
  assert.match(modelFailure('iteration limit of 32, please request again').detail, /tool iteration limit/);
  assert.doesNotMatch(modelFailure('429 nonsense synthetic-private-data').detail, /synthetic-private-data/);
});

function setup(overrides: Partial<Forge> = {}, edit?: (tools: QuickTools) => void, settings: Partial<Settings> = {}, streamIdleMs?: number) {
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
    settings: () => ({ serverUrl: 'http://localhost:8790', model, agentName: '', workspaceOverview: true, ...settings }),
    forge: () => forge,
    bridge: async (_signal, _name, _context, tools) => { if (tools) edit?.(tools); return bridge; },
    streamIdleMs,
  });
  return { session, calls, decisions };
}

test('invalid configured model requires an explicit selection even if only one model is registered', async () => {
  const { session, calls } = setup({}, undefined, { model: 'fixture/missing' });
  await session.refresh();
  assert.equal(session.state.connection.attention, true);
  assert.match(session.state.connection.detail, /configured model is unavailable/);
  assert.equal(session.state.connection.selectedModel, undefined);
  session.selectModel('fixture/missing');
  await session.submit('test');
  assert.deepEqual(calls, []);
  session.selectModel(model);
  await session.submit('test');
  assert.equal(session.state.phase, 'completed');
});

for (const [input, match] of [
  ['[Model Error] Request failed (404): Model fixture/removed not found', /did not recognize/],
  ["[Model Error] Request failed (400): 'messages.2' : for 'role:assistant' the following must be satisfied[('messages.2' : property 'reasoning_content' is unsupported)]", /provider rejected the conversation history/],
  ['503 SERVICE_UNAVAILABLE', /temporarily unavailable/],
  ['429 RESOURCE_EXHAUSTED retry in 12s', /Wait at least 12 seconds/],
  ['Cannot connect to API: Headers Timeout Error', /timed out/],
  ['Cannot connect to API: ECONNREFUSED', /could not reach the model provider/],
] as const) {
  test(`terminal model failure recovers Studio · ${input}`, async () => {
    const { session, calls, decisions } = setup({ start: async function* () {
      yield created;
      yield failure(`${input} synthetic-private-data`);
    } });
    await session.refresh();
    await session.submit('try this again', true);
    assert.equal(session.state.phase, 'failed');
    assert.match(session.state.error ?? '', match);
    assert.doesNotMatch(JSON.stringify(session.state), /synthetic-private-data/);
    assert.deepEqual(session.state.retry, { prompt: 'try this again', shareContext: true, agentMode: false });
    assert.deepEqual(calls, ['register', 'session', 'revoke', 'close', 'remove']);
    assert.deepEqual(decisions, []);
  });
}

for (const statusCode of [429, 503]) {
  test(`HTTP ${statusCode} before a turn is known does not replay the POST`, async () => {
    let posts = 0;
    const { session, calls } = setup({
      check: async () => ({ version: 'fixture', models: [model, secondary] }),
      start: async function* () { posts++; throw new TrueForgeError({ statusCode, body: { error: { message: 'synthetic-private-data' } } }); },
      resume: async function* () { assert.fail('no turn exists to resume'); },
    }, undefined, { secondaryModel: secondary });
    await session.refresh();
    await session.submit('test');
    assert.equal(session.state.phase, 'failed');
    assert.match(session.state.error ?? '', statusCode === 429 ? /rate or quota/ : /temporarily unavailable/);
    assert.doesNotMatch(JSON.stringify(session.state), /synthetic-private-data/);
    assert.equal(posts, 1);
    assert.ok(calls.includes('cancel'));
  });
}

test('an SDK request timeout clears the run without exposing its cause', async () => {
  const { session, calls } = setup({ start: async function* () { throw new TrueForgeTimeoutError('synthetic-private-data'); } });
  await session.refresh();
  await session.submit('test');
  assert.equal(session.state.phase, 'failed');
  assert.match(session.state.error ?? '', /TrueForge request timed out/);
  assert.doesNotMatch(JSON.stringify(session.state), /synthetic-private-data/);
  assert.deepEqual(calls, ['register', 'session', 'revoke', 'cancel', 'close', 'remove']);
});

test('an ambiguous approval is sent once and revokes local access', async () => {
  let posts = 0;
  const { session, calls } = setup({
    check: async () => ({ version: 'fixture', models: [model, secondary] }),
    start: async function* () { yield created; yield source; yield pending; },
    approve: async () => { posts++; throw new TrueForgeTimeoutError('no acknowledgement'); },
    resume: async function* () { assert.fail('approval was not acknowledged'); },
  }, undefined, { secondaryModel: secondary });
  await session.refresh();
  const waiting = new Promise<void>((resolve) => session.listen(() => { if (session.state.approval) resolve(); }));
  const run = session.submit('test');
  await waiting;
  await session.decide('tool', true);
  await run;
  assert.equal(posts, 1);
  assert.equal(session.state.approval, undefined);
  assert.equal(session.state.phase, 'cancelled');
  assert.match(session.state.error ?? '', /did not confirm the approval/);
  assert.equal(calls.filter((call) => call === 'session').length, 1);
  assert.ok(calls.includes('grant') && calls.includes('revoke') && calls.includes('cancel'));
  assert.ok(calls.indexOf('grant') < calls.indexOf('revoke') && calls.indexOf('revoke') < calls.indexOf('cancel'));
});

test('a paused approval outlives the stream idle timeout and resumes only after a click', async () => {
  const paused: Event = { type: 'turn.update', id: 'paused', createdAt, threadId: null, state: { status: 'paused' } };
  const { session, calls, decisions } = setup({
    start: async function* () { yield created; yield source; yield pending; yield paused; },
    resume: async function* (sessionId, turnId, cursor) {
      assert.deepEqual([sessionId, turnId, cursor], ['session-1', 'turn-1', paused.id]);
      yield done;
    },
  }, undefined, {}, 20);
  await session.refresh();
  const waiting = new Promise<void>((resolve) => session.listen(() => { if (session.state.approval) resolve(); }));
  const run = session.submit('test');
  await waiting;
  await sleep(60);
  assert.equal(session.state.phase, 'approval');
  assert.equal(decisions.length, 0);
  assert.ok(!calls.includes('cancel'));
  await session.decide('tool', true);
  await run;
  assert.deepEqual(decisions.map((decision) => decision.approval.status), ['allow']);
  assert.equal(session.state.phase, 'completed');
});

for (const cancel of [false, true]) {
  test(`a stalled stream that ignores the signal can be ${cancel ? 'cancelled' : 'timed out'}`, { timeout: 2000 }, async () => {
    let transport: AbortSignal | undefined;
    const { session, calls } = setup({
      start: async function* (_id, _prompt, signal) {
        transport = signal;
        yield created;
        await new Promise<void>(() => undefined);
      },
    }, undefined, {}, 20);
    await session.refresh();
    const streaming = new Promise<void>((resolve) => session.listen(() => { if (session.state.phase === 'streaming') resolve(); }));
    const run = session.submit('test');
    await streaming;
    if (cancel) await session.cancel();
    await run;
    assert.equal(session.state.phase, cancel ? 'cancelled' : 'failed');
    if (!cancel) assert.match(session.state.error ?? '', /timed out/);
    assert.ok(transport?.aborted);
    assert.ok(calls.includes('cancel'));
  });
}

test('a dropped stream rebuilds partial output from its cursor without starting a second turn', async () => {
  const reply: Event = { type: 'model.message', id: 'reply', threadId: 'main', createdAt };
  const fragment: Event = { type: 'model.message.delta', id: reply.id, threadId: 'main', content: 'partial' };
  let starts = 0;
  let resumes = 0;
  const { session, calls } = setup({
    start: async function* () { starts++; yield created; yield reply; yield fragment; throw new Error('stream disconnected'); },
    resume: async function* (sessionId, turnId, cursor, _signal, inclusive) {
      resumes++;
      assert.deepEqual([sessionId, turnId, cursor, inclusive], ['session-1', 'turn-1', 'reply', true]);
      yield reply; yield fragment; yield { ...fragment, content: ' reply' }; yield done;
    },
  });
  await session.refresh();
  await session.submit('test');
  assert.equal(session.state.phase, 'completed');
  assert.equal(session.state.messages.at(-1)?.text, 'partial reply');
  assert.deepEqual([starts, resumes, calls.filter((call) => call === 'session').length], [1, 1, 1]);
});

for (const mode of ['manual', 'fallback', 'secondary fails', 'secondary missing', 'model already active'] as const) {
  test(`model switching uses a fresh session with no replay of tools · ${mode}`, async () => {
    const starts: string[] = [];
    const models: string[] = [];
    const { session, calls, decisions } = setup({
      check: async () => ({ version: 'fixture', models: mode === 'secondary missing' ? [model] : [model, secondary] }),
      createSession: async (agent) => {
        models.push('spec' in agent ? agent.spec.model.name : '');
        return `session-${models.length}`;
      },
      start: async function* (id, _prompt, _signal, previousTurnId) {
        assert.equal(previousTurnId, undefined);
        starts.push(id);
        if (id === 'session-2') assert.ok(calls.includes('remove'), 'primary connector must be retired');
        yield created;
        if (mode === 'model already active') yield source;
        if (id === 'session-1' || mode === 'secondary fails') yield failure('503 unavailable');
        else yield done;
      },
    }, undefined, { secondaryModel: mode === 'manual' ? undefined : secondary });
    await session.refresh();
    await session.submit('test');
    if (mode === 'manual') {
      assert.equal(session.state.phase, 'failed');
      session.selectModel(secondary);
      await session.refresh();
      assert.equal(session.state.connection.selectedModel, secondary);
      await session.submit('test');
    }
    const switched = mode !== 'secondary missing' && mode !== 'model already active';
    assert.deepEqual(starts, switched ? ['session-1', 'session-2'] : ['session-1']);
    assert.deepEqual(models, switched ? [model, secondary] : [model]);
    assert.deepEqual(decisions, []);
    assert.equal(session.state.phase, mode === 'manual' || mode === 'fallback' ? 'completed' : 'failed');
    assert.equal(session.state.activity.some(({ label }) => label === 'Using configured secondary model'), mode === 'fallback' || mode === 'secondary fails');
  });
}

test('webview actions validate text and approval payloads', () => {
  assert.deepEqual(parseStudioAction({ type: 'submitPrompt', text: '  hello  ' }), { type: 'submitPrompt', text: 'hello' });
  assert.equal(parseStudioAction({ type: 'submitPrompt', text: 'x'.repeat(12_001) }), undefined);
  assert.equal(parseStudioAction({ type: 'submitPrompt', text: '   ' }), undefined);
  assert.equal(parseStudioAction({ type: 'decideApproval', id: 'other', allow: 'yes' }), undefined);
  assert.deepEqual(parseStudioAction({ type: 'decideApproval', id: 'id', allow: false }), { type: 'decideApproval', id: 'id', allow: false });
});

for (const mode of ['apply', 'discard', 'early cancel', 'stream cancel', 'staged cancel', 'pause cancel', 'missing receipt', 'stale', 'error after review'] as const) {
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
      check: async () => ({ version: 'fixture', models: [model, secondary] }),
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
        yield mode === 'error after review' ? failure('503 overloaded') : done;
      },
    }, (value) => { tools = value; }, mode === 'error after review' ? { secondaryModel: secondary } : undefined);
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
    if (mode === 'missing receipt' || mode === 'error after review') assert.equal(session.state.phase, 'failed');
    if (mode === 'error after review') {
      assert.match(session.state.error ?? '', /temporarily unavailable/);
      assert.throws(() => requireTools().receipt(proposalId), /authorization/);
      assert.equal(harness.calls.filter((call) => call === 'session').length, 1);
    }
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
