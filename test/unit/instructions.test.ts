import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentModeDefinition, inlineAgent } from '../../src/trueforge';
import { checkQuickTool, proposeTool, reviewTool } from '../../src/quickPatch';

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
  assert.match(instructions, /If invocation runs setup, trace whether it changes the test inputs/);
  assert.match(instructions, /A passing generated test alone does not establish/);
  assert.doesNotMatch(instructions, /flask|task b|redacting values by key|mixed.case|protected substrings|capitalization variants|normal unmasked|same dispatcher/i);
});

test('Quick Edit checks the staged draft against final behavior before native review', () => {
  const agent = inlineAgent('test/model', 'test-mcp', { propose: proposeTool, check: checkQuickTool, review: reviewTool });
  assert.ok('spec' in agent);
  const instructions = agent.spec.instructions ?? '';
  assert.match(instructions, /In a separate call to check_quick_edit/);
  assert.match(instructions, /relevant defaults, absent inputs, early exits, normalization, boundary cases and new behavior/);
  assert.match(instructions, /compare each relevant outcome with the draft documentation/);
  assert.match(instructions, /proposalId returned by check_quick_edit/);
  assert.deepEqual(agent.spec.mcpServers?.[0]?.preloadTools, [proposeTool, checkQuickTool, reviewTool]);
  assert.deepEqual(agent.spec.mcpServers?.[0]?.requireApprovalForTools, [reviewTool]);
  assert.doesNotMatch(instructions, /flask|get_debug_flag|task [ab]/i);
});
