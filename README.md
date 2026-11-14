# VANTA

VANTA is a desktop VS Code extension that streams a local TrueForge agent into Agent Studio. It supports workspace discovery, Quick Edit and multi-file Agent Mode with native diff review and per-hunk decisions.

## Run on Windows

1. Install Node.js 22.14+ and desktop VS Code 1.100+. In PowerShell from the repository root, run `npm.cmd ci`.
2. Run TrueForge in a separate PowerShell window. Use a local server and keep model credentials in TrueForge's model settings. For the workspace tool, add the exact VANTA loopback host to TrueForge's outbound host allowlist before starting the server. If TrueForge is already running without this entry, stop it from its terminal and restart it there.

   ```powershell
   $env:NETWORK_POLICY_ENABLED = 'true'
   $env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
   npx.cmd @truefoundry/trueforge@0.185.1
   ```

3. Open `http://localhost:8790` and confirm that TrueForge has a configured model. The extension lets you choose from the models that server reports.
4. Open this repository in VS Code and press **F5** with the **Run VANTA** launch configuration. The debug task builds both bundles. In the Extension Development Host, click the **VANTA** activity bar icon or run **VANTA: Open Agent Studio**. Open and trust a single local folder to enable the workspace tool. Use a throwaway folder with a recognizable top-level folder name for verification.
5. Select your TrueForge model. Send `Hello VANTA. Explain in two sentences what an AI coding agent does.` with Enter or **Send**. Shift+Enter inserts a newline. A longer prompt makes streamed increments easier to see. Copy the session ID from **Agent activity** to find the run in TrueForge.
6. Send `Inspect the current workspace and tell me which top-level folders exist.` Wait for **Read workspace overview**. Choose **Allow once** and check that the response includes your fixture folder. Repeat with **Reject**, and once more with **Stop** while approval is pending. Check that neither run reveals the name.

`vanta.serverUrl` defaults to `http://localhost:8790`. `vanta.model` optionally selects an exact model name reported by TrueForge. `vanta.workspaceOverview` enables the metadata tool in a trusted single-folder workspace. Set it to `false` for chat-only mode. In chat-only mode `vanta.agentName` can select a saved chat-only VANTA agent by name. A server with the default outbound policy can still stream chat and shows why the workspace tool was unavailable. [TrueForge quickstart](https://trueforge.dev/quickstart), [pinned outbound policy configuration](https://github.com/truefoundry/trueforge/blob/v0.185.1/packages/trueforge/src/config.ts).

## Checks

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd test
npm.cmd run test:extension
```

The extension test runner downloads VS Code unless `VANTA_VSCODE_EXE` is set to the path of an installed `Code.exe`. The standalone live test uses the same session controller, SDK adapter and MCP bridge as the extension. It sends test prompts to your configured model and uses a temporary workspace. Use the exact model ID from your server.

```powershell
$env:VANTA_LIVE_MODEL = 'google-gemini/gemini-3-5-flash-lite'
$env:VANTA_LIVE_MCP = '1'
npm.cmd run test:live
```

Set `VANTA_LIVE_URL` for another local TrueForge port. Unset `VANTA_LIVE_MCP` for the chat-only smoke test. The live suite skips when `VANTA_LIVE_MODEL` is absent.

## Implementation

The React webview receives typed snapshots from the TypeScript extension host, which validates UI actions and consumes TrueForge events through the official SDK. Each request uses a disposable bearer-authenticated MCP endpoint on `127.0.0.1` when workspace tools are available. The overview returns filtered top-level names and counts. It resolves a real `tool.approval_required` event, sends a `user.tool_approval` decision, and requires a separate one-use host grant. Repository tools use the composer's explicit sharing consent. The bridge closes and the connector is deleted when the run ends. TrueForge owns model calls, tool invocation and recorded conversation history.

See [verification results](docs/VERTICAL_SLICE.md) and the [competition architecture](docs/ARCHITECTURE.md).

## Repository discovery

Enable **Share workspace context** for a turn to allow read-only search, symbol lookup, and bounded snippets. Use **Add file…** or type `@file:path` and `@symbol:name` for explicit references. **Context Explorer** shows returned paths, selection reasons and estimated budget usage. Follow-up turns reuse the current TrueForge session. **New conversation** resets it. See the [context engine guide](docs/CONTEXT_ENGINE.md).

## Quick Edit

Select a code region in a trusted local file and press **Ctrl+Alt+I** on Windows or choose **VANTA: Quick Edit** from the editor context menu. Enter the instruction and review the native diff. Accept or reject each hunk in Agent Studio, then apply the accepted changes. Use **Ctrl+S** to save and **Ctrl+Z** in the source editor to undo. See the [Quick Edit guide](docs/QUICK_EDIT.md).

## Agent Mode

Set **VANTA: Verification Python** to an absolute path to a trusted interpreter with pytest and project dependencies. Check **Agent Mode** and **Share workspace context** in Studio. Review the proposed files and hunks, approve the separate pytest run, then save the applied buffers in VS Code. See the [Agent Mode guide](docs/AGENT_MODE.md) and [M5 verification report](docs/M5_VERIFICATION.md).
