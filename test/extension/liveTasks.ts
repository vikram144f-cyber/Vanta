import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { editorAgent } from '../../src/editorAgent';
import { workspaceRepository, workspaceScope } from '../../src/editorRepository';
import { startOverviewBridge } from '../../src/mcp';
import { QuickEdit, quickEditScheme } from '../../src/quickEdit';
import { applyHunks } from '../../src/quickPatch';
import type { QuickPatch } from '../../src/quickPatch';
import { StudioSession } from '../../src/session';
import { TrueForgeClient } from '../../src/trueforge';

const taskA = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const taskB = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

export async function run() {
  const task = process.env.VANTA_NATIVE_TASK;
  const model = process.env.VANTA_NATIVE_MODEL;
  const python = process.env.VANTA_TEST_PYTHON;
  const vantaRoot = process.env.VANTA_SOURCE_ROOT;
  const resultPath = process.env.VANTA_NATIVE_RESULT;
  assert.ok((task === 'A' || task === 'B' || task === 'C' || task === 'STOP') && model && python && vantaRoot && resultPath);
  const primary = task === 'C' ? process.env.VANTA_NATIVE_PRIMARY : model;
  assert.ok(primary);
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspacePath);
  // Flask's CLI tests compare paths as strings. VS Code lowercases the Windows drive letter.
  const root = await realpath(workspacePath);
  assert.equal(vscode.workspace.isTrusted, true, 'Live tests require a trusted workspace');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
  assert.equal(git('status', '--porcelain'), '');
  await vscode.workspace.getConfiguration('files').update('autoSave', 'off', vscode.ConfigurationTarget.Workspace);
  const events: string[] = [];
  let cancelAcknowledged = false;
  class TraceForge extends TrueForgeClient {
    override async *start(...args: Parameters<TrueForgeClient['start']>) {
      for await (const event of super.start(...args)) { events.push(event.type); yield event; }
    }
    override async *resume(...args: Parameters<TrueForgeClient['resume']>) {
      for await (const event of super.resume(...args)) { events.push(event.type); yield event; }
    }
    override async cancel(...args: Parameters<TrueForgeClient['cancel']>) {
      await super.cancel(...args);
      cancelAcknowledged = true;
    }
  }
  let patch: QuickPatch | undefined;
  const session: StudioSession = new StudioSession({
    settings: () => ({ serverUrl: 'http://localhost:8790', model: primary, secondaryModel: task === 'C' ? model : undefined, agentName: '', workspaceOverview: task !== 'STOP',
      verificationPython: python, verificationRuff: process.env.VANTA_TEST_RUFF,
      verificationFixtureFiles: ['.env', '.flaskenv'].map((name) => join(root, 'tests/test_apps', name)),
    }),
    forge: (url) => new TraceForge(url),
    repository: workspaceRepository,
    scopeKey: () => root,
    bridge: (signal, name, context, inline, agent) => {
      const scope = workspaceScope();
      assert.ok(scope);
      return startOverviewBridge(scope, signal, name, context, inline, agent);
    },
    agentWorkspace: () => editorAgent(quick.previewChanges.bind(quick)),
  });
  const quick: QuickEdit = new QuickEdit(session, () => 8000);
  const virtual = vscode.workspace.registerTextDocumentContentProvider(quickEditScheme, quick);
  const reviews = new Set<string>();
  const verifications = new Set<string>();
  let driverError: unknown;
  let stopLatency: number | undefined;
  let stop: Promise<void> | undefined;
  const sessions = new Set<string>();
  const release = session.listen(() => {
    const { review, approval, sessionId, activeModel } = session.state;
    if (sessionId) sessions.add(sessionId);
    if (task === 'STOP' && stopLatency === undefined && session.state.phase === 'streaming'
      && events.includes('model.message.delta') && session.state.messages.some(({ role, text }) => role === 'assistant' && text.trim())) {
      const started = performance.now();
      stopLatency = 0;
      stop = session.cancel();
      stopLatency = performance.now() - started;
    }
    if (review && !reviews.has(review.id)) {
      reviews.add(review.id);
      void (async () => {
        if (task !== 'B') {
          assert.ok(patch);
          const output = execFileSync(python, ['-I', join(vantaRoot, 'test/live/check_task_a.py')], {
            input: applyHunks(patch.base, patch.hunks), encoding: 'utf8', timeout: 5000,
          });
          console.log(output.trim());
        }
        if (task === 'C') {
          assert.equal(activeModel, model);
          assert.equal(git('status', '--porcelain'), '');
          await session.finishReview(review.id, false);
          return;
        }
        for (const hunk of review.hunks) await session.reviewHunk(review.id, hunk.id, 'accepted');
        await session.finishReview(review.id, true);
      })().catch((error: unknown) => { driverError = error; void session.cancel(); });
    }
    if (approval?.canAllow && !verifications.has(approval.id)) {
      verifications.add(approval.id);
      void session.decide(approval.id, true).catch((error: unknown) => { driverError = error; void session.cancel(); });
    }
  });
  const timeout = setTimeout(() => { driverError = new Error('Native live task exceeded six minutes'); void session.cancel(); }, 360_000);
  const original = task !== 'B' ? await readFile(join(root, 'src/flask/helpers.py'), 'utf8') : undefined;
  let dirtyNote: vscode.TextDocument | undefined;
  const marker = 'VANTA unsaved rehearsal note';
  try {
    await session.refresh();
    assert.equal(session.state.connection.selectedModel, primary, session.state.connection.detail);
    if (task === 'STOP') {
      await session.submit('Explain in twenty numbered paragraphs how to design maintainable tests for a command-line application.');
      await stop;
      assert.ifError(driverError);
      assert.equal(session.state.phase, 'cancelled', session.state.error);
      assert.ok(stopLatency !== undefined && stopLatency < 200, `Cancellation indication took ${stopLatency}ms`);
      assert.equal(cancelAcknowledged, true);
      assert.equal(git('status', '--porcelain'), '');
      const result = { task, model, session: session.state.sessionId, events, phase: session.state.phase,
        stopLatencyMs: Math.round(stopLatency * 100) / 100, cancelAcknowledged, status: '' };
      await writeFile(resultPath, JSON.stringify(result, null, 2));
      console.log('NATIVE_LIVE_PASS', JSON.stringify(result));
      return;
    }
    if (task === 'C') {
      assert.ok(session.state.connection.models.includes(model));
      dirtyNote = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'README.md')));
      const notes = await vscode.window.showTextDocument(dirtyNote);
      assert.equal(await notes.edit((edit) => edit.insert(new vscode.Position(0, 0), marker + '\n')), true);
    }
    if (task !== 'B') {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'src/flask/helpers.py')));
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(27, 0, 33, 0);
      const target = await quick.capture(editor);
      const preview = target.preview;
      target.preview = async (value, hunk) => { patch = value; await preview(value, hunk); };
      await session.submit(taskA, true, target);
    } else {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await session.submit(taskB, true, undefined, true);
    }
    assert.ifError(driverError);
    assert.equal(session.state.phase, 'completed', session.state.error);
    if (task === 'C') {
      assert.equal(sessions.size, 2);
      assert.equal(session.state.activity.filter((item) => item.label === 'Using configured secondary model').length, 1);
      assert.ok(session.state.activity.some((item) => item.label === 'Quick Edit discarded'));
      assert.equal(await readFile(join(root, 'src/flask/helpers.py'), 'utf8'), original);
      assert.ok(dirtyNote?.isDirty && dirtyNote.getText().startsWith(marker));
      assert.equal(git('status', '--porcelain'), '');
      const result = { task, primary, model, root, sessions: [...sessions], events, phase: session.state.phase,
        checks: 'unreachable primary, one automatic switch, real backup proposal passes 24 cases and documentation, discard, clean disk and unsaved note' };
      await writeFile(resultPath, JSON.stringify(result, null, 2));
      console.log('NATIVE_LIVE_PASS', JSON.stringify(result));
      return;
    }
    if (task === 'B') assert.equal(session.state.verification?.exitCode, 0, session.state.verification?.output);
    const paths = task === 'A' ? ['src/flask/helpers.py'] : session.state.changes?.paths;
    assert.ok(paths);
    assert.deepEqual([...paths].sort(), task === 'A' ? ['src/flask/helpers.py'] : ['docs/cli.rst', 'src/flask/cli.py', 'tests/test_cli.py']);
    const expected = new Map<string, string>();
    for (const path of paths) {
      const document: vscode.TextDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, path)));
      assert.equal(document.isDirty, true, path);
      const before = await readFile(join(root, path), 'utf8');
      assert.notEqual(document.getText(), before, path);
      expected.set(path, document.getText());
      assert.equal(await document.save(), true, path);
      assert.equal(await readFile(join(root, path), 'utf8'), expected.get(path), path);
    }
    if (task === 'A') {
      const saved = expected.get('src/flask/helpers.py')!;
      console.log(execFileSync(python, ['-I', join(vantaRoot, 'test/live/check_task_a.py')], { input: saved, encoding: 'utf8', timeout: 5000 }).trim());
      await quick.undo();
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'src/flask/helpers.py')));
      assert.equal(document.getText(), original);
      assert.equal(await document.save(), true);
      assert.equal(await readFile(document.uri.fsPath, 'utf8'), original);
    } else {
      const options = { cwd: root, encoding: 'utf8' as const, timeout: 60_000,
        env: { ...process.env, PYTHONPATH: join(root, 'src'), PYTHONDONTWRITEBYTECODE: '1' } };
      console.log(execFileSync(python, [join(vantaRoot, 'test/live/check_task_b.py')], options));
      const savedTests = spawnSync(python, ['-m', 'pytest', 'tests/test_cli.py', '-q'], options);
      assert.ifError(savedTests.error);
      assert.equal(savedTests.status, 0, savedTests.stdout + savedTests.stderr);
      console.log(savedTests.stdout);
    }
    git('diff', '--check');
    const result = { task, model, root, session: session.state.sessionId, phase: session.state.phase,
      events, verification: session.state.verification, paths, status: git('status', '--porcelain'),
      checks: task === 'A' ? '24 behavior cases, docstring, native apply/save/undo/save' : 'native apply/save, independent CLI checker, saved pytest',
    };
    await writeFile(resultPath, JSON.stringify(result, null, 2));
    console.log('NATIVE_LIVE_PASS', JSON.stringify(result));
  } catch (error) {
    await writeFile(resultPath, JSON.stringify({ task, root, model, session: session.state.sessionId,
      phase: session.state.phase, error: String(error), activity: session.state.activity, verification: session.state.verification, events }, null, 2));
    throw error;
  } finally {
    clearTimeout(timeout);
    release();
    await session.dispose();
    virtual.dispose();
    quick.dispose();
  }
}
