import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { startOverviewBridge } from '../../src/mcp';
import { Repository } from '../../src/repository';
import { StudioSession } from '../../src/session';
import { TrueForgeClient } from '../../src/trueforge';

const model = process.env.VANTA_LIVE_MODEL;
const root = process.env.VANTA_FLASK_ROOT;

test('live Flask repository discovery, deferred tools, mentions and continuity', { skip: !root || !model, timeout: 140_000 }, async (test) => {
  assert.ok(root && model);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
  assert.equal(git('status', '--porcelain'), '');
  const scope = { path: root, isAvailable: () => true };
  const session = new StudioSession({
    settings: () => ({ serverUrl: process.env.VANTA_LIVE_URL ?? 'http://localhost:8790', model, agentName: '', workspaceOverview: true }),
    forge: (url) => new TrueForgeClient(url),
    repository: () => Repository.bind(scope), scopeKey: () => root,
    bridge: (signal, name, context) => startOverviewBridge(scope, signal, name, context),
  });
  const returned = () => session.state.context?.flatMap((report) => report.hits.filter((hit) => hit.selected)) ?? [];
  const release = session.listen(() => {
    const approval = session.state.approval;
    if (approval) void session.decide(approval.id, false);
  });
  const cancel = () => { void session.cancel(); };
  test.signal.addEventListener('abort', cancel, { once: true });
  try {
    await session.refresh();
    assert.equal(session.state.connection.status, 'connected', session.state.connection.detail);
    await session.submit('Find the parts of this repository responsible for built-in Flask CLI commands, related tests and documentation. Explain which files would probably need changes to add a new CLI command. Do not modify anything.', true);
    assert.equal(session.state.phase, 'completed', JSON.stringify({ error: session.state.error, activity: session.state.activity }));
    const paths = ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst'];
    for (const path of paths) assert.ok(returned().some((hit) => hit.path === path), JSON.stringify(returned().slice(0, 14)));
    console.log('Flask discovery:', returned().filter((hit) => paths.includes(hit.path)).map((hit) => `${hit.path}:${hit.start}–${hit.end}`).join(', '));
    const forges = session.state.activity.filter((item) => item.label === 'Tool requested').map((item) => item.detail);
    assert.ok(forges.includes('call_tool'), JSON.stringify(forges));
    const sessionId = session.state.sessionId;
    console.log('Deferred tools:', forges.join(', '), 'session', sessionId);

    await session.submit('Find the get_debug_flag function and show me its definition and relevant context.', true);
    assert.equal(session.state.phase, 'completed', JSON.stringify({ error: session.state.error, activity: session.state.activity }));
    assert.equal(session.state.sessionId, sessionId);
    assert.ok(returned().some((hit) => hit.path === 'src/flask/helpers.py' && hit.start <= 28 && hit.end >= 28), JSON.stringify(returned()));
    console.log('Same-session symbol lookup:', returned().find((hit) => hit.path === 'src/flask/helpers.py'));

    await session.submit('Using @symbol:src/flask/helpers.py#get_debug_flag and @file:docs/cli.rst explain the relevant behavior.', true);
    assert.equal(session.state.phase, 'completed', session.state.error);
    assert.equal(session.state.sessionId, sessionId);
    assert.equal(session.state.context?.[0]?.operation, 'Explicit references');
    assert.equal(session.state.context?.[0]?.hits.filter((hit) => hit.selected).length, 2);
    console.log('Same-session explicit references resolved. Working tree checked in cleanup.');
  } finally {
    test.signal.removeEventListener('abort', cancel);
    release();
    await session.dispose();
    assert.equal(git('status', '--porcelain'), '');
  }
});
