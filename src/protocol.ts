import type { ContextReport } from './context';

export interface Connection {
  status: 'checking' | 'connected' | 'offline';
  detail: string;
  version?: string;
  models: string[];
  selectedModel?: string;
  agentName?: string;
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

export interface StudioState {
  connection: Connection;
  messages: Message[];
  activity: Activity[];
  phase: Phase;
  sessionId?: string;
  approval?: Approval;
  error?: string;
  context?: ContextReport[];
}

export type StudioAction =
  | { type: 'ready' | 'refreshConnection' | 'cancelRun' | 'clearConversation' | 'pickReference' }
  | { type: 'submitPrompt'; text: string; shareContext?: boolean }
  | { type: 'selectModel'; model: string }
  | { type: 'openContext'; path: string; line: number }
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
      return { type: value.type };
    case 'submitPrompt':
      if ('text' in value && typeof value.text === 'string' && value.text.length <= 12_000 && value.text.trim()) {
        return { type: value.type, text: value.text.trim(), ...('shareContext' in value && value.shareContext === true ? { shareContext: true } : {}) };
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
    default:
      return;
  }
}

export function isBusy(phase: Phase): boolean {
  return phase === 'starting' || phase === 'streaming' || phase === 'approval' || phase === 'cancelling';
}
