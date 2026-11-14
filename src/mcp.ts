import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Connector } from './trueforge';
import { overviewToolName, VantaError } from './trueforge';
import { bindOverview } from './workspace';
import type { WorkspaceScope } from './workspace';
import type { ContextEngine } from './context';
import { proposeTool, proposalSchema, reviewSchema, reviewTool } from './quickPatch';
import type { QuickPatch, ReviewReceipt } from './quickPatch';
import { reviewAgentSchema, reviewAgentTool, stageAgentSchema, stageAgentTool, verifyAgentSchema, verifyAgentTool } from './agentPatch';
import type { AgentReceipt, FileProposal, ReviewReference } from './agentPatch';

export interface AgentTools {
  stage(proposal: FileProposal): Promise<unknown>;
  review(reference: ReviewReference): AgentReceipt;
  verify(target: string): Promise<unknown>;
}

export interface QuickTools {
  stage(replacement: string, explanation: string): QuickPatch;
  receipt(id: string): ReviewReceipt;
}

export interface OverviewBridge extends Connector {
  grant(): void;
  revoke(): void;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const data of request) {
    const chunk = Buffer.from(data as Uint8Array);
    size += chunk.length;
    if (size > limit) throw new VantaError('MCP body limit exceeded.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function startOverviewBridge(scope: WorkspaceScope, signal: AbortSignal, name = `vanta-run-${randomUUID()}`, context?: ContextEngine, quick?: QuickTools, agent?: AgentTools): Promise<OverviewBridge> {
  signal.throwIfAborted();
  const overview = await bindOverview(scope);
  signal.throwIfAborted();
  const secret = `Bearer ${randomBytes(32).toString('base64url')}`;
  const expected = Buffer.from(secret);
  let authority = false;
  let closed = false;
  let host = '';
  let closing: Promise<void> | undefined;
  let reading = false;
  let operations = 0;
  const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
  const expose = async (operation: (current: ContextEngine, deadline: AbortSignal) => Promise<unknown>) => {
    if (!context || closed || signal.aborted || !scope.isAvailable()) return failure('Enable workspace context for this turn in VANTA to use repository tools.');
    if (reading || operations >= 24) return failure('Repository tools allow one call at a time and at most 24 calls per turn.');
    reading = true;
    operations++;
    try {
      const result = await operation(context, AbortSignal.any([signal, AbortSignal.timeout(7500)]));
      if (closed || signal.aborted || !scope.isAvailable()) return failure('The workspace scope ended.');
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return failure(error instanceof VantaError ? error.message : 'Repository lookup failed or exceeded its time limit.');
    } finally { reading = false; }
  };
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
    const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
    const query = z.string().trim().min(1).max(240);
    const path = z.string().max(480);
    const line = z.number().int().min(1).max(100_000);
    server.registerTool('list_workspace_files', {
      description: 'List safe relative file paths, optionally filtered by a filename or path substring.',
      inputSchema: { query: query.optional() }, annotations: readOnly,
    }, (args) => expose((repo, deadline) => repo.list(args.query ?? '', deadline)));
    server.registerTool('search_workspace', {
      description: 'Find a case-insensitive literal in repository filenames or text, returning paths and exact line numbers.',
      inputSchema: { query }, annotations: readOnly,
    }, (args) => expose((repo, deadline) => repo.search(args.query, deadline)));
    server.registerTool('read_file', {
      description: 'Read up to 60 lines from a known relative path. Line numbers start at 1.',
      inputSchema: { path, start: line.optional(), end: line.optional() }, annotations: readOnly,
    }, (args) => expose((repo, deadline) => {
      const start = args.start ?? 1;
      const end = args.end ?? start + 29;
      if (end < start) throw new VantaError('End line must be at or after the start line.');
      return repo.read(args.path, start, end, deadline);
    }));
    server.registerTool('find_symbol', {
      description: 'Find symbol definitions by exact or partial name, optionally in a single relative path.',
      inputSchema: { query, path: path.optional() }, annotations: readOnly,
    }, (args) => expose((repo, deadline) => repo.symbols(args.query, args.path, deadline)));
    server.registerTool('get_context_bundle', {
      description: 'Rank relevant repository locations for a natural-language task, with bounded snippets and selection reasons. Use for unexplored tasks involving code, tests and documentation.',
      inputSchema: { query }, annotations: readOnly,
    }, (args) => expose((repo, deadline) => repo.bundle(args.query, deadline)));
    if (quick) {
      const edit = (operation: () => unknown) => {
        if (closed || signal.aborted || !scope.isAvailable()) return failure('The Quick Edit scope ended.');
        try { return { content: [{ type: 'text' as const, text: JSON.stringify(operation()) }] }; }
        catch (error) { return failure(error instanceof VantaError ? error.message : 'Could not stage the Quick Edit.'); }
      };
      server.registerTool(proposeTool, {
        description: 'Stage a replacement for exactly the captured selection. Supply the full replacement for the selection, preserving unchanged text, indentation and edge newlines. Return the proposal ID for review.',
        inputSchema: proposalSchema, annotations: readOnly,
      }, ({ replacement, explanation }) => edit(() => {
        const patch = quick.stage(replacement, explanation);
        return { proposalId: patch.id, path: patch.base.path, version: patch.base.version, originalFingerprint: patch.baseDigest,
          explanation: patch.explanation, hunks: patch.hunks.map(({ id, start, end, replacement }) => ({ id, start, end, replacement })) };
      }));
      server.registerTool(reviewTool, {
        description: 'Ask the user to review a staged Quick Edit proposal by exact proposal ID. This checkpoint returns a receipt and cannot write to the workspace.',
        inputSchema: reviewSchema, annotations: readOnly,
      }, ({ proposalId }) => edit(() => quick.receipt(proposalId)));
    }
    if (agent) {
      const act = async (operation: () => unknown) => {
        if (closed || signal.aborted || !scope.isAvailable()) return failure('The Agent Mode scope ended.');
        try {
          const result = await operation();
          if (closed || signal.aborted || !scope.isAvailable()) return failure('The Agent Mode scope ended.');
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) { return failure(error instanceof VantaError ? error.message : 'Agent Mode could not complete this operation.'); }
      };
      server.registerTool(stageAgentTool, {
        description: 'Stage all changes for one existing file. Provide its exact relative path and unique verbatim old text anchors plus their replacements. No workspace writes.',
        inputSchema: stageAgentSchema, annotations: readOnly,
      }, (proposal) => act(() => agent.stage(proposal)));
      server.registerTool(reviewAgentTool, {
        description: 'Open native multi-file review with the latest proposal ID and revision. Return the receipt for selected hunks. Approval required.',
        inputSchema: reviewAgentSchema, annotations: readOnly,
      }, (reference) => act(() => agent.review(reference)));
      server.registerTool(verifyAgentTool, {
        description: 'Request approval to run pytest -q on one existing relative Python test file in a temporary copy with the approved changes. Returns command status and exit code.',
        inputSchema: verifyAgentSchema,
      }, ({ target }) => act(() => agent.verify(target)));
    }
    response.once('close', () => { void server.close().catch(() => undefined); });
    void (async () => {
      const body = await readJson(request, agent ? 64 * 1024 : 16_384);
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
    name, url: `http://${host}/mcp`, authorization: secret,
    grant: () => { authority = !closed && !signal.aborted && scope.isAvailable(); },
    revoke: () => { authority = false; },
    close,
  };
}
