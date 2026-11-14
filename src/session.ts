import type { TrueForgeApi as Api } from '@truefoundry/trueforge-sdk';
import type { OverviewBridge } from './mcp';
import { isBusy } from './protocol';
import type { StudioState } from './protocol';
import { inlineAgent, overviewToolName, safeError, VantaError } from './trueforge';
import type { Event, Forge } from './trueforge';

export interface Settings {
  serverUrl: string;
  model: string;
  agentName: string;
  workspaceOverview: boolean;
}

interface Dependencies {
  settings(): Settings;
  forge(url: string): Forge;
  bridge(signal: AbortSignal): Promise<OverviewBridge | undefined>;
}

interface Run {
  id: number;
  forge: Forge;
  abort: AbortController;
  sessionId?: string;
  turnId?: string;
  bridge?: OverviewBridge;
  calls: Map<string, { name: string; sourceId: string; allowed: boolean }>;
  approval?: { threadId: string; id: string; canAllow: boolean };
  pauseCursor?: string;
  decision?: Promise<void>;
  releasePause?: () => void;
  cancellation?: Promise<void>;
  finished?: Promise<void>;
  terminal: boolean;
}

export class StudioSession {
  state: StudioState = {
    connection: { status: 'checking', detail: 'Checking the local TrueForge server.', models: [] },
    phase: 'idle', messages: [], activity: [],
  };

  readonly #listeners = new Set<() => void>();
  #check?: AbortController;
  #active?: Run;
  #disposed = false;
  #nextRun = 0;

  constructor(private readonly dependencies: Dependencies) {}

  listen(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #set(update: Partial<StudioState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.#listeners) listener();
  }

  #activity(label: string, detail?: string) {
    this.#set({ activity: [...this.state.activity.slice(-39), { label, detail }] });
  }

  async refresh() {
    if (this.#disposed) return;
    this.#check?.abort();
    const check = new AbortController();
    this.#check = check;
    const settings = this.dependencies.settings();
    const previousModel = this.state.connection.selectedModel;
    this.#set({ connection: { status: 'checking', detail: 'Checking the local TrueForge server.', models: [] } });
    try {
      const { version, models } = await this.dependencies.forge(settings.serverUrl).check(check.signal);
      if (check.signal.aborted) return;
      const selectedModel = models.find((name) => name === settings.model)
        ?? models.find((name) => name === previousModel)
        ?? (models.length === 1 ? models[0] : undefined);
      const agentName = !settings.workspaceOverview && settings.agentName ? settings.agentName : undefined;
      this.#set({ connection: {
        status: 'connected', version, models, selectedModel, agentName,
        detail: settings.model && !models.includes(settings.model) && !agentName
          ? 'The configured model is unavailable. Select a model from TrueForge.'
          : 'Local TrueForge is reachable.',
      } });
    } catch (error) {
      if (!check.signal.aborted) this.#set({ connection: { status: 'offline', detail: safeError(error), models: [] } });
    } finally {
      if (this.#check === check) this.#check = undefined;
    }
  }

  selectModel(model: string) {
    if (!this.#active && this.state.connection.models.includes(model)) {
      this.#set({ connection: { ...this.state.connection, selectedModel: model } });
    }
  }

  clear() {
    if (!this.#active) this.#set({ messages: [], activity: [], phase: 'idle', sessionId: undefined, error: undefined });
  }

  submit(prompt: string): Promise<void> {
    if (this.#disposed || this.#active || isBusy(this.state.phase)) return Promise.resolve();
    const connection = this.state.connection;
    if (connection.status !== 'connected' || (!connection.selectedModel && !connection.agentName)) return Promise.resolve();
    const settings = this.dependencies.settings();
    let forge: Forge;
    try {
      forge = this.dependencies.forge(settings.serverUrl);
    } catch (error) {
      this.#set({ phase: 'failed', error: safeError(error) });
      return Promise.resolve();
    }
    const run: Run = { id: ++this.#nextRun, forge, abort: new AbortController(), calls: new Map(), terminal: false };
    this.#active = run;
    this.#set({
      phase: 'starting', activity: [], sessionId: undefined, error: undefined,
      messages: [...this.state.messages.slice(-39), { id: `user-${run.id}`, role: 'user', text: prompt }],
    });
    run.finished = this.#execute(run, prompt, settings, connection.selectedModel);
    return run.finished;
  }

  async #execute(run: Run, prompt: string, settings: Settings, model?: string) {
    const signal = run.abort.signal;
    try {
      if (settings.workspaceOverview) {
        run.bridge = await this.dependencies.bridge(signal);
        if (run.bridge) {
          try {
            await run.forge.register(run.bridge, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            throw new VantaError('TrueForge could not register the workspace tool. Check Connectors or disable Workspace Overview for chat.');
          }
        } else {
          this.#activity('Workspace tool unavailable', 'Open one trusted local folder to enable the overview.');
        }
      }
      signal.throwIfAborted();
      const agent = !settings.workspaceOverview && settings.agentName
        ? { name: settings.agentName }
        : inlineAgent(model ?? '', run.bridge?.name);
      // Obtain the session ID even if Stop arrives during creation, so it can be reconciled.
      run.sessionId = await run.forge.createSession(agent, AbortSignal.timeout(8000));
      signal.throwIfAborted();
      this.#set({ sessionId: run.sessionId });
      this.#activity('Session started');
      await this.#consume(run, run.forge.start(run.sessionId, prompt, signal));
      if (!run.terminal && run.pauseCursor && run.turnId && run.releasePause) {
        // The initial stream can end at a pause. Subscribe from the pause event
        // after the decision, which includes responses produced before reconnect.
        while (!run.terminal && run.pauseCursor && run.turnId) {
          const cursor = run.pauseCursor;
          await run.decision;
          signal.throwIfAborted();
          run.pauseCursor = undefined;
          await this.#consume(run, run.forge.resume(run.sessionId, run.turnId, cursor, signal));
        }
      }
      if (!run.terminal && !signal.aborted) throw new VantaError('The TrueForge stream ended before the turn completed. Check the session in TrueForge.');
    } catch (error) {
      if (!signal.aborted && !run.terminal) {
        this.#set({ phase: 'failed', error: safeError(error), approval: undefined });
        this.#activity('Failed');
      }
    } finally {
      run.releasePause?.();
      if (!run.terminal && run.sessionId) await this.#cancelRemote(run);
      if (run.bridge) {
        await run.bridge.close();
        try {
          await run.forge.remove(run.bridge.name);
        } catch {
          this.#activity('Connector cleanup incomplete', 'Its local listener is closed. You can remove the inactive VANTA connector in TrueForge.');
        }
      }
      this.#active = undefined;
      if (signal.aborted && this.state.phase === 'cancelling') {
        this.#set({ phase: 'cancelled' });
        this.#activity('Cancelled');
      } else {
        this.#set({});
      }
    }
  }

  async #consume(run: Run, stream: AsyncIterable<Event>) {
    for await (const event of stream) {
      if (run.abort.signal.aborted || run.terminal) break;
      this.#map(run, event);
    }
  }

  #map(run: Run, event: Event) {
    switch (event.type) {
      case 'turn.created':
        run.turnId = event.turnId;
        this.#set({ phase: 'streaming' });
        this.#activity('Model generating');
        break;
      case 'model.message': {
        if (event.threadId !== 'main') break;
        const content = typeof event.content === 'string' ? event.content
          : event.content?.map((part) => part.type === 'text' ? part.text : '').join('');
        if (content) this.#text(run, event.id, content, false);
        this.#rememberCalls(run, event.id, event.toolCalls ?? []);
        break;
      }
      case 'model.message.delta':
        if (event.threadId === 'main' && event.content) this.#text(run, event.id, event.content, true);
        this.#rememberCalls(run, event.id, event.toolCalls ?? []);
        break;
      case 'tool.approval_required': {
        const call = event.toolCalls[0];
        if (!call || event.toolCalls.length !== 1 || run.approval) {
          throw new VantaError('TrueForge requested multiple or overlapping approvals. This version of VANTA supports one workspace call at a time.');
        }
        const source = run.calls.get(call.id);
        const canAllow = source?.allowed === true && source.sourceId === call.sourceEventId;
        run.approval = { id: call.id, threadId: event.threadId, canAllow };
        run.pauseCursor = event.id;
        run.decision = new Promise((resolve) => { run.releasePause = resolve; });
        this.#set({ phase: 'approval', approval: {
          id: call.id, canAllow, label: canAllow ? 'Read workspace overview' : 'Unrecognized tool request',
          detail: canAllow ? 'Share the workspace name and up to 100 top-level file and folder names with TrueForge and its model.'
            : 'VANTA could not verify this tool. Reject it or stop the run.',
        } });
        this.#activity('Waiting for approval');
        break;
      }
      case 'turn.update':
        if (event.state.status === 'paused' && run.pauseCursor) run.pauseCursor = event.id;
        if (event.state.status === 'running') {
          run.pauseCursor = undefined;
          this.#set({ phase: 'streaming' });
        }
        break;
      case 'tool.response':
        this.#activity('Tool returned', run.calls.get(event.toolCallId)?.name);
        break;
      case 'tool.response_required':
      case 'mcp.auth_required':
        throw new VantaError('This agent requested an interactive action that VANTA does not support. Open the session in TrueForge.');
      case 'turn.done':
        run.terminal = true;
        run.approval = undefined;
        this.#set({ approval: undefined });
        if (event.state.status === 'done') {
          this.#set({ phase: 'completed' });
          this.#activity('Completed');
        } else if (event.state.status === 'cancelled') {
          this.#set({ phase: 'cancelled' });
          this.#activity('Cancelled');
        } else {
          this.#set({ phase: 'failed', error: 'The TrueForge agent reported a failure. Check the session and model configuration in TrueForge.' });
          this.#activity('Failed');
        }
        break;
    }
  }

  #rememberCalls(run: Run, sourceId: string, calls: (Api.ToolCall | Api.ExtendedChunkDeltaToolCall)[]) {
    for (const call of calls) {
      const info = call.toolInfo;
      if (!call.id || !info || run.calls.has(call.id)) continue;
      const allowed = info.type === 'mcp' && !!run.bridge && info.serverName === run.bridge.name && info.name === overviewToolName;
      const name = allowed ? overviewToolName : 'TrueForge tool';
      run.calls.set(call.id, { name, sourceId, allowed });
      this.#activity('Tool requested', name);
    }
  }

  #text(run: Run, eventId: string, content: string, append: boolean) {
    const id = `assistant-${run.id}-${eventId}`;
    const messages = this.state.messages.slice();
    const index = messages.findIndex((message) => message.id === id);
    const previous = index < 0 || !append ? '' : messages[index]?.text ?? '';
    const message = { id, role: 'assistant' as const, text: (previous + content).slice(0, 64_000) };
    if (index < 0) messages.push(message);
    else messages[index] = message;
    this.#set({ messages: messages.slice(-40) });
  }

  async decide(id: string, allow: boolean) {
    const run = this.#active;
    const approval = run?.approval;
    if (!run?.sessionId || !run.turnId || !approval || id !== approval.id || (allow && !approval.canAllow) || run.abort.signal.aborted) return;
    run.approval = undefined;
    this.#set({ approval: undefined, phase: 'streaming' });
    if (allow) run.bridge?.grant();
    try {
      await run.forge.approve(run.sessionId, run.turnId, {
        type: 'user.tool_approval', threadId: approval.threadId, toolCallId: approval.id,
        approval: allow ? { status: 'allow' } : { status: 'deny', reason: 'The user declined to share workspace metadata.' },
      }, run.abort.signal);
      if (!run.abort.signal.aborted) this.#activity(allow ? 'Approved workspace overview' : 'Rejected workspace overview');
    } catch {
      run.bridge?.revoke();
      if (!run.abort.signal.aborted && !run.terminal) {
        this.#set({ error: 'TrueForge did not confirm the approval decision. The run was stopped to avoid replaying it.' });
        await this.cancel();
      }
    } finally {
      run.releasePause?.();
    }
  }

  #cancelRemote(run: Run) {
    const sessionId = run.sessionId;
    if (!sessionId) return Promise.resolve();
    run.cancellation ??= run.forge.cancel(sessionId).catch(() => {
      this.#set({ error: 'Local work stopped. TrueForge did not confirm cancellation. Check the session in TrueForge.' });
    });
    return run.cancellation;
  }

  async cancel() {
    const run = this.#active;
    if (!run || run.abort.signal.aborted || run.terminal) return;
    this.#set({ phase: 'cancelling', approval: undefined });
    run.approval = undefined;
    run.bridge?.revoke();
    run.abort.abort();
    run.releasePause?.();
    await this.#cancelRemote(run);
  }

  async dispose() {
    this.#disposed = true;
    this.#check?.abort();
    this.#listeners.clear();
    const finished = this.#active?.finished;
    await this.cancel();
    await finished;
  }
}
