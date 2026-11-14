import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { baseSelection } from '../../src/quickEdit';
import { applyHunks, createHunks } from '../../src/quickPatch';
import { editorAgent } from '../../src/editorAgent';

export async function run() {
  const extension = vscode.extensions.getExtension('vikram144f-cyber.vanta');
  assert.ok(extension);
  await extension.activate();
  assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands();
  for (const name of ['vanta.openStudio', 'vanta.quickEdit', 'vanta.cancelRun', 'vanta.studio.focus']) {
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
  const repo = await editorAgent(async () => undefined);
  assert.ok(repo, 'Expected a trusted local workspace');
  const paths = ['agent-a.txt', 'agent-b.txt', 'agent-c.txt'];
  const source = 'original\r\n';
  const deadline = AbortSignal.timeout(15_000);
  for (const path of paths) await writeFile(join(folder.uri.fsPath, path), source);
  const approved = await Promise.all(paths.map(async (path) => ({ base: await repo.capture(path, deadline), after: 'reviewed\r\n', ids: [1] })));
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
  assert.equal(commits, 1);
  assert.match(target.getText(), /^user edit/);
  console.log('Agent Mode text-only WorkspaceEdit applied and undid three CRLF buffers, preserved disk, and rejected dirty and deleted targets.');
  console.log('VANTA activated and all three extension commands executed in the Windows Extension Host.');
}
