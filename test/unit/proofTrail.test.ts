import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StudioState } from '../../src/protocol';
import { ProofTrail, proofReceipt } from '../../src/proofTrail';
import { proofMarkup } from '../../src/proofTrailView';

const state: StudioState = {
  phase: 'idle', conversationId: 'example', agentMode: true,
  connection: { status: 'offline', detail: '', models: [] }, messages: [], activity: [],
};

test('ProofTrail keeps observation order across fallback, review, verification and late Undo', () => {
  const trail = new ProofTrail();
  trail.start(state.conversationId, 'Agent Mode', 'Update the widget');
  const primary = { ...state, phase: 'streaming' as const, activeModel: 'primary', sessionId: 'first-session' };
  trail.observe(state, primary);
  trail.add({ kind: 'provider-failure', detail: 'Provider unavailable' });
  trail.activity('Using configured secondary model', 'secondary');
  const retry = { ...primary, activeModel: 'secondary', sessionId: 'second-session' };
  trail.observe(primary, retry);
  const reports: StudioState['context'] = [{ operation: 'Search', hits: [{ path: 'src/widget.py', start: 2, end: 4,
    reason: 'Exact symbol', selected: true }, { path: 'unused.py', start: 1, end: 1, reason: 'Candidate', selected: false }],
  estimatedTokens: 40, budget: 100, omitted: 0, limited: false }];
  trail.observe(retry, { ...retry, context: reports });
  trail.staged('src/widget.py', 'first\nsecond', [{ id: 1, start: 6 }]);
  const inReview: StudioState = { ...retry, review: { id: 'draft', path: 'src/widget.py', explanation: '', current: 1,
    hunks: [{ id: 1, line: 2, status: 'pending' }] } };
  trail.observe(retry, inReview);
  const accepted: StudioState = { ...inReview, review: { ...inReview.review!, hunks: [{ id: 1, line: 2, status: 'accepted' }] } };
  trail.observe(inReview, accepted);
  trail.observe(accepted, { ...accepted, review: { ...accepted.review! } });
  trail.add({ kind: 'review-submitted', decision: 'approve selection' });
  trail.approval('call-1', 'review_changes', 'allow');
  trail.approval('call-1', 'review_changes', 'allow');
  trail.observe(retry, { ...retry, verification: { command: 'python -m pytest test_widget.py -q', status: 'passed', exitCode: 0 } });
  trail.activity('Agent changes applied to buffers');
  const undo = trail.undoCallback();
  trail.finish('completed');
  assert.equal(trail.read(retry), undefined);
  trail.start('another', 'Quick Edit', 'Another task');
  undo();
  const record = trail.read({ ...retry, phase: 'completed' })!;
  assert.deepEqual(record.events.map(({ kind }) => kind), ['task', 'session', 'provider-failure', 'fallback', 'session', 'context',
    'proposal', 'review', 'review-submitted', 'approval', 'verification', 'outcome', 'finished', 'outcome']);
  assert.match(proofMarkup(record), /undone in editor buffers/);
  assert.doesNotMatch(proofMarkup(record), /unused\.py/);
});

test('old and incomplete records state what is missing without making up approvals or verification', () => {
  const trail = new ProofTrail();
  assert.equal(trail.read(state), undefined);
  const record = trail.read({ ...state, phase: 'failed', sessionId: 'historical-session',
    activity: [{ label: 'Approved review_changes', detail: 'posted' }, { label: 'Primary model failed' }] })!;
  assert.deepEqual(record.events.map(({ kind }) => kind), ['task', 'provider-failure', 'finished']);
  const markup = proofMarkup(record);
  assert.match(markup, /Original task unavailable/);
  assert.match(markup, /Unavailable in this trail/);
  assert.doesNotMatch(markup, /TrueForge approval observed/);
  trail.clear();
  assert.equal(trail.read({ ...state, phase: 'completed', agentMode: false }), undefined);
});

test('JSON receipts omit free text, raw output, identifiers and paths and keep file aliases consistent', () => {
  const trail = new ProofTrail();
  const secret = 'sk-secret-token-984032840238 PRIVATE-PROMPT';
  const path = 'C:\\Users\\private\\client.py';
  const done: StudioState = { ...state, phase: 'completed' };
  trail.start(state.conversationId, 'Agent Mode', `<script>${secret}</script>`);
  trail.add({ kind: 'session', model: secret, session: secret });
  trail.add({ kind: 'context', operation: secret, hits: [{ path, start: 2, end: 3, reason: secret }],
    estimatedTokens: 20, budget: 8000, limited: false });
  trail.staged(path, 'line\nline', [{ id: 1, start: 5 }]);
  trail.add({ kind: 'review', decisions: [{ path, hunk: 1, decision: 'accepted' }] });
  trail.observe(state, { ...state, verification: { command: `pytest "${path}"`, status: 'passed', exitCode: 0, output: secret } });
  trail.add({ kind: 'provider-failure', detail: secret });
  trail.finish('completed');
  const record = trail.read(done)!;
  const markup = proofMarkup(record);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  const json = proofReceipt(record);
  assert.doesNotMatch(json, /secret|PRIVATE|Users|client\.py|script/);
  const receipt = JSON.parse(json);
  assert.equal(receipt.events[2].hits[0].file, 'File 1');
  assert.equal(receipt.events[3].files[0].file, 'File 1');
  assert.equal(receipt.events[4].decisions[0].file, 'File 1');
  assert.deepEqual(receipt.events[5], { kind: 'verification', profile: 'pytest', status: 'passed', exitCode: 0 });
});
