import * as vscode from 'vscode';
import { Repository, normalizeWorkspacePath } from './repository';
import type { SymbolLocation } from './repository';

export function workspaceScope() {
  const [folder] = vscode.workspace.workspaceFolders ?? [];
  if (!folder || folder.uri.scheme !== 'file' || vscode.env.remoteName) return;
  const isAvailable = () => vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length === 1
    && vscode.workspace.workspaceFolders[0]?.uri.toString() === folder.uri.toString();
  return isAvailable() ? { path: folder.uri.fsPath, isAvailable } : undefined;
}

export async function workspaceRepository() {
  const scope = workspaceScope();
  if (!scope) return;
  const repo: Repository = await Repository.bind(scope, {
    buffer: (path) => vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'file' && document.isDirty
      && normalizeWorkspacePath(document.uri.fsPath) === normalizeWorkspacePath(path))?.getText(),
    symbols: { find: async (query, path, signal) => {
      const results: SymbolLocation[] = [];
      const add = (name: string, kind: vscode.SymbolKind, file: string | undefined, range: vscode.Range) => {
        if (file && results.length < 60 && [vscode.SymbolKind.Function, vscode.SymbolKind.Class, vscode.SymbolKind.Method].includes(kind)) {
          results.push({ path: file, name, kind: vscode.SymbolKind[kind].toLowerCase(), source: 'language service',
            start: range.start.line + 1, end: Math.max(range.start.line + 1, range.end.line + Number(range.end.character > 0)) });
        }
      };
      if (path) {
        const uri = vscode.Uri.file(await repo.location(path, signal));
        const items = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri);
        const pending = [...(items ?? [])];
        for (let index = 0; index < pending.length && index < 4000; index++) {
          signal.throwIfAborted();
          const item = pending[index]!;
          if ('children' in item) pending.push(...item.children.slice(0, 1000));
          if (!item.name.toLowerCase().includes(query.toLowerCase())) continue;
          if ('range' in item) add(item.name, item.kind, path, item.range);
          else if (item.location.uri.scheme === 'file') add(item.name, item.kind, repo.relative(item.location.uri.fsPath), item.location.range);
        }
      } else {
        const items = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
        for (const item of (items ?? []).slice(0, 400)) {
          signal.throwIfAborted();
          if (item.location.uri.scheme === 'file') add(item.name, item.kind, repo.relative(item.location.uri.fsPath), item.location.range);
        }
      }
      return results;
    } },
  });
  return repo;
}
