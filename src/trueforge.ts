import { TrueForge, TrueForgeError } from '@truefoundry/trueforge-sdk';
import type { TrueForgeApi as Api } from '@truefoundry/trueforge-sdk';

export const overviewToolName = 'get_workspace_overview';
export type Event = Api.TurnStreamingEvent;
export type SessionAgent = Api.CreateSessionAgent;
export type ApprovalEvent = Api.UserToolApprovalInputEvent;

export interface Connector {
  name: string;
  url: string;
  authorization: string;
}

export interface Forge {
  check(signal: AbortSignal): Promise<{ version: string; models: string[] }>;
  createSession(agent: SessionAgent, signal: AbortSignal): Promise<string>;
  start(sessionId: string, prompt: string, signal: AbortSignal): AsyncIterable<Event>;
  resume(sessionId: string, turnId: string, afterEventId: string, signal: AbortSignal): AsyncIterable<Event>;
  approve(sessionId: string, turnId: string, event: ApprovalEvent, signal: AbortSignal): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  register(connector: Connector, signal: AbortSignal): Promise<void>;
  remove(name: string): Promise<void>;
}

export class VantaError extends Error {}

export function safeError(error: unknown): string {
  if (error instanceof VantaError) return error.message;
  if (error instanceof TrueForgeError) {
    switch (error.statusCode) {
      case 400: return 'TrueForge rejected the request. Check the configured model and server version.';
      case 401:
      case 403: return 'TrueForge denied access. Check the local server and its authentication settings.';
      case 404: return 'TrueForge could not find the requested agent, session or API endpoint.';
      case 409: return 'TrueForge could not apply the request to the current turn state.';
      case 429: return 'TrueForge rate limited the request. Wait briefly and try again.';
      default: return 'TrueForge could not complete the request. Check the local TrueForge dashboard.';
    }
  }
  return 'Could not communicate with TrueForge. Check that the local server is running.';
}

export function localServerUrl(input: string): URL {
  const url = URL.parse(input);
  if (!url || !['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new VantaError('VANTA: Server URL must be a local TrueForge origin, such as http://localhost:8790.');
  }
  return url;
}

export function inlineAgent(model: string, connector?: string): SessionAgent {
  return {
    spec: {
      model: { name: model },
      instructions: 'You are VANTA, a VS Code coding assistant. If asked about the current workspace, use get_workspace_overview when available. If it is denied or unavailable, say so. Never guess the contents of the workspace.',
      config: {
        sandbox: { enabled: false },
        contextManagement: { largeToolResponse: { enabled: false } },
        iterationLimit: 12,
      },
      mcpServers: connector ? [{
        name: connector, preload: true, enableTools: [overviewToolName], requireApprovalForTools: [overviewToolName],
      }] : [],
    },
  };
}

export class TrueForgeClient implements Forge {
  readonly #client: TrueForge;
  readonly #url: URL;

  constructor(baseUrl: string) {
    this.#url = localServerUrl(baseUrl);
    // Refuse cross-origin redirects at the HTTP boundary, including for connector secrets.
    const fetchLocal: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== this.#url.origin) throw new VantaError('Unexpected TrueForge request origin.');
      return fetch(input, { ...init, redirect: 'error' });
    };
    this.#client = new TrueForge({ baseUrl: this.#url.origin, maxRetries: 0, timeoutInSeconds: 12, fetch: fetchLocal });
  }

  async check(signal: AbortSignal) {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(4500)]);
    const response = await fetch(new URL('/healthz', this.#url), { signal: timeout, redirect: 'error' });
    if (!response.ok) throw new VantaError('The configured endpoint did not return a healthy TrueForge response.');
    const status: unknown = await response.json();
    if (!status || typeof status !== 'object' || !('status' in status) || status.status !== 'ok'
      || !('version' in status) || typeof status.version !== 'string' || !/^[\w.+-]{1,40}$/.test(status.version)) {
      throw new VantaError('The local server did not report a TrueForge version.');
    }
    const { data } = await this.#client.models.list({ abortSignal: timeout });
    return { version: status.version, models: data.map((model) => model.name) };
  }

  async createSession(agent: SessionAgent, signal: AbortSignal): Promise<string> {
    const { data } = await this.#client.sessions.create({ agent }, { abortSignal: signal });
    return data.id;
  }

  async *start(sessionId: string, prompt: string, signal: AbortSignal) {
    const stream = await this.#client.sessions.createTurnStream(sessionId, {
      input: [{ type: 'user.message', content: prompt }],
    }, { abortSignal: signal, timeoutInSeconds: 600 });
    yield* stream;
  }

  async *resume(sessionId: string, turnId: string, afterEventId: string, signal: AbortSignal) {
    const stream = await this.#client.sessions.subscribeToTurn(sessionId, turnId, { afterEventId }, {
      abortSignal: signal, timeoutInSeconds: 600,
    });
    yield* stream;
  }

  async approve(sessionId: string, turnId: string, event: ApprovalEvent, signal: AbortSignal) {
    await this.#client.sessions.createTurnEvents(sessionId, turnId, { events: [event] }, { abortSignal: signal });
  }

  async cancel(sessionId: string) {
    await this.#client.sessions.cancel(sessionId, {}, { abortSignal: AbortSignal.timeout(4000) });
  }

  async register(connector: Connector, signal: AbortSignal) {
    await this.#client.settings.mcpServers.create({ manifest: {
      name: connector.name,
      type: 'remote',
      url: connector.url,
      description: 'VANTA read-only workspace overview for the active request.',
      auth: { type: 'header', headers: { Authorization: connector.authorization } },
    } }, { abortSignal: signal });
  }

  async remove(name: string) {
    try {
      await this.#client.settings.mcpServers.delete(name, { abortSignal: AbortSignal.timeout(4000) });
    } catch (error) {
      if (!(error instanceof TrueForgeError && error.statusCode === 404)) throw error;
    }
  }
}
