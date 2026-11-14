import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Connector } from './trueforge';
import { overviewToolName, VantaError } from './trueforge';
import { bindOverview } from './workspace';
import type { WorkspaceScope } from './workspace';

export interface OverviewBridge extends Connector {
  grant(): void;
  revoke(): void;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const data of request) {
    const chunk = Buffer.from(data as Uint8Array);
    size += chunk.length;
    if (size > 16_384) throw new VantaError('MCP body limit exceeded.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function startOverviewBridge(scope: WorkspaceScope, signal: AbortSignal): Promise<OverviewBridge> {
  signal.throwIfAborted();
  const overview = await bindOverview(scope);
  signal.throwIfAborted();
  const secret = `Bearer ${randomBytes(32).toString('base64url')}`;
  const expected = Buffer.from(secret);
  let authority = false;
  let closed = false;
  let host = '';
  let closing: Promise<void> | undefined;
  const listener = createServer({ requestTimeout: 8000, headersTimeout: 5000 }, (request, response) => {
    const presented = Buffer.from(request.headers.authorization ?? '');
    if (closed || signal.aborted || request.headers.host !== host || request.headers.origin !== undefined
      || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = new McpServer({ name: 'vanta-workspace', version: '0.1.0' });
    server.registerTool(overviewToolName, {
      description: 'List safe top-level folder and file names in the current VS Code workspace. Requires explicit approval.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    }, async () => {
      if (closed || signal.aborted || !authority || !scope.isAvailable()) {
        return { isError: true, content: [{ type: 'text', text: 'Workspace overview requires an active VANTA approval.' }] };
      }
      authority = false;
      try {
        const result = await overview();
        if (closed || signal.aborted) throw new VantaError('Request cancelled.');
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Workspace overview is unavailable for this folder.' }] };
      }
    });
    response.once('close', () => { void server.close().catch(() => undefined); });
    void (async () => {
      const body = await readJson(request);
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      listener.off('error', reject);
      resolve();
    });
  });
  const address = listener.address();
  if (!address || typeof address === 'string') {
    listener.close();
    throw new VantaError('Could not bind the local workspace overview endpoint.');
  }
  host = `127.0.0.1:${address.port}`;
  const close = () => {
    authority = false;
    closed = true;
    signal.removeEventListener('abort', onAbort);
    if (!closing) {
      closing = new Promise<void>((resolve) => listener.close(() => resolve()));
      listener.closeAllConnections();
    }
    return closing;
  };
  const onAbort = () => { void close(); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  return {
    name: `vanta-run-${randomUUID()}`, url: `http://${host}/mcp`, authorization: secret,
    grant: () => { authority = !closed && !signal.aborted && scope.isAvailable(); },
    revoke: () => { authority = false; },
    close,
  };
}
