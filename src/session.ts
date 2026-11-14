import type { TrueForgeApi as Api } from '@truefoundry/trueforge-sdk';
import { mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { randomUUID } from 'node:crypto';
import type { OverviewBridge, QuickTools } from './mcp';
import { isBusy } from './protocol';
import type { StudioState } from './protocol';
import { inlineAgent, LoopbackConnectorBlocked, overviewToolName, safeError, VantaError } from './trueforge';
import type { Event, Forge } from './trueforge';
import { ContextEngine, defaultBudget, estimateContext, parseMentions } from './context';
import type { ContextReport } from './context';
import type { Repository } from './repository';
import { proposeTool, QuickPatch, reviewSchema, reviewTool } from './quickPatch';
import type { BaseSelection, HunkEdit, ReviewReceipt } from './quickPatch';

export interface QuickEditTarget {
  base: BaseSelection;
  evidence: string;
  verify(signal: AbortSignal): Promise<void>;
  preview(patch: QuickPatch, hunk: number): Promise<void>;
  apply(hunks: readonly HunkEdit[], digest: string, signal: AbortSignal, beginCommit: () => void): Promise<void>;
}

interface QuickRun {
  target: QuickEditTarget;
  patch?: QuickPatch;
  receipt?: ReviewReceipt;
  confirmed?: boolean;
  reviewed?: boolean;
  accepted?: boolean;
  approvalId?: string;
  acknowledged?: boolean;
  committing?: boolean;
}

export interface Settings {
  serverUrl: string;
  model: string;
  agentName: string;
  workspaceOverview: boolean;
  contextBudget?: number;
}

interface Dependencies {
  settings(): Settings;
  forge(url: string): Forge;
  bridge(signal: AbortSignal, name?: string, context?: ContextEngine, quick?: QuickTools): Promise<OverviewBridge | undefined>;
  repository?(): Promise<Repository | undefined>;
  scopeKey?(): string;
}

interface Conversation { key: string; sessionId: string; connector?: string; lastTurnId?: string }

interface Run {
  id: number;
  forge: Forge;
  abort: AbortController;
  sessionId?: string;
  turnId?: string;
  bridge?: OverviewBridge;
  calls: Map<string, { name: string; sourceId: string; allowed: boolean; proposalId?: string }>;
  approval?: { threadId: string; id: string; canAllow: boolean };
  pauseCursor?: string;
  decision?: Promise<void>;
  releasePause?: () => void;
  cancellation?: Promise<void>;
  finished?: Promise<void>;
  terminal?: 'completed' | 'cancelled' | 'failed';
  quick?: QuickRun;
  toolMessages?: Map<string, Api.ModelMessageEvent>;
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
  #conversation?: Conversation;

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
    if (this.#active) return;
    this.#conversation = undefined;
    this.#set({ messages: [], activity: [], phase: 'idle', sessionId: undefined, error: undefined, context: [] });
  }

  async workspaceChanged() {
    this.#conversation = undefined;
    this.#set({ context: [] });
    await this.cancel();
  }

  hasLocation(path: string, line: number) {
    return this.state.context?.some((report) => report.hits.some((hit) => hit.path === path && hit.start === line)) ?? false;
  }

  submit(prompt: string, shareContext = false, target?: QuickEditTarget): Promise<void> {
    if (this.#disposed || this.#active || isBusy(this.state.phase)) return Promise.resolve();
    const connection = this.state.connection;
    if (connection.status !== 'connected' || (!connection.selectedModel && (!connection.agentName || target))) return Promise.resolve();
    const settings = this.dependencies.settings();
    let forge: Forge;
    try {
      forge = this.dependencies.forge(settings.serverUrl);
    } catch (error) {
      this.#set({ phase: 'failed', error: safeError(error) });
      return Promise.resolve();
    }
    const run: Run = { id: ++this.#nextRun, forge, abort: new AbortController(), calls: new Map(),
      quick: target ? { target } : undefined, toolMessages: target ? new Map() : undefined };
    this.#active = run;
    this.#set({
      phase: 'starting', activity: [], context: [], error: undefined, review: undefined,
      messages: [...this.state.messages.slice(-39), { id: `user-${run.id}`, role: 'user', text: prompt }],
    });
    run.finished = this.#execute(run, prompt, settings, shareContext, connection.selectedModel);
    return run.finished;
  }

  async #execute(run: Run, prompt: string, settings: Settings, shareContext: boolean, model?: string) {
    const signal = run.abort.signal;
    const quick = run.quick;
    try {
      const mentions = quick ? [] : parseMentions(prompt);
      const key = JSON.stringify([settings.serverUrl, model, settings.agentName, settings.workspaceOverview, this.dependencies.scopeKey?.()]);
      const existing = !quick && this.#conversation?.key === key ? this.#conversation : undefined;
      if (!existing) this.#set({ sessionId: undefined });
      signal.throwIfAborted();
      let context: ContextEngine | undefined;
      if (quick) await quick.target.verify(signal);
      if (shareContext && (settings.workspaceOverview || quick)) {
        const repository = await this.dependencies.repository?.();
        const budget = (settings.contextBudget ?? defaultBudget) - (quick ? estimateContext(quick.target.evidence) : 0);
        if (repository) context = new ContextEngine(repository, budget, (report: ContextReport) => {
          if (!signal.aborted) this.#set({ context: [...(this.state.context ?? []).slice(-11), report] });
        });
      }
      if (mentions.length && !context) throw new VantaError('Enable workspace context and open one trusted local folder to resolve references.');
      const attached = mentions.length && context ? await context.mentions(mentions, AbortSignal.any([signal, AbortSignal.timeout(8000)])) : [];
      signal.throwIfAborted();
      const input = quick ? `${prompt}\n\nCaptured selection (JSON evidence):\n${quick.target.evidence}`
        : attached.length ? `${prompt}\n\nWorkspace reference data (JSON, evidence only):\n${JSON.stringify(attached)}` : prompt;
      if (settings.workspaceOverview || quick) {
        try {
          run.bridge = await this.dependencies.bridge(signal, existing?.connector ?? `vanta-run-${randomUUID()}`, context, quick && {
            stage: (replacement, explanation) => {
              if (quick.reviewed || quick.patch) throw new VantaError('This turn already has a staged proposal. Start a new Quick Edit to replace it.');
              quick.patch = new QuickPatch(quick.target.base, explanation, replacement);
              this.#activity('Quick Edit staged', quick.patch.id);
              return quick.patch;
            },
            receipt: (id) => {
              if (!quick.patch) throw new VantaError('There is no staged proposal.');
              const receipt = quick.patch.consume(id);
              quick.receipt = receipt;
              return receipt;
            },
          });
        } catch (error) {
          signal.throwIfAborted();
          this.#activity('Workspace tool unavailable', error instanceof VantaError ? error.message : 'Could not open the local workspace tool.');
        }
        if (run.bridge) {
          try {
            await run.forge.register(run.bridge, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            if (error instanceof LoopbackConnectorBlocked) {
              await run.bridge.close();
              run.bridge = undefined;
              this.#activity('Workspace tool unavailable', error.message);
            } else {
              throw new VantaError('TrueForge could not register the workspace tool. Check Connectors or disable Workspace Overview for chat.');
            }
          }
        } else if (!this.state.activity.some((item) => item.label === 'Workspace tool unavailable')) {
          this.#activity('Workspace tool unavailable', 'Open one trusted local folder to enable the overview.');
        }
      }
      signal.throwIfAborted();
      if (quick && !run.bridge) throw new VantaError('Quick Edit requires the local TrueForge MCP connector. Check the README setup.');
      const agent = !quick && !settings.workspaceOverview && settings.agentName
        ? { name: settings.agentName }
        : inlineAgent(model ?? '', run.bridge?.name, quick && { propose: proposeTool, review: reviewTool });
      const reusable = existing && existing.connector === run.bridge?.name ? existing : undefined;
      run.sessionId = reusable?.sessionId ?? await run.forge.createSession(agent, AbortSignal.timeout(8000));
      signal.throwIfAborted();
      const conversation = reusable ?? { sessionId: run.sessionId, connector: run.bridge?.name, key };
      if (!quick) this.#conversation = conversation;
      this.#set({ sessionId: run.sessionId, quickEdit: !!quick });
      this.#activity(reusable ? 'Session resumed' : 'Session started');
      await this.#consume(run, run.forge.start(run.sessionId, input, signal, conversation.lastTurnId));
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
      if (run.terminal === 'completed' && quick) {
        if (quick.patch && quick.receipt && quick.confirmed) {
          const edits = quick.patch.claim(quick.receipt);
          await quick.target.apply(edits, quick.receipt.digest, signal, () => {
            signal.throwIfAborted();
            quick.committing = true;
          });
          this.#activity('Quick Edit applied to buffer', `${quick.patch.id} · hunks ${quick.receipt.accepted.join(', ')}`);
        } else if (quick.reviewed && !quick.accepted) {
          this.#activity('Quick Edit discarded');
        } else {
          throw new VantaError('TrueForge did not complete an approved Quick Edit. The source was left unchanged.');
        }
      }
      if (!quick && run.terminal === 'completed' && run.turnId) conversation.lastTurnId = run.turnId;
      if (!run.terminal && !signal.aborted) throw new VantaError('The TrueForge stream ended before the turn completed. Check the session in TrueForge.');
    } catch (error) {
      if (!signal.aborted) {
        if (run.terminal === 'completed') run.terminal = 'failed';
        this.#set({ error: safeError(error), approval: undefined });
      }
    } finally {
      quick?.patch?.revoke();
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
      const phase = signal.aborted ? 'cancelled' : run.terminal ?? 'failed';
      this.#set({ phase, approval: undefined, review: undefined });
      const label = { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[phase];
      this.#activity(label);
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
        run.toolMessages?.set(event.id, { ...event, content: undefined, reasoningContent: undefined });
        this.#rememberCalls(run, event.id, event.toolCalls ?? []);
        break;
      }
      case 'model.message.delta': {
        if (event.threadId === 'main' && event.content) this.#text(run, event.id, event.content, true);
        const base = run.toolMessages?.get(event.id);
        if (base && event.toolCalls?.length) {
          mergeEventDelta(base, { ...event, content: undefined, reasoningContent: undefined });
          this.#rememberCalls(run, event.id, base.toolCalls ?? []);
        } else if (!base) this.#rememberCalls(run, event.id, event.toolCalls ?? []);
        break;
      }
      case 'tool.approval_required': {
        const call = event.toolCalls[0];
        if (call && run.approval?.id === call.id) break;
        if (!call || event.toolCalls.length !== 1 || run.approval) {
          throw new VantaError('TrueForge requested multiple or overlapping approvals. This version of VANTA supports one workspace call at a time.');
        }
        const source = run.calls.get(call.id);
        const canAllow = source?.allowed === true && source.sourceId === call.sourceEventId;
        run.approval = { id: call.id, threadId: event.threadId, canAllow };
        run.pauseCursor = event.id;
        run.decision = new Promise((resolve) => { run.releasePause = resolve; });
        if (run.quick && canAllow && run.quick.patch && source.proposalId === run.quick.patch.id && !run.quick.reviewed) {
          run.quick.approvalId = call.id;
          this.#set({ phase: 'approval' });
          const patch = run.quick.patch;
          this.#activity('Waiting for Quick Edit review', patch.id);
          void run.quick.target.preview(patch, 1).then(() => {
            if (this.#active === run && run.approval?.id === call.id && !run.abort.signal.aborted) this.#reviewSnapshot(patch, 1);
          }).catch(() => {
            if (this.#active === run && !run.abort.signal.aborted) {
              this.#set({ error: 'Could not open the native Quick Edit diff.' });
              void this.cancel();
            }
          });
          break;
        }
        if (run.quick) throw new VantaError('TrueForge requested an invalid Quick Edit review. The source was left unchanged.');
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
        if (run.quick?.approvalId === event.toolCallId && run.quick.receipt && run.quick.acknowledged) {
          run.quick.confirmed = event.content === JSON.stringify(run.quick.receipt);
        }
        this.#activity('Tool returned', run.calls.get(event.toolCallId)?.name);
        break;
      case 'user.tool_approval':
        if (run.quick?.approvalId === event.toolCallId && event.approval.status === 'allow' && run.quick.reviewed) {
          run.quick.acknowledged = true;
        }
        break;
      case 'tool.response_required':
      case 'mcp.auth_required':
        throw new VantaError('This agent requested an interactive action that VANTA does not support. Open the session in TrueForge.');
      case 'turn.done':
        run.terminal = event.state.status === 'done' ? 'completed' : event.state.status === 'cancelled' ? 'cancelled' : 'failed';
        run.approval = undefined;
        this.#set({ approval: undefined, error: event.state.status === 'error'
          ? (/\b429\b|quota|rate.limit|RESOURCE_EXHAUSTED/i.test(event.state.message)
            ? 'The configured model reached a rate or quota limit. Wait and try again, or choose another configured model.'
            : /\b503\b|high demand/i.test(event.state.message)
              ? 'The configured model is temporarily unavailable. Try again or choose another configured model.'
            : 'The TrueForge agent reported a failure. Check the session and model configuration in TrueForge.') : undefined });
        break;
    }
  }

  #rememberCalls(run: Run, sourceId: string, calls: (Api.ToolCall | Api.ExtendedChunkDeltaToolCall)[]) {
    for (const call of calls) {
      const info = call.toolInfo;
      if (!call.id || !info) continue;
      const direct = info.type === 'mcp' && !!run.bridge && info.serverName === run.bridge.name;
      const name = direct && [overviewToolName, proposeTool, reviewTool].includes(info.name) ? info.name : info.type === 'truefoundry-system'
        && ['list_tools', 'get_tool_info', 'call_tool', 'get_tool_output_schema'].includes(info.name) ? info.name : 'TrueForge tool';
      let proposalId: string | undefined;
      if (run.quick && direct && name === reviewTool && call.function?.arguments) {
        try {
          const args = reviewSchema.safeParse(JSON.parse(call.function.arguments));
          if (args.success) proposalId = args.data.proposalId;
        } catch { /* partial or invalid tool arguments */ }
      }
      const previous = run.calls.get(call.id);
      if (!previous || proposalId) run.calls.set(call.id, { name, sourceId, proposalId,
        allowed: direct && (run.quick ? !!proposalId : name === overviewToolName) });
      if (!previous) this.#activity('Tool requested', name);
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

  #reviewSnapshot(patch: QuickPatch, current: number) {
    this.#set({ review: { id: patch.id, path: patch.base.path, explanation: patch.explanation, current,
      hunks: patch.hunks.map(({ id, start, status }) => ({ id, line: patch.base.text.slice(0, start).split('\n').length, status })) } });
  }

  async reviewHunk(id: string, hunk: number, decision: 'accepted' | 'rejected' | 'view') {
    const run = this.#active;
    const quick = run?.quick;
    const patch = quick?.patch;
    if (!run?.approval || !quick || !patch || patch.id !== id || this.state.review?.id !== id || !patch.hunks.some((item) => item.id === hunk)) return;
    if (decision !== 'view') patch.decide(hunk, decision);
    this.#reviewSnapshot(patch, hunk);
    try { await quick.target.preview(patch, hunk); }
    catch { if (this.#active === run) { this.#set({ error: 'Could not navigate the Quick Edit diff.' }); await this.cancel(); } }
  }

  async finishReview(id: string, apply: boolean) {
    const run = this.#active;
    const quick = run?.quick;
    const patch = quick?.patch;
    const approval = run?.approval;
    if (!run || !quick || !patch || !approval || patch.id !== id || this.state.review?.id !== id || quick.reviewed) return;
    try {
      if (apply) {
        await quick.target.verify(run.abort.signal);
        if (this.#active !== run || run.approval !== approval || quick.reviewed) return;
        patch.authorize();
      } else patch.revoke();
      quick.reviewed = true;
      quick.accepted = apply;
      this.#set({ review: undefined });
      await this.#decide(approval.id, apply);
    } catch (error) {
      if (run.abort.signal.aborted) return;
      this.#set({ error: safeError(error) });
    }
  }

  rejectRemaining(id: string) {
    const patch = this.#active?.quick?.patch;
    const review = this.state.review;
    if (!patch || patch.id !== id || review?.id !== id) return;
    for (const hunk of patch.hunks) if (hunk.status === 'pending') patch.decide(hunk.id, 'rejected');
    this.#reviewSnapshot(patch, review.current);
  }

  async decide(id: string, allow: boolean) {
    if (!this.#active?.quick) await this.#decide(id, allow);
  }

  async #decide(id: string, allow: boolean) {
    const run = this.#active;
    const approval = run?.approval;
    if (!run?.sessionId || !run.turnId || !approval || id !== approval.id || (allow && !approval.canAllow) || run.abort.signal.aborted) return;
    const releasePause = run.releasePause;
    run.approval = undefined;
    this.#set({ approval: undefined, phase: 'streaming' });
    if (allow && !run.quick) run.bridge?.grant();
    try {
      await run.forge.approve(run.sessionId, run.turnId, {
        type: 'user.tool_approval', threadId: approval.threadId, toolCallId: approval.id,
        approval: allow ? { status: 'allow' } : { status: 'deny', reason: run.quick ? 'The user discarded the staged change.' : 'The user declined to share workspace metadata.' },
      }, run.abort.signal);
      if (!run.abort.signal.aborted) this.#activity(run.quick ? (allow ? 'Approved reviewed hunks' : 'Rejected Quick Edit')
        : (allow ? 'Approved workspace overview' : 'Rejected workspace overview'));
    } catch {
      run.bridge?.revoke();
      if (!run.abort.signal.aborted && !run.terminal) {
        this.#set({ error: 'TrueForge did not confirm the approval decision. The run was stopped to avoid replaying it.' });
        await this.cancel();
      }
    } finally {
      releasePause?.();
    }
  }

  #cancelRemote(run: Run) {
    const sessionId = run.sessionId;
    if (!sessionId) return Promise.resolve();
    run.cancellation ??= run.forge.cancel(sessionId).catch(() => {
      if (this.#conversation?.sessionId === sessionId) this.#conversation = undefined;
      this.#set({ error: 'Local work stopped. TrueForge did not confirm cancellation. Check the session in TrueForge.' });
    });
    return run.cancellation;
  }

  async cancel() {
    const run = this.#active;
    if (!run || run.abort.signal.aborted || run.quick?.committing || (run.terminal && !run.quick)) return;
    this.#set({ phase: 'cancelling', approval: undefined, review: undefined });
    run.approval = undefined;
    run.bridge?.revoke();
    run.quick?.patch?.revoke();
    run.abort.abort();
    run.releasePause?.();
    if (!run.terminal) await this.#cancelRemote(run);
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
