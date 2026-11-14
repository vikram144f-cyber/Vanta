import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { startOverviewBridge } from './mcp';
import { parseStudioAction } from './protocol';
import type { StudioUpdate } from './protocol';
import { StudioSession } from './session';
import { TrueForgeClient } from './trueforge';

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
        case 'submitPrompt': void this.session.submit(action.text); break;
        case 'selectModel': this.session.selectModel(action.model); break;
        case 'cancelRun': void this.session.cancel(); break;
        case 'clearConversation': this.session.clear(); break;
        case 'decideApproval': void this.session.decide(action.id, action.allow); break;
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

let session: StudioSession | undefined;

export function activate(context: vscode.ExtensionContext) {
  const studio = new StudioSession({
    settings: () => {
      const config = vscode.workspace.getConfiguration('vanta');
      return {
        serverUrl: config.get('serverUrl', 'http://localhost:8790'),
        model: config.get('model', '').trim(),
        agentName: config.get('agentName', '').trim(),
        workspaceOverview: config.get('workspaceOverview', true),
      };
    },
    forge: (url) => new TrueForgeClient(url),
    bridge: async (signal) => {
      const [folder] = vscode.workspace.workspaceFolders ?? [];
      const isAvailable = () => vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length === 1
        && vscode.workspace.workspaceFolders[0]?.uri.toString() === folder?.uri.toString();
      if (!folder || folder.uri.scheme !== 'file' || !isAvailable()) return;
      return startOverviewBridge({ path: folder.uri.fsPath, isAvailable }, signal);
    },
  });
  session = studio;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('vanta.studio', new StudioView(context.extensionUri, studio)),
    vscode.commands.registerCommand('vanta.openStudio', () => vscode.commands.executeCommand('vanta.studio.focus')),
    vscode.commands.registerCommand('vanta.quickEdit', () => {
      void vscode.window.showInformationMessage('VANTA Quick Edit will be available when editor review is implemented.');
    }),
    vscode.commands.registerCommand('vanta.cancelRun', () => studio.cancel()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('vanta')) void studio.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void studio.cancel(); }),
  );
}

export async function deactivate() {
  await session?.dispose();
  session = undefined;
}
