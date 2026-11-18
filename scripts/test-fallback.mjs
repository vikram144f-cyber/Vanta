import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const serve = process.argv.includes('--serve');
const provider = `vanta-fallback-fixture-${randomUUID().slice(0, 8)}`;
const modelIds = ['unavailable', 'backup'];
const forge = new TrueForge({ baseUrl: 'http://localhost:8790', maxRetries: 0, timeoutInSeconds: 5 });
const requests = { unavailable: 0, backup: 0 };

function backupResponse({ messages, tools }) {
  const proposals = tools?.find((tool) => tool.function?.name.endsWith('propose_quick_edit'));
  if (!proposals) return { content: 'Local backup fixture responded.' };
  const prompt = messages.find((message) => message.role === 'user');
  const input = JSON.stringify(prompt?.content);
  assert.ok(/Change the selected value to true\./.test(input), 'The backup did not receive the fixture prompt');
  assert.ok(/export const enabled = false;/.test(input), 'The backup did not receive the fixture selection');
  const results = messages.filter((message) => message.role === 'tool');
  if (results.length >= 3) return { content: 'The backup reached and completed the review checkpoint.' };
  const name = ['propose_quick_edit', 'check_quick_edit', 'review_quick_edit'][results.length];
  const tool = tools.find((entry) => entry.function?.name.endsWith(name));
  assert.ok(tool, `Missing fixture tool ${name}`);
  const proposalId = results.length
    ? /"proposalId"\s*:\s*"([a-f0-9-]{36})"/.exec(results.at(-1).content)?.[1]
    : undefined;
  if (results.length) assert.ok(proposalId, 'The fixture did not receive a proposal ID');
  const inputByTool = [
    { replacement: 'export const enabled = true;\n', explanation: 'Enable the selected value.' },
    { proposalId, checks: [{ scenario: 'Read the selected constant', outcome: 'Its value is true.' }] },
    { proposalId },
  ];
  return { tool_calls: [{ index: 0, id: `fixture-tool-${results.length}`, type: 'function',
    function: { name: tool.function.name, arguments: JSON.stringify(inputByTool[results.length]) } }] };
}

const providerFailure = { error: { type: 'server_error', code: 'service_unavailable', message: 'synthetic-provider-private-detail' } };
const server = createServer(async (request, response) => {
  try {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify({ object: 'list', data: modelIds.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    request.setEncoding('utf8');
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.model === 'unavailable') {
      requests.unavailable++;
      response.writeHead(503).end(JSON.stringify(providerFailure));
      return;
    }
    assert.ok(input.model === 'backup', 'Unexpected fixture model');
    requests.backup++;
    const delta = backupResponse(input);
    const chunk = (value, finish_reason = null) => `data: ${JSON.stringify({
      id: 'fixture-completion', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
      model: input.model, choices: [{ index: 0, delta: value, finish_reason }],
    })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(chunk({ role: 'assistant', ...delta }));
    response.end(chunk({}, delta.tool_calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  } catch (error) {
    console.error('Local fallback fixture failed:', error instanceof assert.AssertionError ? error.message : 'unexpected request error');
    if (!response.headersSent) response.writeHead(400);
    response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Local fixture could not handle this request.' } }));
  }
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
let registered = false;
try {
  await forge.settings.modelProviders.create({ manifest: {
    type: 'custom', name: provider, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: modelIds.map((id) => ({ name: id, modelId: id, properties: {} })),
  } });
  registered = true;
  console.log(`Local mock models: ${provider}/unavailable → ${provider}/backup`);
  if (serve) {
    console.log('Press Ctrl+C to remove the local mock models.');
    await once(process, 'SIGINT');
  } else {
    const env = { ...process.env, VANTA_FALLBACK_FIXTURE: provider };
    for (const script of ['scripts/build.mjs', 'scripts/test-extension.mjs']) {
      const child = spawn(process.execPath, [script], { env, stdio: 'inherit' });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, `${script} failed`);
    }
    assert.ok(requests.unavailable >= 1);
    assert.equal(requests.backup, 4, 'The backup should stage, check, review, and finish once');
    console.log('Local mock request counts:', requests);
  }
} finally {
  server.close();
  if (registered) await forge.settings.modelProviders.delete(provider);
}
