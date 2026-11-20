# VANTA

VANTA is a desktop VS Code coding agent built on TrueForge. It searches your repository, streams responses in Agent Studio, and lets you review changes hunk by hunk in native VS Code diffs. Built from scratch for the TrueFoundry Forge-a-thon. Released under the [MIT License](LICENSE).

## Run on Windows

You’ll need desktop VS Code 1.100 or later, Node.js 22.14 or later, and Git. Run the following in PowerShell.

```powershell
git clone https://github.com/vikram144f-cyber/Vanta.git
Set-Location Vanta
npm.cmd ci
```

In a separate PowerShell window, start TrueForge. The loopback allowlist lets it reach VANTA’s authenticated local MCP endpoint. The project uses TrueForge `0.185.1` with SDK `0.185.0`.

```powershell
$env:NETWORK_POLICY_ENABLED = 'true'
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
npx.cmd @truefoundry/trueforge@0.185.1
```

1. Open the [local TrueForge dashboard](http://localhost:8790) and register a model that supports tool calling. The [example model config](docs/model-provider.example.json) shows a Gemini provider with a placeholder. Enter provider credentials directly in TrueForge.
2. Open the VANTA checkout in VS Code. Press **F5** with **Run VANTA** selected. VS Code builds the extension and opens an Extension Development Host. Open and trust a single local project folder in that window to enable workspace tools.
3. Open **VANTA: Open Agent Studio** and select a registered model. Use **Refresh** after changing providers. Sending a request creates a TrueForge session with the matching [versioned agent definition](src/trueforge.ts).

`vanta.serverUrl` defaults to `http://localhost:8790`. Set `vanta.model` to preselect an exact registered model name. For automatic fallback, set `vanta.secondaryModel` to a different registered model and leave `vanta.automaticFallback` enabled. An eligible failure early in a run starts a fresh TrueForge session on the backup.

## Use VANTA

- **Find relevant code.** Enable **Share workspace context**, or attach a reference such as `@file:src/main.py` or `@symbol:src/main.py#main`. Context Explorer shows the returned ranges, selection reasons, and use of the estimated token budget.
- **Edit a selection.** Select code and run **VANTA: Quick Edit** from the Command Palette or press **Ctrl+Alt+I**. Review each hunk in the native diff, then apply the accepted hunks or discard the proposal. Save the file to persist the edit. **VANTA: Undo Last Quick Edit** restores the previous content if the file still matches the applied edit.
- **Change multiple files.** Set **VANTA: Verification Python** to the absolute path of a trusted interpreter with pytest and the target project's dependencies. Enable **Agent Mode** and **Share workspace context**. Review the hunks, then approve pytest separately. VANTA applies the approved edits to editor buffers after pytest passes and the TrueForge turn completes. Use **Save All** to persist the edits.
- **Inspect or stop a run.** Use **Stop** to cancel. **VANTA: Open ProofTrail** shows recent Quick Edit and Agent Mode events, including review, verification, and application. **Copy receipt** exports sanitized JSON with file aliases.

## How it works

TrueForge owns the model loop, sessions, tool calls, and approval events. The TypeScript extension host streams events to Agent Studio and exposes bounded repository reads, patch staging, and approved verification through a short-lived loopback MCP connector. TrueForge loads selected tool definitions on demand, including Quick Edit’s source and symbol lookups. The host validates workspace trust and checks that the exact reviewed patch still matches the current source before applying. Agent Mode supports edits to existing files in one trusted local folder and verifies them using the configured pytest profile in a temporary snapshot.

Agent Mode ranks source ranges by task terms, declarations, and related tests or documentation. Repository reads share an estimated 8,000-token budget by default. Only run the verification profile on a trusted project. Its tests run with your account's OS permissions.

## Project checks

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run test:extension
```

The Extension Host check builds the project. Set `VANTA_VSCODE_EXE` to an installed `Code.exe` to run against that version. Set `VANTA_TEST_PYTHON` to the path of a Python interpreter with pytest to include Python verification cases. These checks work without model credentials.

With local TrueForge running, `npm.cmd run test:fallback` exercises automatic fallback with two temporary mock models. Use `npm.cmd run test:fallback -- --serve` for a manual demo without provider credentials. In Studio select the printed `/unavailable` model and set `vanta.secondaryModel` to the printed `/backup` model. Select the full line `export const enabled = false;` in a trusted TypeScript file and request `Change the selected value to true.` in Quick Edit. Stop the fixture with **Ctrl+C** to remove its profiles.
