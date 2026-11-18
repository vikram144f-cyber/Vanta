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
        return { path: base.path, document, version, before: base.text, after, diskBefore: base.text, current: () => document.getText() };
      }));
      const checkDisk = async (selected: readonly typeof entries[number][], dispatched: boolean, deadline: AbortSignal) => {
        await Promise.all(selected.map(async ({ path, diskBefore, after }) => {
          const disk = await repository.diskText(path, deadline);
          if (disk !== diskBefore && (!dispatched || disk !== after)) {
            throw new VantaError(`Agent Mode target changed on disk during the edit: ${path}. Review the disk and buffer contents before saving.`);
          }
        }));
      };
      const write = async (selected: readonly typeof entries[number][], rollback: boolean, deadline: AbortSignal, beforeDispatch?: () => void) => {
        if (!rollback) {
          await checkDisk(selected, false, deadline);
          deadline.throwIfAborted();
        }
        const edit = new vscode.WorkspaceEdit();
        if (!scope.isAvailable()) throw new VantaError('The trusted workspace changed.');
        for (const { document, version, before, after } of selected) {
          if (document.isClosed || (!rollback && document.version !== version)
            || document.getText() !== (rollback ? after : before)) throw new VantaError('A target buffer changed.');
          edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), rollback ? before : after);
        }
        if (!rollback) beforeDispatch?.();
        const applied = await vscode.workspace.applyEdit(edit);
        // Detect disk writes in the dispatch window and let applyBatch recover matching buffers.
        if (applied && !rollback) await checkDisk(selected, true, AbortSignal.timeout(5000));
        return applied;
      };
      const writeBatch = (targets: readonly typeof entries[number][], deadline: AbortSignal, beginCommit?: () => void) => {
        let dispatched = false;
        return applyBatch(targets, (selected, rollback) => {
          if (rollback && !dispatched) return Promise.resolve(false);
          return write(selected, rollback, deadline, () => {
            beginCommit?.();
            dispatched = true;
          });
        });
      };
      if (!scope.isAvailable() || entries.some(({ document, before, version }) => document.isClosed || document.isDirty
        || document.version !== version || document.getText() !== before)) {
        throw new VantaError('An Agent Mode target is dirty, closed or stale. Start a new request.');
      }
      await writeBatch(entries, signal, begin);
      const versions = entries.map(({ document }) => document.version);
      captured.clear();
      return async () => {
        const deadline = AbortSignal.timeout(5000);
        const reverse = await Promise.all(entries.map(async ({ path, before, after, document: original }, index) => {
          const disk = await repository.diskText(path, deadline);
          const reopened = original.isClosed;
          if ((disk !== before && disk !== after) || (reopened && disk !== after)) {
            throw new VantaError(`Cannot undo because ${path} changed on disk.`);
          }
          const document = reopened ? await vscode.workspace.openTextDocument(original.uri) : original;
          if (document.isClosed || original.version !== versions[index] || (reopened && document.isDirty) || document.getText() !== after) {
            throw new VantaError('Cannot undo because an affected editor buffer changed. Review the files in VS Code.');
          }
          return { path, document, version: document.version, before: after, after: before, diskBefore: disk, current: () => document.getText() };
        }));
        await writeBatch(reverse, deadline);
      };
    },
  };
}
