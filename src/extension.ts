import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { startOverviewBridge } from './mcp';
import { parseStudioAction } from './protocol';
import type { StudioUpdate } from './protocol';
import { StudioSession } from './session';
import { TrueForgeClient } from './trueforge';
import { workspaceRepository, workspaceScope } from './editorRepository';
import { QuickEdit, quickEditScheme } from './quickEdit';
import { editorAgent } from './editorAgent';

function contextBudget() {
  return Math.max(2000, Math.min(16000, Math.floor(vscode.workspace.getConfiguration('vanta').get('contextBudget', 8000)) || 8000));
}

class StudioView implements vscode.WebviewViewProvider {
  constructor(private readonly root: vscode.Uri, private readonly session: StudioSession) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.joinPath(this.root, 'dist'), vscode.Uri.joinPath(this.root, 'media')],
    };
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.root, 'dist', 'studio.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.root, 'media', 'studio.css'));
    let ready = false;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (!ready || publishTimer) return;
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        const message: StudioUpdate = { type: 'snapshot', state: this.session.state };
        void Promise.resolve(webview.postMessage(message)).catch(() => undefined);
      }, 32);
    };
    const stopListening = this.session.listen(publish);
    const actions = webview.onDidReceiveMessage((value: unknown) => {
      const action = parseStudioAction(value);
      if (!action) return;
      switch (action.type) {
        case 'ready':
          ready = true;
          publish();
          if (this.session.state.connection.status !== 'connected') void this.session.refresh();
          break;
        case 'refreshConnection': void this.session.refresh(); break;
        case 'submitPrompt': void this.session.submit(action.text, action.shareContext, undefined, action.agentMode); break;
        case 'undoAgent': void this.session.undoAgent(); break;
        case 'selectModel': this.session.selectModel(action.model); break;
        case 'cancelRun': void this.session.cancel(); break;
        case 'clearConversation': this.session.clear(); break;
        case 'decideApproval': void this.session.decide(action.id, action.allow); break;
        case 'reviewHunk': void this.session.reviewHunk(action.id, action.hunk, action.decision); break;
        case 'finishReview': void this.session.finishReview(action.id, action.apply); break;
        case 'rejectRemaining': this.session.rejectRemaining(action.id); break;
        case 'openContext':
          if (this.session.hasLocation(action.path, action.line)) void openContext(action.path, action.line);
          break;
        case 'pickReference': void pickReference(webview); break;
      }
    });
    view.onDidDispose(() => {
      ready = false;
      clearTimeout(publishTimer);
      stopListening();
      actions.dispose();
    });
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <link rel="stylesheet" href="${css}">
  <title>VANTA Agent Studio</title>
</head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body>
</html>`;
  }
}

async function openContext(path: string, line: number) {
  try {
    const repo = await workspaceRepository();
    if (!repo) return;
    const uri = vscode.Uri.file(await repo.location(path, AbortSignal.timeout(1500)));
    const position = new vscode.Position(line - 1, 0);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position), preview: true });
  } catch { void vscode.window.showWarningMessage('VANTA could not open this workspace location.'); }
}

async function pickReference(webview: vscode.Webview) {
  try {
    const repo = await workspaceRepository();
    if (!repo) { void vscode.window.showInformationMessage('Open a trusted local folder to choose a file.'); return; }
    const catalog = await repo.catalog(AbortSignal.timeout(5000));
    const selected = await vscode.window.showQuickPick(catalog.paths, { placeHolder: 'Filter workspace files to insert an @file reference' });
    if (selected) await webview.postMessage({ type: 'insertReference', text: `@file:"${selected}"` } satisfies StudioUpdate);
  } catch { void vscode.window.showWarningMessage('VANTA could not list workspace files.'); }
}

let session: StudioSession | undefined;

export function activate(context: vscode.ExtensionContext) {
  const studio: StudioSession = new StudioSession({
    settings: () => {
      const config = vscode.workspace.getConfiguration('vanta');
      return {
        serverUrl: config.get('serverUrl', 'http://localhost:8790'),
        model: config.get('model', '').trim(),
        secondaryModel: config.get('secondaryModel', '').trim(),
        agentName: config.get('agentName', '').trim(),
        workspaceOverview: config.get('workspaceOverview', true),
        verificationPython: config.get('verificationPython', '').trim(),
        contextBudget: contextBudget(),
      };
    },
    forge: (url) => new TrueForgeClient(url),
    scopeKey: () => workspaceScope()?.path ?? '',
    repository: workspaceRepository,
    agentWorkspace: () => editorAgent(quickEdit.previewChanges.bind(quickEdit)),
    bridge: async (signal, name, context, quick, agent) => {
      const scope = workspaceScope();
      if (!scope) return;
      const delay = vscode.workspace.getConfiguration('vanta').get('agentToolReplyDelayMs', 0);
      return startOverviewBridge(scope, signal, name, context, quick, agent, Math.max(0, Math.min(20_000, delay)));
    },
  });
  session = studio;
  const quickEdit = new QuickEdit(studio, contextBudget);
  context.subscriptions.push(
    quickEdit,
    vscode.workspace.registerTextDocumentContentProvider(quickEditScheme, quickEdit),
    vscode.window.registerWebviewViewProvider('vanta.studio', new StudioView(context.extensionUri, studio)),
    vscode.commands.registerCommand('vanta.openStudio', () => vscode.commands.executeCommand('vanta.studio.focus')),
    vscode.commands.registerCommand('vanta.quickEdit', () => quickEdit.run()),
    vscode.commands.registerCommand('vanta.undoQuickEdit', () => quickEdit.undo()),
    vscode.commands.registerCommand('vanta.cancelRun', () => studio.cancel()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('vanta')) void studio.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void studio.workspaceChanged(); }),
  );
}

export async function deactivate() {
  await session?.dispose();
  session = undefined;
}
