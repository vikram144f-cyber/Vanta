# M6 verification

Agent Studio reports an unregistered model from the TrueForge model list before submitting a turn. Provider errors have separate messages for invalid models, unavailability, rate limits, timeouts, connectivity, and access failures. The messages use fixed text and a bounded numeric retry delay. Studio does not display the provider error body.

Select another configured model, then use **Restore prompt** and **Send** for chat or Agent Mode. For Quick Edit, select the code again and run **VANTA: Quick Edit**. A model change starts a fresh session. A stalled stream times out after 120 seconds without an update. VANTA can subscribe once to an interrupted, known turn without posting the prompt or an approval again.

`vanta.secondaryModel` is an optional exact TrueForge model name. An inline request may switch once after a classified terminal model failure, before model output or tool activity and after the first attempt's local connector closes. The alternate uses a fresh session, a fresh connector and the normal approval gates. Cancellation, ambiguous submission failures and turns with prior model or tool activity require manual recovery.

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

- Windows VS Code 1.146.0, TrueForge v0.185.1, TypeScript SDK 0.185.0. Native Quick Edit session `01m7hnn542e018s9j6ea3r0sm2` used the loopback HTTP 503 fixture. TrueForge made three upstream requests to that fixture during one 3.1-second turn. VANTA submitted one turn. TrueForge recorded `turn.created`, `mcp.initialize` and terminal `turn.done` with status `error` and zero model tokens.
- Studio showed the actionable error and omitted the synthetic provider detail. Editor navigation worked, the unsaved marker remained in the buffer, and the model picker accepted a switch to Flash Lite. The checkout was clean and the SHA-256 of `src/flask/helpers.py` matched before and after. The trace had no staging, approvals, verification, application or save. The disposable provider was removed.
- The final build passed all 47 focused tests. Set `VANTA_TEST_PYTHON` to a Python executable with pytest and run `npx --no-install tsx --test test/unit/session.test.ts test/unit/agentMode.test.ts`. The tests use mocked TrueForge failures and local pytest fixtures. They cover invalid and deleted models, provider 429 and 503, model and stream timeouts, connectivity failures, cancellation, same-turn reconnection, manual and automatic model switching, failure after approval, and preservation and undo of earlier approved edits. Typecheck, lint and build also passed.
- The pinned runtime accepted both inclusive and exclusive cursor reads on the completed Task C turn. Automatic fallback and recovery from a dropped stream during generation have offline coverage. A successful secondary call to an external provider was not part of the native rehearsal. This demonstrates the clear-error recovery route for Task C. Flask Task B acceptance remains open, and the existing Task A docstring and live undo acceptance items remain open. [Pinned TrueForge SDK client](https://github.com/truefoundry/trueforge/blob/v0.185.1/packages/trueforge-sdk/src/api/resources/sessions/client/Client.ts).
