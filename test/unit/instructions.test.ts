import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentModeDefinition, inlineAgent } from '../../src/trueforge';

test('Agent Mode derives implementation and test expectations from the request and repository', () => {
  const agent = agentModeDefinition('test/model', 'test-mcp', {
    stage: 'stage_file_edit', review: 'review_changes', verify: 'run_verification',
  });
  assert.ok('spec' in agent);
  const instructions = agent.spec.instructions ?? '';
  assert.match(instructions, /requirements and edge cases from the user's request/);
  assert.match(instructions, /inspect existing repository patterns/);
  assert.match(instructions, /Preserve unrelated behavior and do not invent requirements/);
  assert.match(instructions, /normal, boundary and failure behavior/);
  assert.match(instructions, /A passing generated test alone does not establish/);
  assert.doesNotMatch(instructions, /flask|task b|redacting values by key|mixed.case|protected substrings|capitalization variants|normal unmasked|same dispatcher/i);
});

test('Quick Edit derives documented outcomes from the request and code', () => {
  const agent = inlineAgent('test/model', 'test-mcp', { propose: 'propose', review: 'review' });
  assert.ok('spec' in agent);
  const instructions = agent.spec.instructions ?? '';
  assert.match(instructions, /trace each branch of the modified code/);
  assert.match(instructions, /outcomes relevant to the request and supported by the code/);
  assert.doesNotMatch(instructions, /flask|task a|missing input|empty input|constructor\/default|short.circuit/i);
});
