import type { ApprovedFile, StagedFile } from './agentPatch';
import type { BaseSelection } from './quickPatch';
import type { Repository } from './repository';
import { VantaError } from './trueforge';

export interface AgentWorkspace {
  repository: Repository;
  capture(path: string, signal: AbortSignal): Promise<BaseSelection>;
  preview(id: string, file: StagedFile, hunk: number): Promise<void>;
  apply(files: readonly ApprovedFile[], signal: AbortSignal, begin: () => void): Promise<() => Promise<void>>;
}

export interface BatchFile {
  path: string;
  before: string;
  after: string;
  current(): string;
}

export async function applyBatch<T extends BatchFile>(files: readonly T[], write: (files: readonly T[], undo: boolean) => PromiseLike<boolean>) {
  if (files.some((file) => file.current() !== file.before)) throw new VantaError('A target changed during final preflight. Start a new Agent Mode request.');
  try {
    if (await write(files, false) && files.every((file) => file.current() === file.after)) return;
  } catch { /* Inspect the buffers before attempting recovery. */ }
  const recoverable = files.filter((file) => file.current() === file.after);
  if (recoverable.length) {
    try { await write(recoverable, true); } catch { /* Report every file requiring manual recovery. */ }
  }
  const changed = files.filter((file) => file.current() !== file.before).map((file) => file.path);
  throw new VantaError(changed.length ? `Apply was interrupted. Inspect these buffers and recover any remaining changes manually: ${changed.join(', ')}.`
    : 'VS Code could not apply the batch. The target buffers match their original contents.');
}
