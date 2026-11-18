import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { proofReceipt } from './proofTrail';
import { proofMarkup } from './proofTrailView';
import type { StudioSession } from './session';

export class ProofTrailPanel implements vscode.Disposable {
  #panel?: vscode.WebviewPanel;

  constructor(private readonly root: vscode.Uri, private readonly session: StudioSession) {}

  open() {
    if (this.#panel) {
      this.#panel.reveal();
      return;
    }
    const media = vscode.Uri.joinPath(this.root, 'media');
    const panel = this.#panel = vscode.window.createWebviewPanel('vanta.proofTrail', 'ProofTrail', vscode.ViewColumn.Beside, {
      enableScripts: true, enableCommandUris: false, localResourceRoots: [media],
    });
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'proofTrail.css'));
    let content: string | undefined;
    let nonce: string;
    const refresh = () => {
      const markup = proofMarkup(this.session.proofTrail());
      if (markup === content) return;
      content = markup;
      nonce = randomBytes(24).toString('base64');
      panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
        <link rel="stylesheet" href="${css}"><title>ProofTrail</title></head>
        <body><main>${markup}</main><script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          document.getElementById('export')?.addEventListener('click', () => vscode.postMessage(${JSON.stringify(nonce)}));
        </script></body></html>`;
    };
    const stop = this.session.listen(refresh);
    const messages = panel.webview.onDidReceiveMessage((value: unknown) => {
      if (value !== nonce) return;
      const trail = this.session.proofTrail();
      if (!trail) return;
      void Promise.resolve(vscode.env.clipboard.writeText(proofReceipt(trail))).then(
        () => vscode.window.showInformationMessage('ProofTrail copied a sanitized JSON receipt.'),
        () => vscode.window.showWarningMessage('ProofTrail could not copy the receipt.'),
      );
    });
    panel.onDidDispose(() => {
      stop();
      messages.dispose();
      this.#panel = undefined;
    });
    refresh();
  }

  dispose() { this.#panel?.dispose(); }
}
