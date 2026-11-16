import type { TrueForgeApi as Api } from '@truefoundry/trueforge-sdk';
import { mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { randomUUID } from 'node:crypto';
import type { AgentTools, OverviewBridge, QuickTools } from './mcp';
import { isBusy } from './protocol';
import type { StudioState } from './protocol';
import { agentModeDefinition, inlineAgent, LoopbackConnectorBlocked, modelFailure, overviewToolName, safeError, safeTurnError, VantaError } from './trueforge';
import type { Event, Forge, ModelFailure } from './trueforge';
import { ContextEngine, defaultBudget, estimateContext, parseMentions } from './context';
import type { ContextReport } from './context';
import type { Repository } from './repository';
import { proposeTool, QuickPatch, reviewSchema, reviewTool } from './quickPatch';
import type { BaseSelection, HunkEdit, ReviewReceipt } from './quickPatch';
import { fingerprint } from './quickPatch';
import { AgentPatch, reviewAgentSchema, reviewAgentTool, stageAgentTool, verifyAgentSchema, verifyAgentTool } from './agentPatch';
import type { AgentReceipt, ReviewReference } from './agentPatch';
import type { AgentWorkspace } from './agentWorkspace';
import { pytestCommand, runPytest, verificationPython, verificationTarget } from './verification';

interface Gate {
  id: string;
  acknowledged?: boolean;
  confirmed?: boolean;
}

interface AgentRun {
  workspace: AgentWorkspace;
  scope: string;
  python: string;
  patch: AgentPatch;
  discovered: Set<string>;
  staging: number;
  denied?: boolean;
  committing?: boolean;
  review?: Gate;
  receipt?: AgentReceipt;
  verification?: Gate & { target: string; grant?: string; result?: { digest: string; status: string; exitCode: number | null } };
  checking?: { promise: Promise<unknown>; stop: AbortController };
}

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
  secondaryModel?: string;
  agentName: string;
  workspaceOverview: boolean;
  contextBudget?: number;
  verificationPython?: string;
}

interface Dependencies {
  settings(): Settings;
  forge(url: string): Forge;
  bridge(signal: AbortSignal, name?: string, context?: ContextEngine, quick?: QuickTools, agent?: AgentTools): Promise<OverviewBridge | undefined>;
  repository?(): Promise<Repository | undefined>;
  scopeKey?(): string;
  agentWorkspace?(): Promise<AgentWorkspace | undefined>;
  streamIdleMs?: number;
}

interface Conversation { key: string; sessionId: string; connector?: string; lastTurnId?: string }

interface Run {
  id: number;
  forge: Forge;
  abort: AbortController;
  sessionId?: string;
  turnId?: string;
  bridge?: OverviewBridge;
  calls: Map<string, { name: string; sourceId: string; allowed: boolean; proposalId?: string; reference?: ReviewReference; target?: string }>;
  approval?: { threadId: string; id: string; canAllow: boolean; name?: string };
  decided?: Set<string>;
  pauseCursor?: string;
  decision?: Promise<void>;
  releasePause?: () => void;
  cancellation?: Promise<void>;
  finished?: Promise<void>;
  terminal?: 'completed' | 'cancelled' | 'failed';
  providerFailure?: ModelFailure;
  modelActive?: boolean;
  reused?: boolean;
  cursor?: string;
  cursorIsModel?: boolean;
  reconnected?: boolean;
  retired?: boolean;
  bridgeClosed?: boolean;
  quick?: QuickRun;
  agent?: AgentRun;
  toolMessages?: Map<string, Api.ModelMessageEvent>;
}

// Bound an individual stream read even if the transport does not settle on abort.
async function readEvent(iterator: AsyncIterator<Event>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    }), iterator.next()]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
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
  #modelOverride?: { model: string; serverUrl: string; configuredModel: string };
  #undo?: () => Promise<void>;
  #undoing = false;

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
    this.#set({ connection: { status: 'checking', detail: 'Checking the local TrueForge server.', models: [] } });
    try {
      const { version, models } = await this.dependencies.forge(settings.serverUrl).check(check.signal);
      if (check.signal.aborted) return;
      const configuredMissing = !!settings.model && !models.includes(settings.model);
      const override = this.#modelOverride;
      if (override && (override.serverUrl !== settings.serverUrl || override.configuredModel !== settings.model || !models.includes(override.model))) {
        this.#modelOverride = undefined;
      }
      const selectedModel = this.#modelOverride?.model
        ?? models.find((name) => name === settings.model)
        ?? (!configuredMissing && models.length === 1 ? models[0] : undefined);
      const agentName = !settings.workspaceOverview && settings.agentName ? settings.agentName : undefined;
      const attention = !agentName && (configuredMissing || models.length === 0);
      this.#set({ connection: {
        status: 'connected', version, models, selectedModel, agentName, attention,
        detail: !agentName && models.length === 0 ? 'No models are configured. Add a model in TrueForge, then select Refresh.'
          : !agentName && configuredMissing ? 'The configured model is unavailable. Select another model below the VANTA title, or configure it in TrueForge and select Refresh.'
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
      const { serverUrl, model: configuredModel } = this.dependencies.settings();
      this.#modelOverride = { model, serverUrl, configuredModel };
      if (model !== this.state.connection.selectedModel) this.#conversation = undefined;
      this.#set({ connection: { ...this.state.connection, selectedModel: model } });
    }
  }

  clear() {
    if (this.#active) return;
    this.#conversation = undefined;
    this.#set({ messages: [], activity: [], phase: 'idle', sessionId: undefined, error: undefined, retry: undefined, context: [] });
  }

  async workspaceChanged() {
    this.#conversation = undefined;
    this.#undo = undefined;
    this.#set({ context: [], changes: undefined, retry: undefined });
    await this.cancel();
  }

  hasLocation(path: string, line: number) {
    return this.state.context?.some((report) => report.hits.some((hit) => hit.path === path && hit.start === line)) ?? false;
  }

  submit(prompt: string, shareContext = false, target?: QuickEditTarget, agentMode = false): Promise<void> {
    if (this.#disposed || this.#active || this.#undoing || isBusy(this.state.phase)) return Promise.resolve();
    const connection = this.state.connection;
    if (connection.status !== 'connected' || (!connection.selectedModel && (!connection.agentName || target || agentMode))) return Promise.resolve();
    const settings = this.dependencies.settings();
    let forge: Forge;
    try {
      forge = this.dependencies.forge(settings.serverUrl);
    } catch (error) {
      this.#set({ phase: 'failed', error: safeError(error) });
      return Promise.resolve();
    }
    const run = this.#newRun(forge, target, agentMode);
    this.#active = run;
    this.#set({
      phase: 'starting', activity: [], context: [], error: undefined, review: undefined, retry: undefined,
      quickEdit: !!target, agentMode: agentMode && !target, verification: agentMode ? undefined : this.state.verification,
      messages: [...this.state.messages.slice(-39), { id: `user-${run.id}`, role: 'user', text: prompt }],
    });
    run.finished = this.#runWithFallback(run, prompt, settings, shareContext, connection.selectedModel, agentMode && !target);
    return run.finished;
  }

  #newRun(forge: Forge, target: QuickEditTarget | undefined, agentMode: boolean): Run {
    return { id: ++this.#nextRun, forge, abort: new AbortController(), calls: new Map(),
      quick: target ? { target } : undefined, toolMessages: target || agentMode ? new Map() : undefined };
  }

  async #runWithFallback(run: Run, prompt: string, settings: Settings, shareContext: boolean, model: string | undefined, agentMode: boolean) {
    await this.#execute(run, prompt, settings, shareContext, model, agentMode);
    const secondary = settings.secondaryModel;
    const failure = run.providerFailure;
    if (secondary && secondary !== model && this.state.connection.models.includes(secondary) && model && failure && failure.kind !== 'other'
      && !run.modelActive && !run.reused && (!run.bridge || run.bridgeClosed)
      && (run.quick || agentMode || settings.workspaceOverview || !settings.agentName) && !run.abort.signal.aborted && !this.#disposed) {
      const fallback = this.#newRun(run.forge, run.quick?.target, agentMode);
      fallback.finished = run.finished;
      this.#active = fallback;
      run = fallback;
      this.#activity('Primary model failed', failure.detail);
      this.#set({ phase: 'starting', error: undefined, sessionId: undefined, context: [], activeModel: secondary });
      this.#activity('Using configured secondary model', secondary);
      await this.#execute(run, prompt, settings, shareContext, secondary, agentMode);
    }
    const phase = run.abort.signal.aborted ? 'cancelled' : run.terminal ?? 'failed';
    this.#active = undefined;
    this.#set({ phase, approval: undefined, review: undefined, activeModel: undefined,
      retry: phase === 'failed' && !run.quick ? { prompt, shareContext, agentMode } : undefined });
    const label = { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[phase];
    this.#activity(label);
  }

  async #execute(run: Run, prompt: string, settings: Settings, shareContext: boolean, model: string | undefined, agentMode: boolean) {
    const signal = run.abort.signal;
    const quick = run.quick;
    const namedAgent = !quick && !agentMode && !settings.workspaceOverview ? settings.agentName : '';
    this.#set({ activeModel: namedAgent ? undefined : model });
    try {
      const mentions = quick ? [] : parseMentions(prompt);
      const key = JSON.stringify([settings.serverUrl, model, settings.agentName, settings.workspaceOverview, this.dependencies.scopeKey?.()]);
      const existing = !quick && !agentMode && this.#conversation?.key === key ? this.#conversation : undefined;
      if (!existing) this.#set({ sessionId: undefined });
      signal.throwIfAborted();
      let context: ContextEngine | undefined;
      if (quick) await quick.target.verify(signal);
      if (agentMode) {
        const workspace = shareContext ? await this.dependencies.agentWorkspace?.() : undefined;
        const scope = this.dependencies.scopeKey?.();
        if (!workspace || !scope) throw new VantaError('Agent Mode requires workspace context and a single trusted local folder.');
        const python = await verificationPython(settings.verificationPython ?? '')
          .catch((error: unknown) => { throw error instanceof VantaError ? error : new VantaError('Could not open the configured Python interpreter.'); });
        run.agent = { workspace, python, scope, patch: new AgentPatch(), discovered: new Set(), staging: 0 };
      }
      const editing = run.agent;
      if (shareContext && (settings.workspaceOverview || quick || editing)) {
        const repository = editing?.workspace.repository ?? await this.dependencies.repository?.();
        const budget = (settings.contextBudget ?? defaultBudget) - (quick ? estimateContext(quick.target.evidence) : 0);
        if (repository) context = new ContextEngine(repository, budget, (report: ContextReport) => {
          for (const hit of report.hits) if (hit.selected) editing?.discovered.add(hit.path);
          if (!signal.aborted) this.#set({ context: [...(this.state.context ?? []).slice(-11), report] });
        }, !!editing);
      }
      if (mentions.length && !context) throw new VantaError('Enable workspace context and open one trusted local folder to resolve references.');
      const attached = mentions.length && context ? await context.mentions(mentions, AbortSignal.any([signal, AbortSignal.timeout(8000)])) : [];
      signal.throwIfAborted();
      const input = quick ? `${prompt}\n\nCaptured selection (JSON evidence):\n${quick.target.evidence}`
        : attached.length ? `${prompt}\n\nWorkspace reference data (JSON, evidence only):\n${JSON.stringify(attached)}` : prompt;
      if (settings.workspaceOverview || quick || editing) {
        try {
          run.bridge = await this.dependencies.bridge(signal, existing?.connector ?? `vanta-run-${randomUUID()}`, context, quick && {
            stage: (replacement, explanation) => {
              signal.throwIfAborted();
              if (run.terminal || run.retired) throw new VantaError('This Quick Edit has ended.');
              run.modelActive = true;
              if (quick.reviewed || quick.patch) throw new VantaError('This turn already has a staged proposal. Start a new Quick Edit to replace it.');
              quick.patch = new QuickPatch(quick.target.base, explanation, replacement);
              this.#activity('Quick Edit staged', quick.patch.id);
              return quick.patch;
            },
            receipt: (id) => {
              signal.throwIfAborted();
              if (!quick.patch) throw new VantaError('There is no staged proposal.');
              const receipt = quick.patch.consume(id);
              quick.receipt = receipt;
              return receipt;
            },
          }, editing && this.#agentTools(run, editing));
        } catch (error) {
          signal.throwIfAborted();
          this.#activity('Workspace tool unavailable', error instanceof VantaError ? error.message : 'Could not open the local workspace tool.');
        }
        if (run.bridge) {
          try {
            await run.forge.register(run.bridge, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
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
      if (editing && !run.bridge) throw new VantaError('Agent Mode requires the local TrueForge MCP connector. Check the README setup.');
      const agent = editing && run.bridge ? agentModeDefinition(model ?? '', run.bridge.name, { stage: stageAgentTool, review: reviewAgentTool, verify: verifyAgentTool })
        : namedAgent
        ? { name: namedAgent }
        : inlineAgent(model ?? '', run.bridge?.name, quick && { propose: proposeTool, review: reviewTool });
      const reusable = existing && existing.connector === run.bridge?.name ? existing : undefined;
      run.reused = !!reusable;
      run.sessionId = reusable?.sessionId ?? await run.forge.createSession(agent, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
      signal.throwIfAborted();
      const conversation = reusable ?? { sessionId: run.sessionId, connector: run.bridge?.name, key };
      if (!quick && !editing) this.#conversation = conversation;
      this.#set({ sessionId: run.sessionId, quickEdit: !!quick, agentMode: !!editing });
      this.#activity(reusable ? 'Session resumed' : 'Session started');
      const sessionId = run.sessionId;
      await this.#consume(run, (streamSignal) => run.forge.start(sessionId, input, streamSignal, conversation.lastTurnId));
      if (!run.terminal && run.pauseCursor && run.turnId && run.releasePause) {
        // The initial stream can end at a pause. Subscribe from the pause event
        // after the decision, which includes responses produced before reconnect.
        while (!run.terminal && run.pauseCursor && run.turnId) {
          const cursor = run.pauseCursor;
          await run.decision;
          signal.throwIfAborted();
          run.pauseCursor = undefined;
          const turnId = run.turnId;
          await this.#consume(run, (streamSignal) => run.forge.resume(sessionId, turnId, cursor, streamSignal));
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
      if (run.terminal === 'completed' && editing) {
        if (editing.denied) this.#activity('Agent changes discarded');
        else if (!editing.receipt || !editing.review?.confirmed || !editing.verification?.confirmed || editing.verification.result?.status !== 'passed') {
          throw new VantaError('Agent Mode requires reviewed hunks, a passing verification receipt and a completed TrueForge turn.');
        } else {
          const files = editing.patch.approved(editing.receipt);
          this.#undo = await editing.workspace.apply(files, signal, () => {
            signal.throwIfAborted();
            editing.committing = true;
          });
          if (this.dependencies.scopeKey?.() === editing.scope) {
            this.#set({ changes: { paths: files.map(({ base }) => base.path), status: 'applied' } });
          } else this.#undo = undefined;
          this.#activity('Agent changes applied to buffers', files.map(({ base }) => base.path).join(', '));
        }
      }
      if (!quick && !editing && run.terminal === 'completed' && run.turnId) conversation.lastTurnId = run.turnId;
      if (!run.terminal && !signal.aborted) throw new VantaError('The TrueForge stream ended before the turn completed. Check the session in TrueForge before retrying.');
    } catch (error) {
      if (!signal.aborted) {
        if (run.terminal === 'completed') run.terminal = 'failed';
        this.#set({ error: safeTurnError(error), approval: undefined, review: undefined });
      }
    } finally {
      run.retired = true;
      run.approval = undefined;
      quick?.patch?.revoke();
      run.agent?.patch.close();
      if (run.terminal !== 'completed' && this.#conversation?.sessionId === run.sessionId) this.#conversation = undefined;
      if (run.terminal !== 'completed' && !signal.aborted) run.bridge?.revoke();
      run.releasePause?.();
      run.agent?.checking?.stop.abort();
      await run.agent?.checking?.promise.catch(() => undefined);
      if (!run.terminal && run.sessionId) await this.#cancelRemote(run);
      if (run.bridge) {
        try {
          await run.bridge.close();
          run.bridgeClosed = true;
          await run.forge.remove(run.bridge.name);
        } catch {
          this.#activity('Connector cleanup incomplete', 'Check the connector in TrueForge.');
        }
      }
    }
  }

  async #consume(run: Run, open: (signal: AbortSignal) => AsyncIterable<Event>) {
    await this.#readStream(run, open);
    const { sessionId, turnId, cursor } = run;
    if (!run.terminal && !run.abort.signal.aborted && !run.pauseCursor && !run.reconnected && sessionId && turnId && cursor) {
      run.reconnected = true;
      this.#activity('Reconnecting to the existing turn');
      await this.#readStream(run, (signal) => run.forge.resume(sessionId, turnId, cursor, signal, run.cursorIsModel));
    }
  }

  async #readStream(run: Run, open: (signal: AbortSignal) => AsyncIterable<Event>) {
    const transport = new AbortController();
    const signal = AbortSignal.any([run.abort.signal, transport.signal]);
    const iterator = open(signal)[Symbol.asyncIterator]();
    try {
      while (!signal.aborted && !run.terminal) {
        const idle = AbortSignal.timeout(this.dependencies.streamIdleMs ?? 120_000);
        let next: IteratorResult<Event>;
        try {
          next = await readEvent(iterator, AbortSignal.any([signal, idle]));
        } catch (error) {
          if (signal.aborted) return;
          if (idle.aborted) {
            if (run.pauseCursor) return;
            throw new VantaError('TrueForge stopped sending updates. The run timed out. Check the model or select another one before retrying.');
          }
          // Only resume a known turn. Never resubmit an ambiguous POST.
          if (run.cursor && !run.reconnected && !(error instanceof VantaError)) return;
          throw error;
        }
        if (next.done || signal.aborted) return;
        const event = next.value;
        this.#map(run, event);
        if (event.type !== 'model.message.delta') {
          run.cursor = event.id;
          run.cursorIsModel = event.type === 'model.message';
        }
        if (event.type === 'turn.update' && event.state.status === 'paused' && run.pauseCursor) return;
      }
    } finally {
      transport.abort();
      void iterator.return?.().catch(() => undefined);
    }
  }

  #agentTools(run: Run, agent: AgentRun): AgentTools {
    const signal = run.abort.signal;
    return {
      stage: async (proposal) => {
        signal.throwIfAborted();
        if (run.terminal || run.retired) throw new VantaError('This Agent Mode run has ended.');
        run.modelActive = true;
        if (agent.staging >= 12 || agent.review || !agent.discovered.has(proposal.path)) {
          throw new VantaError('Discover this file before staging it. Stage up to 12 files before review.');
        }
        agent.staging++;
        try {
          const base = await agent.workspace.capture(proposal.path, AbortSignal.any([signal, AbortSignal.timeout(6000)]));
          signal.throwIfAborted();
          if (agent.review) throw new VantaError('This proposal is already under review.');
          const staged = agent.patch.stage(base, proposal);
          this.#activity('Agent file staged', proposal.path);
          return staged;
        } catch (error) {
          this.#activity('Agent staging rejected', error instanceof VantaError ? error.message : 'The target could not be captured.');
          throw error;
        } finally { agent.staging--; }
      },
      review: (reference) => agent.receipt = agent.patch.consume(reference),
      verify: async (target) => {
        signal.throwIfAborted();
        if (run.terminal || run.retired) throw new VantaError('This Agent Mode run has ended.');
        const gate = agent.verification;
        const receipt = agent.receipt;
        if (!gate?.grant || target !== gate.target || !receipt || !agent.review?.confirmed || this.dependencies.scopeKey?.() !== agent.scope) {
          throw new VantaError('Verification requires matching local approval for this target and patch.');
        }
        const digest = gate.grant;
        gate.grant = undefined;
        this.#set({ verification: { command: pytestCommand(target), status: 'running' } });
        try {
          const stop = new AbortController();
          const checking = runPytest(agent.workspace.repository, agent.python, target, agent.patch.approved(receipt), AbortSignal.any([signal, stop.signal]));
          agent.checking = { promise: checking, stop };
          const result = await checking;
          this.#set({ verification: result });
          this.#activity('Verification finished', `${result.status} · exit ${result.exitCode ?? 'unavailable'}`);
          // Keep test output local. Tests can emit data that pattern-based redaction misses.
          return gate.result = { digest, status: result.status, exitCode: result.exitCode };
        } catch (error) {
          this.#set({ verification: { command: pytestCommand(target), status: signal.aborted ? 'cancelled' : 'failed',
            exitCode: null, output: error instanceof VantaError ? error.message : 'Could not prepare or clean up the temporary snapshot.' } });
          throw error;
        } finally { agent.checking = undefined; }
      },
    };
  }

  #map(run: Run, event: Event) {
    if (event.type === 'model.message' || event.type === 'model.message.delta' || event.type === 'tool.response' || event.type === 'tool.approval_required') {
      run.modelActive = true;
    }
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
        if (content || this.state.messages.some((message) => message.id === `assistant-${run.id}-${event.id}`)) {
          this.#text(run, event.id, content ?? '', false);
        }
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
        if (run.agent && event.threadId !== 'main') throw new VantaError('Unexpected Agent Mode approval thread.');
        const call = event.toolCalls[0];
        if (call && (run.approval?.id === call.id || run.decided?.has(call.id))) break;
        if (!call || event.toolCalls.length !== 1 || run.approval) {
          throw new VantaError('TrueForge requested multiple or overlapping approvals. This version of VANTA supports one workspace call at a time.');
        }
        const source = run.calls.get(call.id);
        const canAllow = source?.allowed === true && source.sourceId === call.sourceEventId;
        run.approval = { id: call.id, threadId: event.threadId, canAllow, name: source?.name };
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
        if (run.agent) {
          const agent = run.agent;
          if (canAllow && source.name === reviewAgentTool && !agent.review && !agent.staging && agent.patch.matches(source.reference)) {
            agent.review = { id: call.id };
            this.#set({ phase: 'approval' });
            this.#activity('Waiting for Agent Mode review', `${agent.patch.id} · revision ${agent.patch.reference.revision}`);
            const file = agent.patch.files.values().next().value!;
            void this.#previewAgent(run, agent, file.hunks[0]!.id);
            break;
          }
          if (canAllow && source.name === verifyAgentTool && source.target && agent.review?.confirmed && !agent.verification) {
            agent.verification = { id: call.id, target: source.target };
            this.#set({ phase: 'approval', approval: { id: call.id, canAllow: true, label: 'Run approved pytest profile',
              detail: `${pytestCommand(source.target)} · Temporary workspace with only the accepted edits. Python tests run with your account privileges.` },
              verification: { command: pytestCommand(source.target), status: 'awaiting approval' } });
            this.#activity('Waiting for verification approval', source.target);
            break;
          }
          throw new VantaError('TrueForge requested an invalid or out-of-order Agent Mode approval.');
        }
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
        if (run.agent && event.threadId === 'main') {
          const { review, receipt, verification } = run.agent;
          if (review?.id === event.toolCallId && review.acknowledged && receipt) review.confirmed = event.content === JSON.stringify(receipt);
          if (verification?.id === event.toolCallId && verification.acknowledged && verification.result) {
            verification.confirmed = event.content === JSON.stringify(verification.result);
          }
        }
        this.#activity('Tool returned', run.calls.get(event.toolCallId)?.name);
        break;
      case 'user.tool_approval':
        if (run.quick?.approvalId === event.toolCallId && event.approval.status === 'allow' && run.quick.reviewed) {
          run.quick.acknowledged = true;
        }
        if (run.agent && event.threadId === 'main' && event.approval.status === 'allow') {
          for (const gate of [run.agent.review, run.agent.verification]) {
            if (gate?.id === event.toolCallId) gate.acknowledged = true;
          }
        }
        break;
      case 'tool.response_required':
      case 'mcp.auth_required':
        throw new VantaError('This agent requested an interactive action that VANTA does not support. Open the session in TrueForge.');
      case 'turn.done':
        run.terminal = event.state.status === 'done' ? 'completed' : event.state.status === 'cancelled' ? 'cancelled' : 'failed';
        run.providerFailure = event.state.status === 'error' ? modelFailure(event.state.message) : undefined;
        run.approval = undefined;
        this.#set({ approval: undefined, error: run.providerFailure?.detail });
        break;
    }
  }

  #rememberCalls(run: Run, sourceId: string, calls: (Api.ToolCall | Api.ExtendedChunkDeltaToolCall)[]) {
    for (const call of calls) {
      const info = call.toolInfo;
      if (!call.id || !info) continue;
      const direct = info.type === 'mcp' && !!run.bridge && info.serverName === run.bridge.name;
      let name = direct && [overviewToolName, proposeTool, reviewTool, stageAgentTool, reviewAgentTool, verifyAgentTool, 'stage_related_edits', 'read_file', 'read_workspace_ranges', 'search_workspace'].includes(info.name) ? info.name : info.type === 'truefoundry-system'
        && ['list_tools', 'get_tool_info', 'call_tool', 'get_tool_output_schema'].includes(info.name) ? info.name : 'TrueForge tool';
      let args: unknown;
      let bound = direct;
      try {
        if (call.function?.arguments) args = JSON.parse(call.function.arguments);
      } catch { /* wait for subsequent argument fragments */ }
      if (info.type === 'truefoundry-system' && name === 'call_tool' && run.bridge && args && typeof args === 'object'
        && 'mcp_server' in args && args.mcp_server === run.bridge.name && 'tool_name' in args && 'input' in args
        && ((run.quick && args.tool_name === reviewTool)
          || (run.agent && (args.tool_name === reviewAgentTool || args.tool_name === verifyAgentTool)))) {
        name = args.tool_name;
        args = args.input;
        bound = true;
      }
      let proposalId: string | undefined;
      let reference: ReviewReference | undefined;
      let target: string | undefined;
      if (run.quick && bound && name === reviewTool) {
        const parsed = reviewSchema.safeParse(args);
        if (parsed.success) proposalId = parsed.data.proposalId;
      }
      if (run.agent && bound && name === reviewAgentTool) reference = reviewAgentSchema.safeParse(args).data;
      if (run.agent && bound && name === verifyAgentTool) {
        const candidate = verifyAgentSchema.safeParse(args).data?.target;
        if (candidate && verificationTarget(candidate) && run.agent.discovered.has(candidate)) target = candidate;
      }
      const previous = run.calls.get(call.id);
      if (!previous || proposalId || reference || target) run.calls.set(call.id, { name, sourceId, proposalId, reference, target,
        allowed: bound && (run.quick ? !!proposalId : run.agent ? !!(reference || target) : name === overviewToolName) });
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

  #agentReview(agent: AgentRun, current: number) {
    const files = [...agent.patch.files.values()].map(({ base, summary, hunks }) => ({ path: base.path, summary,
      hunks: hunks.map(({ id, start, status }) => ({ id, line: base.text.slice(0, start).split('\n').length, status })) }));
    this.#set({ review: { id: agent.patch.id, path: '', explanation: '', current, files, hunks: files.flatMap((file) => file.hunks) } });
  }

  async #previewAgent(run: Run, agent: AgentRun, id: number) {
    const file = [...agent.patch.files.values()].find(({ hunks }) => hunks.some((hunk) => hunk.id === id));
    if (!file) return;
    try {
      await agent.workspace.preview(agent.patch.id, file, id);
      if (this.#active === run && run.approval?.id === agent.review?.id && !run.abort.signal.aborted) this.#agentReview(agent, id);
    } catch {
      if (this.#active === run && !run.abort.signal.aborted) {
        this.#set({ error: 'Could not open the native Agent Mode diff.' });
        await this.cancel();
      }
    }
  }

  async reviewHunk(id: string, hunk: number, decision: 'accepted' | 'rejected' | 'view') {
    const run = this.#active;
    const quick = run?.quick;
    const patch = quick?.patch;
    const agent = run?.agent;
    if (run?.approval && agent && agent.patch.id === id && this.state.review?.id === id) {
      const item = [...agent.patch.files.values()].flatMap((file) => file.hunks).find((item) => item.id === hunk);
      if (!item) return;
      if (decision !== 'view') item.status = decision;
      this.#agentReview(agent, hunk);
      await this.#previewAgent(run, agent, hunk);
      return;
    }
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
    const agent = run?.agent;
    if (run && agent && approval && run.sessionId && run.turnId && approval.id === agent.review?.id
      && agent.patch.id === id && this.state.review?.id === id) {
      try {
        if (apply) agent.patch.authorize({ workspace: agent.scope, session: run.sessionId, turn: run.turnId, call: approval.id });
        else agent.patch.close();
        this.#set({ review: undefined });
        await this.#decide(approval.id, apply);
      } catch (error) { this.#set({ error: safeError(error) }); }
      return;
    }
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
    const agent = this.#active?.agent;
    if (agent?.patch.id === id && review?.id === id) {
      for (const file of agent.patch.files.values()) for (const hunk of file.hunks) if (hunk.status === 'pending') hunk.status = 'rejected';
      this.#agentReview(agent, review.current);
      return;
    }
    if (!patch || patch.id !== id || review?.id !== id) return;
    for (const hunk of patch.hunks) if (hunk.status === 'pending') patch.decide(hunk.id, 'rejected');
    this.#reviewSnapshot(patch, review.current);
  }

  async decide(id: string, allow: boolean) {
    const run = this.#active;
    if (!run?.quick && run?.approval?.name !== reviewAgentTool) await this.#decide(id, allow);
  }

  async undoAgent() {
    if (!this.#undo || this.#active || this.#undoing) return;
    this.#undoing = true;
    try {
      await this.#undo();
      this.#undo = undefined;
      if (this.state.changes) this.#set({ changes: { ...this.state.changes, status: 'undone' }, error: undefined });
    } catch (error) { this.#set({ error: safeError(error) }); }
    finally { this.#undoing = false; }
  }

  async #decide(id: string, allow: boolean) {
    const run = this.#active;
    const approval = run?.approval;
    if (!run?.sessionId || !run.turnId || !approval || id !== approval.id || (allow && !approval.canAllow) || run.abort.signal.aborted) return;
    const releasePause = run.releasePause;
    (run.decided ??= new Set()).add(approval.id);
    const agent = run.agent;
    if (agent) {
      if (!allow) agent.denied = true;
      const gate = agent.verification;
      if (allow && approval.name === verifyAgentTool && gate && agent.receipt) {
        gate.grant = fingerprint(JSON.stringify([agent.scope, agent.python, run.sessionId, run.turnId, approval.id,
          agent.receipt.digest, 'pytest', [gate.target, '-q'], 'temporary snapshot root']));
      }
      if (!allow && gate) this.#set({ verification: { command: pytestCommand(gate.target), status: 'denied' } });
    }
    run.approval = undefined;
    this.#set({ approval: undefined, phase: 'streaming' });
    if (allow && !run.quick && !agent) run.bridge?.grant();
    try {
      await run.forge.approve(run.sessionId, run.turnId, {
        type: 'user.tool_approval', threadId: approval.threadId, toolCallId: approval.id,
        approval: allow ? { status: 'allow' } : { status: 'deny', reason: agent || run.quick ? 'The user declined this operation.' : 'The user declined to share workspace metadata.' },
      }, run.abort.signal);
      if (!run.abort.signal.aborted) this.#activity(agent ? `${allow ? 'Approved' : 'Rejected'} ${approval.name}` : run.quick ? (allow ? 'Approved reviewed hunks' : 'Rejected Quick Edit')
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
    if (!run || run.abort.signal.aborted || run.quick?.committing || run.agent?.committing || (run.terminal && !run.quick && !run.agent)) return;
    this.#set({ phase: 'cancelling', approval: undefined, review: undefined });
    run.approval = undefined;
    run.bridge?.revoke();
    run.quick?.patch?.revoke();
    run.agent?.patch.close();
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
