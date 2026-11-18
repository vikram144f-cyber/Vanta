# VANTA

VANTA is a desktop VS Code coding agent for Windows. It uses a local TrueForge agent to discover repository context, propose edits and run approved checks. Agent Studio shows the run, why files were selected and what is waiting for review.

- **Context Explorer** shows bounded repository search, symbol lookup and source snippets. Share workspace context for a turn, or attach a specific file or symbol with `@file:` or `@symbol:`.
- **Quick Edit** starts from a selection and opens a native VS Code diff. Review each hunk, apply the approved changes and save. **VANTA: Undo Last Quick Edit** can restore a saved edit when the source still matches.
- **Agent Mode** stages edits across existing files. It requires native hunk approval, separate approval for the configured pytest profile, a passing snapshot check and a completed TrueForge turn before applying the patch to editor buffers.
- **Recovery** offers Stop, clear model errors, prompt restoration and model switching. An optional secondary model can start a fresh session after a confirmed early model failure.

## Install and launch on Windows

1. Clone [VANTA on GitHub](https://github.com/vikram144f-cyber/Vanta) and check out the development branch `codex/vanta-vertical-slice`. Use desktop VS Code 1.100+ and Node.js 22.14+. In the repository, run `npm.cmd ci`.
2. In a separate PowerShell window, start the verified TrueForge version. The loopback allowlist lets TrueForge call VANTA's local MCP endpoint. If a server is already running with a different allowlist, restart it from its terminal with these settings.

   ```powershell
   $env:NETWORK_POLICY_ENABLED = 'true'
   $env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
   npx.cmd @truefoundry/trueforge@0.185.1
   ```

3. Open the [local TrueForge dashboard](http://localhost:8790) and configure a model provider. The [example manifest](docs/model-provider.example.json) shows the shape of a Google Gemini profile with a placeholder key. Enter credentials only in TrueForge. Use the [offline Task C fixture](docs/M6_VERIFICATION.md#reproduce-task-c-without-using-provider-quota) to demonstrate recovery without a provider credential or paid API.
4. Open the VANTA repository in VS Code and press **F5** with **Run VANTA**. In the Extension Development Host, open and trust a single local repository. Click the **VANTA** icon or run **VANTA: Open Agent Studio**. Select a configured model. If the list changed, click **Refresh**.
5. For Agent Mode verification, set **VANTA: Verification Python** to an absolute path to a trusted Python interpreter containing pytest and the demo project's dependencies. Enable **Agent Mode** and **Share workspace context** before submitting a task.

`vanta.serverUrl` defaults to `http://localhost:8790`. `vanta.model` selects an exact TrueForge model name. To opt into early fallback, set `vanta.secondaryModel` to another registered name. The extension loads its own inline TrueForge definition when you start a request, including [Agent Mode's versioned definition](src/trueforge.ts). For chat with workspace tools disabled, you can optionally choose a saved TrueForge agent with `vanta.agentName`.

## Demonstration and evidence

| Workflow | Observed result | Reproduce |
| --- | --- | --- |
| Official Flask Task A | Native Quick Edit, both hunks approved, 24 behavior checks, Save, and Undo restored the original SHA-256. | [Task A evidence](docs/M4_VERIFICATION.md#gemini-35-flash-rehearsal-at-8c72cf2) |
| General-purpose multi-file edits | Live TrueForge discovered and staged an invoice implementation, test and docs. Both gates ran through the adapter, pytest passed and the in-memory apply/undo assertions passed. | [M5 fixture evidence](docs/M5_VERIFICATION.md#live-evidence), [Agent Mode guide](docs/AGENT_MODE.md) |
| Official Flask Task C | Native VS Code and TrueForge with a loopback provider returning HTTP 503. Studio showed the error, preserved an unsaved edit and let the user switch models. | [Offline Task C procedure](docs/M6_VERIFICATION.md#reproduce-task-c-without-using-provider-quota) |
| Official Flask Task B | Acceptance is incomplete. Recorded attempts reached different stages and were blocked by model output, rate limits or provider errors. | [Official Task B evidence and limitations](docs/M5_VERIFICATION.md) |

Use the [four-minute demo script](docs/DEMO_SCRIPT.md) and [recording checklist](docs/DEMO_CHECKLIST.md). The [technical write-up draft](docs/VANTA_TECHNICAL_WRITEUP.pdf) and its [editable source](docs/TECHNICAL_WRITEUP.md) describe the architecture, evidence and open submission fields. See the [M7 verification record](docs/M7_VERIFICATION.md) for the preparation checks.

## Architecture

The VS Code extension host validates workspace operations and streams TrueForge SDK events to the React view. TrueForge owns the model loop, session history, tool invocation and approval events. VANTA exposes read, search, staging and approved verification through a short-lived, authenticated MCP listener on loopback. Deferred discovery loads additional repository tools when the model asks for them. Context Explorer reports what was shared. The host binds approval to the exact staged revision and applies only reviewed changes after verification. [Architecture](docs/ARCHITECTURE.md) · [Context engine](docs/CONTEXT_ENGINE.md) · [Quick Edit](docs/QUICK_EDIT.md)

## Checks

From the repository root in PowerShell, set `VANTA_TEST_PYTHON` to a Python executable with pytest to include the local command profiles. Set `VANTA_VSCODE_EXE` to an installed `Code.exe` to use that build for the Extension Host check.

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd test
npm.cmd run test:extension
```

The unit and Extension Host checks use local fixtures. `npm.cmd run test:live` is a separate opt-in suite that can call a configured provider when the relevant model environment variables are set. The source checkout and F5 launch are the supported distribution path. This branch has no configured VSIX packaging workflow.

## Known limitations

Agent Mode edits existing files and verifies Python through one approved pytest profile. It operates in one trusted local folder. Context is bounded, and hosted providers can reach quotas or return incomplete patches. The automatic fallback path has offline tests. The native resilience evidence demonstrates the clear-error recovery path. Official Task B remains open.
