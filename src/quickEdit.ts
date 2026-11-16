import * as vscode from 'vscode';
import { basename } from 'node:path';
import { estimateContext } from './context';
import { workspaceRepository, workspaceScope } from './editorRepository';
import { applyHunks, assertBase, fingerprint } from './quickPatch';
import type { BaseSelection, Hunk } from './quickPatch';
import { maxFileBytes, normalizeWorkspacePath, Repository } from './repository';
import { safeError, VantaError } from './trueforge';
import type { QuickEditTarget, StudioSession } from './session';
import { isBusy } from './protocol';

const scheme = 'vanta-quick-edit';

export function baseSelection(document: vscode.TextDocument, selections: readonly vscode.Selection[], path: string): BaseSelection {
  if (selections.length !== 1 || selections[0]?.isEmpty) throw new VantaError('Select one nonempty code region to use VANTA Quick Edit.');
  const selection = selections[0]!;
  const text = document.getText();
  if (Buffer.byteLength(text) > maxFileBytes || text.includes('\0') || /\r(?!\n)/.test(text)) {
    throw new VantaError('Quick Edit supports UTF-8 text files up to 96 KiB with LF or CRLF line endings.');
  }
  return { path, text, version: document.version, start: document.offsetAt(selection.start), end: document.offsetAt(selection.end),
    eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n' };
}

export class QuickEdit implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly #values = new Map<string, { before: string; after: string }>();
  #inputOpen = false;
  #undo?: () => Promise<void>;
  #undoing = false;

  constructor(private readonly session: StudioSession, private readonly contextBudget: () => number) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const text = this.#values.get(uri.authority);
    return (uri.query === 'proposed' ? text?.after : text?.before) ?? '';
  }

  async previewChanges(id: string, patch: { base: BaseSelection; hunks: Hunk[] }, hunkId: number, mode: string) {
    const filename = basename(patch.base.path);
    const uri = vscode.Uri.from({ scheme, authority: id, path: `/${filename}` });
    const proposed = uri.with({ query: 'proposed' });
    if (!this.#values.has(id)) {
      this.#values.set(id, { before: patch.base.text, after: applyHunks(patch.base, patch.hunks) });
      if (this.#values.size > 16) this.#values.delete(this.#values.keys().next().value!);
    }
    if (!vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === proposed.toString())) {
      await vscode.commands.executeCommand('vscode.diff', uri, proposed, `VANTA ${mode} · ${filename}`, { preview: true });
      await vscode.commands.executeCommand('vanta.studio.focus');
    }
    const hunk = patch.hunks.find((item) => item.id === hunkId);
    if (!hunk) return;
    const shift = patch.hunks.slice(0, patch.hunks.indexOf(hunk)).reduce((sum, item) => sum + item.replacement.length - (item.end - item.start), 0);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === proposed.toString()) {
        // Virtual documents use VS Code's configured EOL, so navigate by line and column.
        const prefix = this.#values.get(id)!.after.slice(0, hunk.start + shift).split(/\r\n|\n/);
        const position = editor.document.validatePosition(new vscode.Position(prefix.length - 1, prefix.at(-1)!.length));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
  }

  async capture(editor: vscode.TextEditor): Promise<QuickEditTarget> {
    const document = editor.document;
    const selections = editor.selections;
    const base = baseSelection(document, selections, '');
    if (document.uri.scheme !== 'file' || document.isUntitled || document.languageId === 'binary') {
      throw new VantaError('Quick Edit requires a saved local file open in a text editor.');
    }
    const scope = workspaceScope();
    const repo = await workspaceRepository();
    if (!scope || !repo) throw new VantaError('Open and trust a single local workspace folder for Quick Edit.');
    const path = repo.relative(document.uri.fsPath);
    if (!path) throw new VantaError('This file is outside the readable workspace.');
    base.path = path;
    const absolute = normalizeWorkspacePath(document.uri.fsPath);
    const disk = await Repository.bind(scope);
    const deadline = AbortSignal.timeout(4500);
    const originalDisk = await disk.diskText(path, deadline);
    if (!document.isDirty && originalDisk !== base.text) throw new VantaError('The editor contents differ from disk. Reopen the file before using Quick Edit.');
    const verify = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (await disk.location(path, signal) !== absolute || await disk.diskText(path, signal) !== originalDisk || document.isClosed) {
        throw new VantaError('The source file changed on disk or is no longer available. Run Quick Edit again.');
      }
      assertBase(base, document.version, document.getText());
    };
    const start = document.positionAt(base.start);
    const end = document.positionAt(base.end);
    const before = document.lineAt(Math.max(0, start.line - 10)).range.start;
    const after = document.lineAt(Math.min(document.lineCount - 1, end.line + 10)).range.end;
    const decoded = document.getText().split(/\r\n|\n/);
    const editorSource = await repo.read(path, deadline);
    const redact = (first: number, last: number) => editorSource.lines.slice(first, last + 1)
      .map((line, index) => line !== decoded[first + index]);
    const lastSelected = end.character === 0 ? end.line - 1 : end.line;
    if (redact(start.line, lastSelected).some(Boolean)) {
      throw new VantaError('The selected region includes unsupported text or a potential credential.');
    }
    const surrounding = {
      before: redact(before.line, start.line).some(Boolean) ? '' : document.getText(new vscode.Range(before, start)),
      after: redact(end.line, after.line).some(Boolean) ? '' : document.getText(new vscode.Range(end, after)),
    };
    const symbols = await repo.providerSymbols('', path, deadline);
    const evidence = JSON.stringify({ path, language: document.languageId,
      range: { start: { line: start.line + 1, column: start.character + 1 }, end: { line: end.line + 1, column: end.character + 1 } },
      selected: base.text.slice(base.start, base.end), ...surrounding,
      symbols: symbols.filter((symbol) => symbol.start <= end.line + 1 && symbol.end >= start.line + 1).slice(0, 8) });
    if (estimateContext(evidence) > Math.floor(this.contextBudget() / 2)) throw new VantaError('Select a smaller region to fit the Quick Edit context budget.');
    await verify(deadline);
    return { base, evidence, verify, preview: (patch, hunk) => this.previewChanges(patch.id, patch, hunk, 'Quick Edit'),
      apply: async (hunks, digest, signal, beginCommit) => {
        const visible = vscode.window.visibleTextEditors.find((item) => item.document === document && item.document.uri.scheme === 'file');
        const target = visible && vscode.window.activeTextEditor === visible ? visible
          : await vscode.window.showTextDocument(document, { viewColumn: visible?.viewColumn, preview: false });
        await verify(signal);
        const expected = applyHunks(base, hunks);
        if (fingerprint(expected) !== digest) throw new VantaError('Quick Edit approval does not match the selected changes.');
        beginCommit();
        if (!await target.edit((edit) => {
          for (const hunk of hunks) edit.replace(new vscode.Range(document.positionAt(hunk.start), document.positionAt(hunk.end)), hunk.replacement);
        }, { undoStopBefore: true, undoStopAfter: true })) {
          throw new VantaError('VS Code rejected the edit. Reopen the source and try again.');
        }
        if (document.getText() !== expected) throw new VantaError('The buffer changed during apply. Inspect it in the editor and use Undo if needed.');
        const version = document.version;
        this.#undo = async () => {
          const editor = await vscode.window.showTextDocument(document, { preview: false });
          const timeout = AbortSignal.timeout(4500);
          const actualDisk = await disk.diskText(path, timeout);
          if (!scope.isAvailable() || document.isClosed || document.version !== version || document.getText() !== expected
            || (actualDisk !== originalDisk && actualDisk !== expected)) {
            throw new VantaError('Quick Edit cannot be undone because the source changed. Review the buffer in VS Code.');
          }
          if (!await editor.edit((edit) => {
            edit.replace(new vscode.Range(new vscode.Position(0, 0), document.positionAt(expected.length)), base.text);
          }, { undoStopBefore: true, undoStopAfter: true })) throw new VantaError('VS Code rejected Quick Edit undo.');
        };
      } };
  }

  async undo() {
    if (!this.#undo || this.#inputOpen || this.#undoing || isBusy(this.session.state.phase)) {
      void vscode.window.showInformationMessage('No completed Quick Edit is available to undo right now.');
      return;
    }
    this.#undoing = true;
    try {
      await this.#undo();
      this.#undo = undefined;
    } catch (error) { void vscode.window.showWarningMessage(safeError(error)); }
    finally { this.#undoing = false; }
  }

  async run() {
    if (this.#inputOpen || this.#undoing || isBusy(this.session.state.phase)) {
      void vscode.window.showInformationMessage('Finish or stop the current VANTA request before starting another Quick Edit.');
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length !== 1 || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Select one nonempty code region to use VANTA Quick Edit.');
      return;
    }
    this.#inputOpen = true;
    try {
      const target = await this.capture(editor);
      const instruction = await vscode.window.showInputBox({ title: `VANTA Quick Edit · ${basename(target.base.path)}`,
        prompt: 'Describe the edit. VANTA can share the selection and bounded workspace context with your TrueForge model.',
        placeHolder: 'What should change?', validateInput: (value) => !value.trim() ? 'Enter an instruction.' : value.length > 4000 ? 'Use at most 4,000 characters.' : undefined });
      if (!instruction?.trim()) return;
      if (isBusy(this.session.state.phase)) throw new VantaError('Finish or stop the current VANTA request before running this edit.');
      if (this.session.state.connection.status !== 'connected') await this.session.refresh();
      const connection = this.session.state.connection;
      if (connection.status !== 'connected') throw new VantaError(connection.detail);
      if (!connection.selectedModel) {
        const model = await vscode.window.showQuickPick(connection.models, { placeHolder: 'Choose the TrueForge model for Quick Edit' });
        if (!model) return;
        this.session.selectModel(model);
      }
      void vscode.commands.executeCommand('vanta.studio.focus');
      await this.session.submit(instruction.trim(), true, target);
    } catch (error) { void vscode.window.showWarningMessage(safeError(error)); }
    finally { this.#inputOpen = false; }
  }

  dispose() { this.#values.clear(); this.#undo = undefined; }
}

export const quickEditScheme = scheme;
