import assert from 'node:assert/strict';
import * as vscode from 'vscode';

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
  console.log('VANTA activated and all three extension commands executed in the Windows Extension Host.');
}
