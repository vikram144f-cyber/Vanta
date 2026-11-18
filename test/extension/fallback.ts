import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { workspaceRepository, workspaceScope } from '../../src/editorRepository';
import { startOverviewBridge } from '../../src/mcp';
import { QuickEdit, quickEditScheme } from '../../src/quickEdit';
import { StudioSession } from '../../src/session';
import { TrueForgeClient } from '../../src/trueforge';

export async function verifyFallback(provider: string) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root && vscode.workspace.isTrusted);
  const original = 'export const enabled = false;\n';
  const path = join(root, 'fallback-fixture.ts');
  await writeFile(path, original);
  const notesPath = join(root, 'fallback-notes.txt');
  await writeFile(notesPath, 'Original notes\n');
  const notes = await vscode.workspace.openTextDocument(notesPath);
  const notesEditor = await vscode.window.showTextDocument(notes);
  const marker = 'Unsaved user note';
  assert.equal(await notesEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), marker + '\n')), true);
  const document = await vscode.workspace.openTextDocument(path);
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, 1, 0);
  const model = `${provider}/unavailable`;
  const secondaryModel = `${provider}/backup`;
  const events: string[] = [];
  class TraceForge extends TrueForgeClient {
    override async *start(...args: Parameters<TrueForgeClient['start']>) {
      for await (const event of super.start(...args)) {
        events.push(event.type);
        yield event;
      }
    }
  }
  const session = new StudioSession({
    settings: () => ({ serverUrl: 'http://localhost:8790', model, secondaryModel, automaticFallback: true, agentName: '', workspaceOverview: true }),
    forge: (url) => new TraceForge(url), repository: workspaceRepository,
    scopeKey: () => root,
    bridge: (signal, name, context, quick, agent) => {
      const scope = workspaceScope();
      assert.ok(scope);
      return startOverviewBridge(scope, signal, name, context, quick, agent);
    },
  });
  const quick = new QuickEdit(session, () => 8000);
  const virtual = vscode.workspace.registerTextDocumentContentProvider(quickEditScheme, quick);
  const sessions = new Set<string>();
  let reviewed = false;
  let reviewError: unknown;
  const release = session.listen(() => {
    const { activeModel, review, sessionId } = session.state;
    if (sessionId) sessions.add(sessionId);
    if (!review || reviewed) return;
    reviewed = true;
    void (async () => {
      assert.equal(activeModel, secondaryModel);
      assert.equal(review.hunks.length, 1);
      assert.equal(document.getText(), original);
      assert.equal(notes.isDirty, true);
      assert.match(notes.getText(), /^Unsaved user note/);
      await session.finishReview(review.id, false);
    })().catch((error: unknown) => { reviewError = error; void session.cancel(); });
  });
  const timeout = setTimeout(() => { void session.cancel(); }, 45_000);
  try {
    await session.refresh();
    assert.equal(session.state.connection.selectedModel, model, session.state.connection.detail);
    assert.ok(session.state.connection.models.includes(secondaryModel));
    const target = await quick.capture(editor);
    await session.submit('Change the selected value to true.', true, target);
    assert.ifError(reviewError);
    assert.equal(session.state.phase, 'completed', JSON.stringify({ error: session.state.error, activity: session.state.activity, events }));
    assert.equal(reviewed, true);
    assert.equal(sessions.size, 2);
    const { activity, messages } = session.state;
    assert.equal(activity.filter((item) => item.label === 'Using configured secondary model').length, 1);
    assert.ok(activity.some((item) => item.label === 'Quick Edit discarded'));
    assert.ok(messages.some((item) => item.text.includes('backup reached and completed the review checkpoint')));
    assert.doesNotMatch(JSON.stringify(session.state), /synthetic-provider-private-detail/);
    assert.equal(document.getText(), original);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(await readFile(notesPath, 'utf8'), 'Original notes\n');
    assert.equal(notes.isDirty, true);
    assert.match(notes.getText(), /^Unsaved user note/);
    console.log('Native fallback passed: one automatic switch, backup diff and discard, unchanged disk and unsaved note.');
    console.log('Local fixture TrueForge sessions:', [...sessions].join(' → '));
  } finally {
    clearTimeout(timeout);
    release();
    await session.dispose();
    virtual.dispose();
    quick.dispose();
  }
}
