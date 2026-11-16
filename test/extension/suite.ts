import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { baseSelection, QuickEdit } from '../../src/quickEdit';
import { applyHunks, createHunks } from '../../src/quickPatch';
import { fingerprint } from '../../src/quickPatch';
import type { StudioSession } from '../../src/session';
import { editorAgent } from '../../src/editorAgent';

export async function run() {
  const extension = vscode.extensions.getExtension('vikram144f-cyber.vanta');
  assert.ok(extension);
  await extension.activate();
  assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands();
  for (const name of ['vanta.openStudio', 'vanta.quickEdit', 'vanta.undoQuickEdit', 'vanta.cancelRun', 'vanta.studio.focus']) {
    assert.ok(commands.includes(name), name);
  }
  await vscode.commands.executeCommand('vanta.openStudio');
  await vscode.commands.executeCommand('vanta.quickEdit');
  await vscode.commands.executeCommand('vanta.cancelRun');
  const buffer = await vscode.workspace.openTextDocument({ content: 'first\nunchanged\nthird\n', language: 'plaintext' });
  const editor = await vscode.window.showTextDocument(buffer);
  assert.equal(await editor.edit((builder) => builder.insert(new vscode.Position(3, 0), 'user change\n')), true);
  const selection = new vscode.Selection(0, 0, 3, 0);
  assert.throws(() => baseSelection(buffer, [new vscode.Selection(0, 0, 0, 0)], 'file.txt'), /nonempty/);
  assert.throws(() => baseSelection(buffer, [selection, selection], 'file.txt'), /one nonempty/);
  const captured = baseSelection(buffer, [selection], 'file.txt');
  const hunks = createHunks(captured, 'replacement\nunchanged\nchanged third\n').slice(1);
  assert.equal(captured.text.endsWith('user change\n'), true);
  assert.equal(await editor.edit((builder) => {
    for (const hunk of hunks) builder.replace(new vscode.Range(buffer.positionAt(hunk.start), buffer.positionAt(hunk.end)), hunk.replacement);
  }, { undoStopBefore: true, undoStopAfter: true }), true);
  assert.equal(buffer.getText(), applyHunks(captured, hunks));
  await vscode.window.showTextDocument(buffer, { preserveFocus: false });
  const undo = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { listener.dispose(); reject(new Error('Undo did not update the editor buffer.')); }, 3000);
    const listener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== buffer || event.document.getText() !== captured.text) return;
      clearTimeout(deadline);
      listener.dispose();
      resolve();
    });
  });
  await Promise.all([vscode.commands.executeCommand('undo'), undo]);
  assert.equal(buffer.getText(), captured.text);
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  const quickFile = join(folder.uri.fsPath, 'quick-saved.txt');
  const quickOriginal = 'original\r\nend\r\n';
  const quickAfter = 'reviewed\r\nend\r\n';
  await writeFile(quickFile, quickOriginal);
  const quick = new QuickEdit({ state: { phase: 'idle' } } as StudioSession, () => 8000);
  try {
    const quickDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(quickFile));
    const quickEditor = await vscode.window.showTextDocument(quickDoc);
    quickEditor.selection = new vscode.Selection(0, 0, 1, 0);
    const target = await quick.capture(quickEditor);
    const changes = createHunks(target.base, 'reviewed\r\n');
    await target.apply(changes, fingerprint(quickAfter), AbortSignal.timeout(5000), () => undefined);
    assert.equal(await readFile(quickFile, 'utf8'), quickOriginal);
    assert.equal(await quickDoc.save(), true);
    assert.equal(await readFile(quickFile, 'utf8'), quickAfter);
    await vscode.window.showTextDocument(buffer);
    await quick.undo();
    assert.equal(quickDoc.getText(), quickOriginal);
    assert.equal(await readFile(quickFile, 'utf8'), quickAfter);
    assert.equal(await quickDoc.save(), true);
    assert.equal(await readFile(quickFile, 'utf8'), quickOriginal);
    const nextEditor = await vscode.window.showTextDocument(quickDoc);
    nextEditor.selection = new vscode.Selection(0, 0, 1, 0);
    const next = await quick.capture(nextEditor);
    await next.apply(createHunks(next.base, 'reviewed\r\n'), fingerprint(quickAfter), AbortSignal.timeout(5000), () => undefined);
    assert.equal(await nextEditor.edit((edit) => edit.insert(new vscode.Position(1, 0), 'user edit\r\n')), true);
    await quick.undo();
    assert.equal(quickDoc.getText(), 'reviewed\r\nuser edit\r\nend\r\n');
    console.log('Quick Edit targeted undo restored a saved file from a different active editor and preserved later edits.');
  } finally { quick.dispose(); }
  const repo = await editorAgent(async () => undefined);
  assert.ok(repo, 'Expected a trusted local workspace');
  const paths = ['agent-a.txt', 'agent-b.txt', 'agent-c.txt'];
  const source = 'original\r\n';
  for (const path of paths) await writeFile(join(folder.uri.fsPath, path), source);
  const captureDeadline = AbortSignal.timeout(15_000);
  const approved = await Promise.all(paths.map(async (path) => ({ base: await repo.capture(path, captureDeadline), after: 'reviewed\r\n', ids: [1] })));
  const staged = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, paths[0]!));
  // Exceed VS Code's document-reference cache to simulate expiry without waiting minutes.
  for (let i = 0; i < 64 && !staged.isClosed; i++) {
    const uri = vscode.Uri.joinPath(folder.uri, `background-${i}.txt`);
    await writeFile(uri.fsPath, source);
    await vscode.workspace.openTextDocument(uri);
  }
  assert.ok(staged.isClosed, 'Expected VS Code to release the staged document during review.');
  const deadline = AbortSignal.timeout(15_000);
  let commits = 0;
  const apply = () => repo.apply(approved, deadline, () => { commits++; });
  const revert = await apply();
  assert.equal(commits, 1);
  const target = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, paths[0]!));
  for (const path of paths) {
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, path))).getText(), 'reviewed\r\n');
    assert.equal(await readFile(join(folder.uri.fsPath, path), 'utf8'), source);
  }
  await revert();
  assert.equal(target.getText(), source);
  const dirty = new vscode.WorkspaceEdit();
  dirty.insert(target.uri, new vscode.Position(0, 0), 'user edit\r\n');
  assert.equal(await vscode.workspace.applyEdit(dirty), true);
  await assert.rejects(repo.capture(paths[0]!, deadline), /clean/);
  const removed = 'agent-removed.txt';
  await writeFile(join(folder.uri.fsPath, removed), source);
  const clean = await repo.capture(removed, deadline);
  await unlink(join(folder.uri.fsPath, removed));
  await assert.rejects(repo.apply([{ base: clean, after: 'change\r\n', ids: [1] }], deadline, () => { commits++; }));
  const changed = 'agent-changed.txt';
  await writeFile(join(folder.uri.fsPath, changed), source);
  const changedBase = await repo.capture(changed, deadline);
  await writeFile(join(folder.uri.fsPath, changed), 'changed on disk\r\n');
  await assert.rejects(repo.apply([{ base: changedBase, after: 'reviewed\r\n', ids: [1] }], deadline, () => { commits++; }), /changed on disk/);
  assert.equal(await readFile(join(folder.uri.fsPath, changed), 'utf8'), 'changed on disk\r\n');
  assert.equal(commits, 1);
  assert.match(target.getText(), /^user edit/);
  console.log('Agent Mode applied and undid three CRLF buffers after VS Code released a staged document, and rejected dirty, changed and deleted targets.');
  console.log('VANTA activated and its commands registered in the Windows Extension Host.');
}
