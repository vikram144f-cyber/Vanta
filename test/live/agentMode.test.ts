import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ApprovedFile } from '../../src/agentPatch';
import { startOverviewBridge } from '../../src/mcp';
import { Repository } from '../../src/repository';
import { StudioSession } from '../../src/session';
import { TrueForgeClient } from '../../src/trueforge';

const model = process.env.VANTA_AGENT_MODEL;
const python = process.env.VANTA_TEST_PYTHON;
const flask = process.env.VANTA_AGENT_FLASK;

const taskB = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
const fixtureTask = 'Extend invoice totals with an optional flat delivery fee defaulting to zero. Add a regression test for a nonzero delivery fee and update the invoice documentation.';

test(`live Agent Mode discovers and verifies three related files in ${flask ? 'pinned Flask Task B' : 'a non-Flask repository'}`, { skip: !model || !python, timeout: 260_000 }, async (test) => {
  assert.ok(model && python);
  const root = flask ?? await mkdtemp(join(tmpdir(), 'vanta-live-totals-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (flask) {
    assert.equal(git('rev-parse', 'HEAD'), '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
  } else {
    await mkdir(join(root, 'docs'));
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'totals.py'), 'def invoice_total(items):\n    """Sum invoice amounts."""\n    return sum(items)\n');
    await writeFile(join(root, 'tests', 'test_totals.py'), 'from totals import invoice_total\n\n\ndef test_invoice_total():\n    assert invoice_total([2, 3]) == 5\n');
    await writeFile(join(root, 'docs', 'invoices.md'), '# Invoice totals\n\nThe invoice total is the sum of the invoice amounts.\n');
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=VANTA Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture');
  }
  assert.equal(git('status', '--porcelain'), '');
  const scope = { path: root, isAvailable: () => true };
  const repository = await Repository.bind(scope);
  let applied: readonly ApprovedFile[] = [];
  const events: string[] = [];
  class TraceForge extends TrueForgeClient {
    override async *start(...args: Parameters<TrueForgeClient['start']>) {
      for await (const event of super.start(...args)) { events.push(event.type); yield event; }
    }
    override async *resume(...args: Parameters<TrueForgeClient['resume']>) {
      for await (const event of super.resume(...args)) { events.push(event.type); yield event; }
    }
  }
  const session = new StudioSession({
    settings: () => ({ serverUrl: 'http://localhost:8790', model, agentName: '', workspaceOverview: true, verificationPython: python }),
    forge: (url) => new TraceForge(url), scopeKey: () => root,
    bridge: (signal, name, context, quick, agent) => startOverviewBridge(scope, signal, name, context, quick, agent),
    agentWorkspace: async () => ({
      repository,
      capture: async (path, signal) => {
        const text = await repository.diskText(path, signal);
        return { path, text, eol: '\n', version: 1, start: 0, end: text.length };
      },
      preview: async () => undefined,
      apply: async (files, _signal, begin) => { begin(); applied = files; return async () => { applied = []; }; },
    }),
  });
  const cancel = () => { void session.cancel(); };
  test.signal.addEventListener('abort', cancel, { once: true });
  let reviewStarted = false;
  let approvalStarted = false;
  let driverFailure: unknown;
  const drive = session.listen(() => {
    const { review, approval } = session.state;
    if (review?.files && !reviewStarted) {
      reviewStarted = true;
      void (async () => {
        assert.equal(git('status', '--porcelain'), '');
        for (const hunk of review.hunks) await session.reviewHunk(review.id, hunk.id, 'accepted');
        await session.finishReview(review.id, true);
      })().catch((error: unknown) => { driverFailure = error; cancel(); });
    }
    if (approval?.canAllow && !approvalStarted) {
      approvalStarted = true;
      void session.decide(approval.id, true).catch((error: unknown) => { driverFailure = error; cancel(); });
    }
  });
  try {
    await session.refresh();
    assert.equal(session.state.connection.selectedModel, model);
    await session.submit(flask ? taskB : fixtureTask, true, undefined, true);
    assert.ifError(driverFailure);
    const state = session.state;
    console.log(JSON.stringify({ session: state.sessionId, activity: state.activity, verification: state.verification, events,
      reasons: state.context?.flatMap((report) => report.hits.filter((hit) => hit.selected).map(({ path, reason }) => ({ path, reason }))),
      files: applied.map(({ base }) => base.path) }));
    assert.equal(state.phase, 'completed', state.error);
    assert.equal(state.verification?.exitCode, 0);
    assert.deepEqual(applied.map(({ base }) => base.path).sort(), flask
      ? ['docs/cli.rst', 'src/flask/cli.py', 'tests/test_cli.py']
      : ['docs/invoices.md', 'tests/test_totals.py', 'totals.py']);
    assert.equal(git('status', '--porcelain'), '');
    assert.ok(state.activity.some((item) => item.detail === 'call_tool'));
    assert.equal(events.filter((event) => event === 'tool.approval_required').length, 2);
    assert.equal(events.filter((event) => event === 'user.tool_approval').length, 2);
    assert.ok(events.includes('turn.done'));
    await session.undoAgent();
    assert.equal(applied.length, 0);
  } finally {
    drive();
    test.signal.removeEventListener('abort', cancel);
    await session.dispose();
    if (!flask) await rm(root, { recursive: true, force: true });
  }
});
