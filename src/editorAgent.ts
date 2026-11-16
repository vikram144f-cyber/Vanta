import * as vscode from 'vscode';
import { applyBatch } from './agentWorkspace';
import type { AgentWorkspace } from './agentWorkspace';
import { workspaceScope } from './editorRepository';
import type { BaseSelection } from './quickPatch';
import { normalizeWorkspacePath, Repository } from './repository';
import type { QuickEdit } from './quickEdit';
import { VantaError } from './trueforge';

export async function editorAgent(preview: QuickEdit['previewChanges']): Promise<AgentWorkspace | undefined> {
  const scope = workspaceScope();
  if (!scope) return;
  const repository = await Repository.bind(scope);
  const captured = new Map<BaseSelection, vscode.TextDocument>();
  return {
    repository,
    capture: async (path, signal) => {
      const location = await repository.location(path, signal);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location));
      const disk = await repository.diskText(path, signal);
      const text = document.getText();
      const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      if (document.isDirty || document.isClosed || disk !== text || /\r(?!\n)/.test(text)) {
        throw new VantaError('Agent Mode needs a clean UTF-8 editor buffer matching disk. Save or reopen the target and start again.');
      }
      const base: BaseSelection = { path, text, version: document.version, start: 0, end: text.length, eol };
      captured.set(base, document);
      return base;
    },
    preview: (id, file, hunk) => preview(`${id}-${file.hunks[0]!.id}`, file, hunk, 'Agent Mode'),
    apply: async (files, signal, begin) => {
      const entries = await Promise.all(files.map(async ({ base, after }) => {
        const staged = captured.get(base);
        const path = await repository.location(base.path, signal);
        if (!staged || normalizeWorkspacePath(staged.uri.fsPath) !== path) {
          throw new VantaError(`Agent Mode target is no longer available: ${base.path}. Start a new request.`);
        }
        // VS Code can release an unopened source buffer while its virtual diff is under review.
        const document = staged.isClosed ? await vscode.workspace.openTextDocument(staged.uri) : staged;
        const version = document === staged ? base.version : document.version;
        if (await repository.diskText(base.path, signal) !== base.text) {
          throw new VantaError(`Agent Mode target changed on disk: ${base.path}. Start a new request.`);
        }
        if (staged.version !== base.version) {
          throw new VantaError(`Agent Mode target was edited since staging: ${base.path}. Start a new request.`);
        }
        return { path: base.path, document, version, before: base.text, after, current: () => document.getText() };
      }));
      const write = (selected: typeof entries[number][], undo: boolean) => {
        const edit = new vscode.WorkspaceEdit();
        if (!scope.isAvailable()) throw new VantaError('The trusted workspace changed.');
        for (const { document, before, after } of selected) {
          if (document.isClosed || document.getText() !== (undo ? after : before)) throw new VantaError('A target buffer changed.');
          edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), undo ? before : after);
        }
        return vscode.workspace.applyEdit(edit);
      };
      if (!scope.isAvailable() || entries.some(({ document, before, version }) => document.isClosed || document.isDirty
        || document.version !== version || document.getText() !== before)) {
        throw new VantaError('An Agent Mode target is dirty, closed or stale. Start a new request.');
      }
      begin();
      await applyBatch(entries, (selected, undo) => write([...selected], undo));
      const versions = entries.map(({ document }) => document.version);
      captured.clear();
      return async () => {
        const deadline = AbortSignal.timeout(5000);
        for (const { path, before, after } of entries) {
          const disk = await repository.diskText(path, deadline);
          if (disk !== before && disk !== after) throw new VantaError(`Cannot undo because ${path} changed on disk.`);
        }
        if (entries.some(({ document, after }, index) => document.isClosed || document.version !== versions[index] || document.getText() !== after)) {
          throw new VantaError('Cannot undo because an affected editor buffer changed. Review the files in VS Code.');
        }
        await applyBatch(entries.map((entry) => ({ ...entry, before: entry.after, after: entry.before })),
          (selected, undo) => write([...selected], undo));
      };
    },
  };
}
