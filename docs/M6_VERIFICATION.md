# M6 verification

Agent Studio reports an unregistered model from the TrueForge model list before submitting a turn. Provider errors have separate messages for invalid models, unavailability, rate limits, timeouts, connectivity, and access failures. The messages use fixed text and a bounded numeric retry delay. Studio does not display the provider error body.

Select another configured model, then use **Restore prompt** and **Send** for chat or Agent Mode. For Quick Edit, select the code again and run **VANTA: Quick Edit**. A model change starts a fresh session. A stalled stream times out after 120 seconds without an update. VANTA can subscribe once to an interrupted, known turn without posting the prompt or an approval again.

`vanta.model` (or the Studio picker) selects the primary. Set `vanta.secondaryModel` to a different registered TrueForge model and leave `vanta.automaticFallback` enabled. It defaults to enabled for existing configurations with a secondary. An inline request may switch once after TrueForge confirms a transient terminal model-provider failure, before model output or tool activity and after the first attempt's local connector closes. The backup gets the original request and workspace context with a fresh session, connector and approval gates. Cancellation, credential errors, ambiguous submission failures and turns with prior model or tool activity require manual recovery.

The TrueForge v0.185.1 agent schema has one model and supports an explicit model override. VANTA orchestrates the switch between two TrueForge sessions. The pinned runtime labels provider failures with `[Model Error]` in terminal messages. TrueForge retains control of upstream retries, model calls and tools in both sessions. [Agent schema](https://github.com/truefoundry/trueforge/blob/v0.185.1/packages/trueforge-core/src/agent-session/schemas/agentSpec.ts) · [Provider error contract](https://github.com/truefoundry/trueforge/blob/v0.185.1/packages/trueforge-core/src/core/errors.ts)

## Reproduce automatic fallback with local mock providers

Start TrueForge with the loopback allowlist in the [Windows setup](../README.md). Set `VANTA_VSCODE_EXE` to your installed `Code.exe` and run `npm.cmd run test:fallback` from VANTA. The test uses a disposable VS Code workspace and two temporary local mock models. The primary returns HTTP 503 and the backup exercises Quick Edit staging and native review. The test discards the proposal and checks that both disk files and an unrelated dirty buffer stayed intact.

For a manual Studio check, run `npm.cmd run test:fallback -- --serve` and use the printed model names as `vanta.model` and `vanta.secondaryModel` in a separate Extension Development Host user profile. Refresh Studio, then open a trusted disposable folder with a TypeScript file containing `export const enabled = false;`. Select its whole line including the newline and run Quick Edit with **Change the selected value to true.** Expand **Agent activity** to show **Primary model failed** and **Using configured secondary model**. Discard the diff and stop the fixture with Ctrl+C. The backup is scripted for this synthetic example.

For the fixed Task C recording, configure a primary with an unreachable endpoint and a working secondary in TrueForge, then use the pinned Flask checkout and the exact Task A instruction. Show the automatic switch and clean Git status before accepting any proposal from the secondary. Gemini Flash Lite Latest previously completed Task A as a primary and is a candidate for a controlled backup check.

## Reproduce Task C without using provider quota

1. Build VANTA and start local TrueForge v0.185.1 using the [Windows setup](../README.md). In a separate Extension Development Host, open a clean, trusted `pallets/flask` 3.1.3 checkout at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Check that `git status --porcelain` is empty and record the SHA-256 of `src/flask/helpers.py`.
2. From the VANTA repository in another PowerShell window, register a disposable OpenAI-compatible fixture that returns HTTP 503. Keep this window running until the demo ends.

   ```powershell
   @'
   import { createServer } from 'node:http';
   import { TrueForge } from '@truefoundry/trueforge-sdk';

   const name = 'vanta-taskc-offline';
   const forge = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0, timeoutInSeconds: 5 });
   const server = createServer((request, response) => {
     request.resume();
     response.setHeader('Content-Type', 'application/json');
     if (request.method === 'GET') {
       response.end(JSON.stringify({ object: 'list', data: [{ id: 'unavailable', object: 'model' }] }));
       return;
     }
     console.log(request.method, request.url, 503);
     response.writeHead(503);
     response.end(JSON.stringify({ error: {
       type: 'server_error', code: 'service_unavailable', message: 'synthetic-provider-private-detail',
     } }));
   });
   await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
   try {
     await forge.settings.modelProviders.create({ manifest: {
       type: 'custom', name, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
       models: [{ name: 'unavailable', modelId: 'unavailable', properties: {} }],
     } });
   } catch (error) {
     server.close();
     throw error;
   }
   console.log('Refresh Agent Studio and choose vanta-taskc-offline/unavailable.');
   process.once('SIGINT', async () => {
     try { await forge.settings.modelProviders.delete(name); }
     finally { server.close(); }
   });
   '@ | node --input-type=module
   ```

3. Leave `vanta.secondaryModel` blank. In Agent Studio select **Refresh** and choose `vanta-taskc-offline/unavailable`. Add a harmless comment to the end of `src/flask/helpers.py` and leave it unsaved. Select the entire `get_debug_flag` function, run **VANTA: Quick Edit**, and submit the official instruction once.

   > Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

4. Verify that Studio reports **The configured model is temporarily unavailable**, offers recovery, and shows **Failed**. Navigate back to the unsaved comment and confirm it is still present. Choose another configured model in Studio to demonstrate recovery of the picker. Check that the Flask checkout remains clean and that the file hash matches. Stop the fixture with Ctrl+C to remove its temporary model profile.

## Observed evidence

- On 2026-11-18, the native Flask Task C check used the exact Task A instruction and an unreachable loopback model endpoint. Primary session `01m7ph8gf9rywjeq3gerbgq3ka` ended at `ECONNREFUSED`. VANTA switched once to Gemini Flash Lite Latest in session `01m7ph8gq9bnr9vtr2ra5cq1mk`. The real backup produced a native proposal that passed all 24 behavior cases and the docstring check. The test discarded it, verified the original helper, preserved an unrelated unsaved note, and confirmed clean Git status.
- The live stream cancellation check stopped on a visible Gemini text delta. Local cancelling state appeared in 5.11 ms, and TrueForge confirmed session `01m7phj68c40abyjqqys2h2ybs` was cancelled. The pinned checkout remained clean.
- On 2026-11-18, a Windows VS Code 1.146.0 Extension Host ran a synthetic Quick Edit through TrueForge v0.185.1 and SDK v0.185.0. The primary mock returned HTTP 503 three times under TrueForge's upstream retry policy. The primary stream opened an empty model-message frame, followed by a terminal provider error. VANTA switched once to the backup in a new session. The backup made four scripted calls to stage, check, review and finish. The native diff opened and the test discarded it. Both disk files and the unrelated unsaved note kept their original state. Sessions `01m7pgpdkth3gdyn6nkyh5nv1e` and `01m7pgpgqs3cxhz6qygj1w213w`.
- The fallback unit fixtures exercised 429, 502, 503, provider timeout, connection refusal, disabled or absent backup, invalid credentials, invalid tool arguments, cancellation and safety after staging or review. The Agent Mode fixture switched before any staging, then required fresh hunk and pytest approvals. All 97 unit tests passed on Windows with Python 3.13.1 and Ruff 0.16.3 configured.
- Windows VS Code 1.146.0, TrueForge v0.185.1, TypeScript SDK 0.185.0. Native Quick Edit session `01m7hnn542e018s9j6ea3r0sm2` used the loopback HTTP 503 fixture. TrueForge made three upstream requests to that fixture during one 3.1-second turn. VANTA submitted one turn. TrueForge recorded `turn.created`, `mcp.initialize` and terminal `turn.done` with status `error` and zero model tokens.
- Studio showed the actionable error and omitted the synthetic provider detail. Editor navigation worked, the unsaved marker remained in the buffer, and the model picker accepted a switch to Flash Lite. The checkout was clean and the SHA-256 of `src/flask/helpers.py` matched before and after. The trace had no staging, approvals, verification, application or save. The disposable provider was removed.
- The final build passed all 47 focused tests. Set `VANTA_TEST_PYTHON` to a Python executable with pytest and run `npx --no-install tsx --test test/unit/session.test.ts test/unit/agentMode.test.ts`. The tests use mocked TrueForge failures and local pytest fixtures. They cover invalid and deleted models, provider 429 and 503, model and stream timeouts, connectivity failures, cancellation, same-turn reconnection, manual and automatic model switching, failure after approval, and preservation and undo of earlier approved edits. Typecheck, lint and build also passed.
- The pinned runtime accepted both inclusive and exclusive cursor reads on the earlier HTTP 503 turn, which exercised the clear-error route. [Pinned TrueForge SDK client](https://github.com/truefoundry/trueforge/blob/v0.185.1/packages/trueforge-sdk/src/api/resources/sessions/client/Client.ts)
