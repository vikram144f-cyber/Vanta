import type { ContextReport } from './context';

export interface Connection {
  status: 'checking' | 'connected' | 'offline';
  detail: string;
  version?: string;
  models: string[];
  selectedModel?: string;
  agentName?: string;
  attention?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface Activity {
  label: string;
  detail?: string;
}

export interface Approval {
  id: string;
  label: string;
  detail: string;
  canAllow: boolean;
}

export type Phase = 'idle' | 'starting' | 'streaming' | 'approval' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
type HunkSummary = { id: number; line: number; status: 'pending' | 'accepted' | 'rejected' };

export interface StudioState {
  connection: Connection;
  messages: Message[];
  activity: Activity[];
  phase: Phase;
  conversationId?: string;
  history?: { id: string; title: string }[];
  sessionId?: string;
  activeModel?: string;
  retry?: { prompt: string; shareContext: boolean; agentMode: boolean };
  revision?: { id: string };
  approval?: Approval;
  error?: string;
  context?: ContextReport[];
  quickEdit?: boolean;
  agentMode?: boolean;
  changes?: { paths: string[]; status: 'applied' | 'undone' };
  verification?: { command: string; status: 'awaiting approval' | 'running' | 'passed' | 'failed' | 'timed out' | 'cancelled' | 'denied'; exitCode?: number | null; output?: string };
  review?: { id: string; path: string; explanation: string; current: number; blocked?: string; canRevise?: boolean;
    hunks: HunkSummary[]; files?: { path: string; summary: string; hunks: HunkSummary[] }[] };
}

export type StudioAction =
  | { type: 'ready' | 'refreshConnection' | 'cancelRun' | 'clearConversation' | 'pickReference' | 'undoAgent' | 'openProofTrail' }
  | { type: 'submitPrompt'; text: string; shareContext?: boolean; agentMode?: boolean }
  | { type: 'openConversation'; id: string }
  | { type: 'selectModel'; model: string }
  | { type: 'openContext'; path: string; line: number }
  | { type: 'reviewHunk'; id: string; hunk: number; decision: 'accepted' | 'rejected' | 'view' }
  | { type: 'finishReview'; id: string; apply: boolean }
  | { type: 'rejectAndRevise'; id: string; diagnostic: string }
  | { type: 'reviseProposal'; id: string; diagnostic: string }
  | { type: 'rejectRemaining'; id: string }
  | { type: 'decideApproval'; id: string; allow: boolean };

export type StudioUpdate = { type: 'snapshot'; state: StudioState } | { type: 'insertReference'; text: string };

export function parseStudioAction(value: unknown): StudioAction | undefined {
  if (!value || typeof value !== 'object' || !('type' in value)) return;
  switch (value.type) {
    case 'ready':
    case 'refreshConnection':
    case 'cancelRun':
    case 'clearConversation':
    case 'pickReference':
    case 'undoAgent':
    case 'openProofTrail':
      return { type: value.type };
    case 'submitPrompt':
      if ('text' in value && typeof value.text === 'string' && value.text.length <= 12_000 && value.text.trim()) {
        return { type: value.type, text: value.text.trim(), ...('shareContext' in value && value.shareContext === true ? { shareContext: true } : {}),
          ...('agentMode' in value && value.agentMode === true ? { agentMode: true } : {}) };
      }
      return;
    case 'openConversation':
      if ('id' in value && typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id)) {
        return { type: value.type, id: value.id };
      }
      return;
    case 'openContext':
      if ('path' in value && typeof value.path === 'string' && value.path.length <= 480
        && 'line' in value && typeof value.line === 'number' && Number.isInteger(value.line) && value.line > 0) {
        return { type: value.type, path: value.path, line: value.line };
      }
      return;
    case 'selectModel':
      if ('model' in value && typeof value.model === 'string' && value.model.length <= 256) {
        return { type: value.type, model: value.model };
      }
      return;
    case 'decideApproval':
      if ('id' in value && typeof value.id === 'string' && value.id.length <= 256 && 'allow' in value && typeof value.allow === 'boolean') {
        return { type: value.type, id: value.id, allow: value.allow };
      }
      return;
    case 'reviewHunk':
      if ('id' in value && typeof value.id === 'string' && value.id.length === 36 && 'hunk' in value
        && typeof value.hunk === 'number' && Number.isInteger(value.hunk) && value.hunk > 0 && value.hunk <= 60
        && 'decision' in value && (value.decision === 'accepted' || value.decision === 'rejected' || value.decision === 'view')) {
        return { type: value.type, id: value.id, hunk: value.hunk, decision: value.decision };
      }
      return;
    case 'finishReview':
      if ('id' in value && typeof value.id === 'string' && value.id.length === 36 && 'apply' in value && typeof value.apply === 'boolean') {
        return { type: value.type, id: value.id, apply: value.apply };
      }
      return;
    case 'rejectAndRevise':
    case 'reviseProposal':
      if ('id' in value && typeof value.id === 'string' && value.id.length === 36
        && 'diagnostic' in value && typeof value.diagnostic === 'string' && value.diagnostic.length <= 4000) {
        return { type: value.type, id: value.id, diagnostic: value.diagnostic.trim() };
      }
      return;
    case 'rejectRemaining':
      if ('id' in value && typeof value.id === 'string' && value.id.length === 36) return { type: value.type, id: value.id };
      return;
    default:
      return;
  }
}

export function isBusy(phase: Phase): boolean {
  return phase === 'starting' || phase === 'streaming' || phase === 'approval' || phase === 'cancelling';
}
