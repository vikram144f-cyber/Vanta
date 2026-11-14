import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startOverviewBridge } from '../../src/mcp';
import { StudioSession } from '../../src/session';
import { overviewToolName, TrueForgeClient } from '../../src/trueforge';

const model = process.env.VANTA_LIVE_MODEL;
const serverUrl = process.env.VANTA_LIVE_URL ?? 'http://localhost:8790';

test('live TrueForge streaming and optionally MCP allow/deny and cancellation', { skip: !model, timeout: 100_000 }, async () => {
  assert.ok(model);
  const root = await mkdtemp(join(tmpdir(), 'vanta-live-'));
  const folderName = 'fixture-slate';
  const session = new StudioSession({
    settings: () => ({ serverUrl, model, agentName: '', workspaceOverview: true }),
    forge: (url) => new TrueForgeClient(url),
    bridge: (signal) => startOverviewBridge({ path: root, isAvailable: () => true }, signal),
  });
  let choice: 'allow' | 'deny' | 'cancel' = 'allow';
  let streamUpdates = 0;
  let previousLength = 0;
  let didApprove = false;
  const stop = session.listen(() => {
    const { approval, phase, messages } = session.state;
    const length = messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('').length;
    if (phase === 'streaming' && length > previousLength) streamUpdates++;
    previousLength = length;
    if (approval?.canAllow && (choice === 'allow' || choice === 'deny')) {
      didApprove = true;
      void session.decide(approval.id, choice === 'allow');
    }
    if (approval?.canAllow && choice === 'cancel') void session.cancel();
  });
  try {
    await mkdir(join(root, folderName));
    await writeFile(join(root, 'README.md'), 'VANTA synthetic live fixture.');
    await session.refresh();
    assert.equal(session.state.connection.status, 'connected', session.state.connection.detail);
    assert.equal(session.state.connection.selectedModel, model);
    console.log(`Live TrueForge ${session.state.connection.version} with ${model}`);
    await session.submit('Hello VANTA. Explain in two sentences what an AI coding agent does.');
    assert.equal(session.state.phase, 'completed', JSON.stringify({ error: session.state.error, activity: session.state.activity }));
    assert.ok(streamUpdates > 1, `Received only ${streamUpdates} streamed updates`);
    assert.ok(session.state.messages.some((m) => m.role === 'assistant' && m.text.length > 20));
    console.log(`Chat session ${session.state.sessionId}, ${streamUpdates} incremental updates`);
    if (process.env.VANTA_LIVE_MCP !== '1') return;

    const inspect = 'Inspect the current workspace and tell me which top-level folders exist.';
    for (const decision of ['allow', 'deny', 'cancel'] as const) {
      choice = decision;
      didApprove = false;
      session.clear();
      await session.submit(inspect);
      const activity = session.state.activity;
      const description = JSON.stringify({ error: session.state.error, activity });
      assert.ok(activity.some((item) => item.detail === overviewToolName && item.label === 'Tool requested'), description);
      assert.ok(activity.some((item) => item.label === 'Waiting for approval'), description);
      if (decision === 'cancel') {
        assert.equal(session.state.phase, 'cancelled', description);
        assert.equal(session.state.error, undefined, description);
        assert.ok(!activity.some((item) => item.label === 'Tool returned'));
      } else {
        assert.equal(session.state.phase, 'completed', description);
        assert.ok(didApprove, description);
        assert.ok(activity.some((item) => item.label === (decision === 'allow' ? 'Approved workspace overview' : 'Rejected workspace overview')), description);
        const transcript = session.state.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
        assert.equal(transcript.includes(folderName), decision === 'allow', description);
        if (decision === 'allow') assert.ok(activity.some((item) => item.label === 'Tool returned'), description);
      }
      assert.ok(!activity.some((item) => item.label === 'Connector cleanup incomplete'), description);
      console.log(`Workspace ${decision} session ${session.state.sessionId}`);
    }
  } finally {
    stop();
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
