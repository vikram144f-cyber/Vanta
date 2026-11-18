import type { StudioState } from './protocol';

type Review = NonNullable<StudioState['review']>;
type Verification = NonNullable<StudioState['verification']>;
type Tool = 'quick edit review' | 'patch review' | 'pytest' | 'other tool';
type Outcome = 'applied to editor buffers' | 'discarded' | 'undone in editor buffers';
type Status = 'completed' | 'failed' | 'cancelled';
type File = { path: string; hunks?: { id: number; line: number }[] };

export type ProofEvent =
  | { kind: 'task'; text?: string }
  | { kind: 'session'; model?: string; session?: string }
  | { kind: 'selection'; path: string; start: number; end: number }
  | { kind: 'context'; operation: string; hits: { path: string; start: number; end: number; reason: string }[]; estimatedTokens: number; budget: number; limited: boolean }
  | { kind: 'proposal'; files: File[] }
  | { kind: 'review'; decisions: { path: string; hunk: number; decision: 'accepted' | 'rejected' }[] }
  | { kind: 'review-submitted'; decision: 'approve selection' | 'discard proposal' }
  | { kind: 'approval'; tool: Tool; decision: 'allow' | 'deny' }
  | { kind: 'verification'; status: Verification['status']; exitCode?: number | null; command: string }
  | { kind: 'outcome'; status: Outcome }
  | { kind: 'provider-failure'; detail?: string }
  | { kind: 'fallback'; model?: string }
  | { kind: 'finished'; status: Status };

export interface ProofRecord {
  mode: 'Quick Edit' | 'Agent Mode';
  events: ProofEvent[];
  omitted: number;
  archived?: boolean;
  retainedSession?: string;
}

const outcomes: Readonly<Record<string, Outcome>> = {
  'Quick Edit applied to buffer': 'applied to editor buffers',
  'Agent changes applied to buffers': 'applied to editor buffers',
  'Quick Edit discarded': 'discarded',
  'Agent changes discarded': 'discarded',
};
const terminal = (phase: StudioState['phase']): phase is Status =>
  phase === 'completed' || phase === 'failed' || phase === 'cancelled';

function reviewedFiles(review: Review) {
  return review.files ?? [{ path: review.path, hunks: review.hunks }];
}

export class ProofTrail {
  readonly #records = new Map<string, ProofRecord>();
  #seenApprovals = new Set<string>();
  #current?: ProofRecord;

  start(id: string | undefined, mode: ProofRecord['mode'] | undefined, text: string) {
    this.#current = undefined;
    this.#seenApprovals.clear();
    if (!id || !mode) return;
    this.#current = { mode, events: [{ kind: 'task', text }], omitted: 0 };
    this.#records.delete(id);
    this.#records.set(id, this.#current);
    if (this.#records.size > 12) this.#records.delete(this.#records.keys().next().value!);
  }

  add(event: ProofEvent) {
    if (this.#current) this.#append(this.#current, event);
  }

  #append(record: ProofRecord, event: ProofEvent) {
    if (record.events.length >= 160) {
      record.events.splice(1, 1);
      record.omitted++;
    }
    record.events.push(event);
  }

  observe(before: StudioState, after: StudioState) {
    if (!this.#current) return;
    if (after.sessionId && after.sessionId !== before.sessionId) {
      this.add({ kind: 'session', session: after.sessionId, model: after.activeModel });
    }
    const context = after.context?.at(-1);
    if (context && context !== before.context?.at(-1)) {
      const hits = context.hits.filter(({ selected }) => selected).map(({ path, start, end, reason }) => ({ path, start, end, reason }));
      if (hits.length || context.limited || context.omitted) this.add({ kind: 'context', operation: context.operation, hits,
        estimatedTokens: context.estimatedTokens, budget: context.budget, limited: context.limited || context.omitted > 0 });
    }
    const review = after.review;
    if (review && review !== before.review) {
      const prior = before.review?.id === review.id ? before.review : undefined;
      const files = reviewedFiles(review);
      const previous = new Map(prior?.hunks.map(({ id, status }) => [id, status]));
      const decisions = files.flatMap(({ path, hunks }) => hunks.flatMap(({ id, status }) =>
        status !== 'pending' && previous.get(id) !== status ? [{ path, hunk: id, decision: status }] : []));
      if (decisions.length) this.add({ kind: 'review', decisions });
    }
    const verification = after.verification;
    if (verification && verification !== before.verification && verification.status !== 'awaiting approval' && verification.status !== 'running') {
      const { command, status, exitCode } = verification;
      this.add({ kind: 'verification', command, status, exitCode });
    }
  }

  activity(label: string, detail?: string) {
    if (Object.hasOwn(outcomes, label)) this.add({ kind: 'outcome', status: outcomes[label]! });
    if (label === 'Using configured secondary model') this.add({ kind: 'fallback', model: detail });
  }

  staged(path: string, text: string, hunks: readonly { id: number; start: number }[]) {
    if (this.#current) this.add({ kind: 'proposal', files: [{ path, hunks: hunks.map(({ id, start }) =>
      ({ id, line: text.slice(0, start).split('\n').length })) }] });
  }

  approval(id: string, name: string | undefined, decision: 'allow' | 'deny') {
    if (!this.#current || this.#seenApprovals.has(id)) return;
    this.#seenApprovals.add(id);
    const tool = name === 'review_quick_edit' ? 'quick edit review' : name === 'review_changes' ? 'patch review'
      : name === 'run_verification' ? 'pytest' : 'other tool';
    this.add({ kind: 'approval', tool, decision });
  }

  finish(status: Status) {
    this.add({ kind: 'finished', status });
    this.#current = undefined;
  }

  undoCallback() {
    const record = this.#current;
    return () => { if (record) this.#append(record, { kind: 'outcome', status: 'undone in editor buffers' }); };
  }

  clear() {
    this.#current = undefined;
    this.#records.clear();
    this.#seenApprovals.clear();
  }

  read(state: StudioState): ProofRecord | undefined {
    if (!terminal(state.phase) || !(state.quickEdit || state.agentMode)) return;
    const record = state.conversationId && this.#records.get(state.conversationId);
    if (record) return record;
    const events: ProofEvent[] = [{ kind: 'task', text: state.messages.filter(({ role }) => role === 'user').at(-1)?.text }];
    const verification = state.verification;
    const lastVerification = state.activity.map(({ label }) => label).lastIndexOf('Verification finished');
    for (const [index, { label }] of state.activity.entries()) {
      if (Object.hasOwn(outcomes, label)) events.push({ kind: 'outcome', status: outcomes[label]! });
      if (label === 'Primary model failed') events.push({ kind: 'provider-failure' });
      if (label === 'Using configured secondary model') events.push({ kind: 'fallback' });
      if (verification && label === 'Verification finished' && index === lastVerification
        && (verification.status === 'passed' || verification.status === 'failed' || verification.status === 'timed out')) {
        const { command, status, exitCode } = verification;
        events.push({ kind: 'verification', command, status, exitCode });
      }
    }
    events.push({ kind: 'finished', status: state.phase });
    return { mode: state.quickEdit ? 'Quick Edit' : 'Agent Mode', events, omitted: 0, archived: true, retainedSession: state.sessionId };
  }
}

// Build a receipt from typed facts only. Arbitrary strings never enter the export.
export function proofReceipt(record: ProofRecord) {
  const aliases = new Map<string, string>();
  const file = (path: string) => {
    if (!aliases.has(path)) aliases.set(path, `File ${aliases.size + 1}`);
    return aliases.get(path)!;
  };
  return JSON.stringify({
    version: 1,
    mode: record.mode,
    archived: !!record.archived,
    omittedEvents: record.omitted,
    events: record.events.map((event) => {
      switch (event.kind) {
        case 'task': return { kind: event.kind, taskTextIncluded: false };
        case 'session': return { kind: event.kind };
        case 'selection': return { kind: event.kind, file: file(event.path), start: event.start, end: event.end };
        case 'context': return { kind: event.kind, estimatedTokens: event.estimatedTokens, budget: event.budget, limited: event.limited,
          hits: event.hits.map(({ path, start, end }) => ({ file: file(path), start, end })) };
        case 'proposal': return { kind: event.kind, files: event.files.map(({ path, hunks }) =>
          ({ file: file(path), hunks: hunks?.map(({ id, line }) => ({ id, line })) })) };
        case 'review': return { kind: event.kind, decisions: event.decisions.map(({ path, hunk, decision }) => ({ file: file(path), hunk, decision })) };
        case 'review-submitted': return { kind: event.kind, decision: event.decision };
        case 'approval': return { kind: event.kind, tool: event.tool, decision: event.decision };
        case 'verification': return { kind: event.kind, profile: 'pytest', status: event.status, exitCode: event.exitCode ?? null };
        case 'outcome':
        case 'finished': return { kind: event.kind, status: event.status };
        case 'provider-failure':
        case 'fallback': return { kind: event.kind };
      }
    }),
  }, null, 2) + '\n';
}
