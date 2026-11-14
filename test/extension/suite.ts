import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { baseSelection } from '../../src/quickEdit';
import { applyHunks, createHunks } from '../../src/quickPatch';

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
  console.log('VANTA activated and all three extension commands executed in the Windows Extension Host.');
}
