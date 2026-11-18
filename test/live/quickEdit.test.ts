import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { startOverviewBridge } from '../../src/mcp';
import { quickEditEvidence } from '../../src/quickContext';
import { applyHunks, fingerprint } from '../../src/quickPatch';
import type { BaseSelection, QuickPatch } from '../../src/quickPatch';
import { Repository } from '../../src/repository';
import { StudioSession } from '../../src/session';
import { TrueForgeClient } from '../../src/trueforge';

const root = process.env.VANTA_QUICK_FLASK;
const model = process.env.VANTA_QUICK_MODEL;
const python = process.env.VANTA_TEST_PYTHON;
const taskA = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

test('live Quick Edit checks Task A on the pinned Flask selection with an in-memory editor', { skip: !root || !model || !python, timeout: 210_000 }, async (test) => {
  assert.ok(root && model && python);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
  assert.equal(git('status', '--porcelain'), '');
  const path = 'src/flask/helpers.py';
  const file = join(root, path);
  const text = await readFile(file, 'utf8');
  const lines = [0, ...Array.from(text.matchAll(/\r?\n/g), (match) => match.index + match[0].length)];
  const base: BaseSelection = { path, text, version: 1, start: lines[27]!, end: lines[33]!, eol: text.includes('\r\n') ? '\r\n' : '\n' };
  assert.match(text.slice(base.start, base.end), /^def get_debug_flag\(\)/);
  const evidence = quickEditEvidence(base, 'python', { start: { line: 28, column: 1 }, end: { line: 34, column: 1 } },
    text.split(/\r?\n/), [], 4000);
  const scope = { path: root, isAvailable: () => true };
  const studio = new StudioSession({
    settings: () => ({ serverUrl: 'http://localhost:8790', model, agentName: '', workspaceOverview: true }),
    forge: (url) => new TrueForgeClient(url),
    repository: () => Repository.bind(scope),
    scopeKey: () => root,
    bridge: (signal, name, context, quick) => startOverviewBridge(scope, signal, name, context, quick),
  });
  let staged: QuickPatch | undefined;
  let applied: string | undefined;
  let reviewing = false;
  let reviewError: unknown;
  const verify = async () => assert.equal(await readFile(file, 'utf8'), text);
  const release = studio.listen(() => {
    const review = studio.state.review;
    if (!review || reviewing) return;
    reviewing = true;
    void (async () => {
      assert.ok(staged);
      const candidate = applyHunks(base, staged.hunks);
      const result = execFileSync(python, ['-I', join(import.meta.dirname, 'check_task_a.py')], {
        input: candidate, encoding: 'utf8', cwd: root, timeout: 5000,
      });
      console.log(result.trim());
      for (const hunk of review.hunks) await studio.reviewHunk(review.id, hunk.id, 'accepted');
      await studio.finishReview(review.id, true);
    })().catch(async (error: unknown) => {
      reviewError = error;
      await studio.cancel();
    });
  });
  const cancel = () => { void studio.cancel(); };
  test.signal.addEventListener('abort', cancel, { once: true });
  try {
    await studio.refresh();
    assert.equal(studio.state.connection.selectedModel, model);
    await studio.submit(taskA, true, {
      base, evidence, verify,
      preview: async (patch) => { staged = patch; },
      apply: async (hunks, digest, _signal, begin) => {
        const candidate = applyHunks(base, hunks);
        assert.equal(fingerprint(candidate), digest);
        begin();
        applied = candidate;
      },
    });
    console.log('TrueForge session:', studio.state.sessionId, 'phase:', studio.state.phase, 'activity:', JSON.stringify(studio.state.activity));
    assert.ifError(reviewError);
    assert.equal(studio.state.phase, 'completed', studio.state.error);
    assert.ok(staged && applied);
    assert.equal(applied, applyHunks(base, staged.hunks));
  } finally {
    release();
    test.signal.removeEventListener('abort', cancel);
    await studio.dispose();
    await verify();
    assert.equal(git('status', '--porcelain'), '');
  }
});
