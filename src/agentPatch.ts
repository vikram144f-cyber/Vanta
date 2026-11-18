import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyHunks, createHunks, fingerprint } from './quickPatch';
import type { BaseSelection, Hunk } from './quickPatch';
import { maxFileBytes } from './repository';
import { rstHeadings } from './rst';
import { VantaError } from './trueforge';

export const stageAgentTool = 'stage_file_edit';
export const reviewAgentTool = 'review_changes';
export const verifyAgentTool = 'run_verification';
export const stageAgentSchema = z.strictObject({
  path: z.string().min(1).max(480), summary: z.string().trim().min(1).max(400),
  edits: z.array(z.strictObject({ old: z.string().min(1).max(6000), replacement: z.string().max(8000) })).min(1).max(8),
});
export const reviewAgentSchema = z.strictObject({ proposalId: z.uuid(), revision: z.number().int().min(1).max(12) });
export const verifyAgentSchema = z.strictObject({ target: z.string().min(1).max(480) });
export type FileProposal = z.infer<typeof stageAgentSchema>;
export type ReviewReference = z.infer<typeof reviewAgentSchema>;
export interface ApprovalBinding { session: string; turn: string; call: string; workspace: string }
export interface StagedFile { base: BaseSelection; summary: string; hunks: Hunk[] }
export interface ApprovedFile { base: BaseSelection; after: string; ids: number[] }
export interface AgentReceipt extends ReviewReference { digest: string; files: string[] }

function rstSections(source: string) {
  const headings = rstHeadings(source.split(/\r?\n/));
  const parents: typeof headings = [];
  return headings.map((heading) => {
    while ((parents.at(-1)?.level ?? -1) >= heading.level) parents.pop();
    const parent = parents.at(-1)?.start;
    parents.push(heading);
    return { ...heading, parent };
  });
}

function retainedLines(before: string, hunks: readonly Hunk[]) {
  const lines = new Map<number, number>();
  const breaks = (text: string) => text.split('\n').length - 1;
  let original = 1;
  let proposed = 1;
  let offset = 0;
  const retain = (count: number) => {
    for (let i = 0; i < count; i++) lines.set(original++, proposed++);
  };
  for (const { start, end, replacement } of hunks) {
    retain(breaks(before.slice(offset, start)));
    original += breaks(before.slice(start, end));
    proposed += breaks(replacement);
    offset = end;
  }
  if (offset < before.length) retain(breaks(before.slice(offset)) + 1);
  return lines;
}

function assertRstSectionPlacement(base: BaseSelection, hunks: readonly Hunk[], after: string) {
  if (!base.path.toLowerCase().endsWith('.rst')) return;
  const original = rstSections(base.text);
  const proposed = new Map(rstSections(after).map((heading) => [heading.start, heading]));
  const lines = retainedLines(base.text, hunks);
  const carried = new Map<number, NonNullable<ReturnType<typeof proposed.get>>>();
  for (const heading of original) {
    const next = proposed.get(lines.get(heading.start) ?? -1);
    if (next?.title === heading.title && next.style === heading.style && lines.get(heading.end) === next.end) carried.set(heading.start, next);
  }
  const existing = new Set([...carried.values()].map(({ start }) => start));
  for (const heading of original) {
    const parent = carried.get(heading.start)?.parent;
    if (parent === undefined || existing.has(parent) || (heading.parent !== undefined && !carried.has(heading.parent))) continue;
    throw new VantaError(`The new documentation section at proposed line ${parent} would contain the existing section "${heading.title}" (line ${heading.end - 1}). Insert the new section at a complete peer-section boundary so existing subsections keep their parent.`);
  }
}

export class AgentPatch {
  readonly id = randomUUID();
  readonly files = new Map<string, StagedFile>();
  #hunks = 0;
  #grant?: { receipt: AgentReceipt; files: ApprovedFile[] };
  #receipt?: AgentReceipt;
  #closed = false;

  get reference(): ReviewReference { return { proposalId: this.id, revision: this.files.size }; }

  stage(base: BaseSelection, proposal: FileProposal) {
    return this.#commit(this.#prepare(base, proposal));
  }

  async stageValidated(base: BaseSelection, proposal: FileProposal, validate: (file: StagedFile) => Promise<void>) {
    const file = this.#prepare(base, proposal);
    await validate(file);
    return this.#commit(file);
  }

  #prepare(base: BaseSelection, proposal: FileProposal): StagedFile {
    if (this.#closed || this.#grant || this.files.size >= 12 || this.files.has(proposal.path)) {
      throw new VantaError('This proposal is sealed or the file was already staged. Stage all edits for a file in one call.');
    }
    const edits = proposal.edits.map(({ old, replacement }, index) => {
      const text = old.replace(/\r\n?|\n/g, base.eol);
      const start = base.text.indexOf(text);
      if (start < 0) {
        const guidance = /\\[nr"]/.test(old)
          ? ' Use source text in the string value. Preserve real line breaks and quotes when copying from a JSON excerpt.'
          : ' Copy a short verbatim anchor from the source, including its indentation.';
        throw new VantaError(`Edit ${index + 1} is missing an exact anchor.${guidance}`);
      }
      if (base.text.indexOf(text, start + 1) >= 0) throw new VantaError(`Edit ${index + 1} has an ambiguous anchor. Include unique surrounding text.`);
      return { start, end: start + text.length, replacement: replacement.replace(/\r\n?|\n/g, base.eol) };
    }).sort((a, b) => a.start - b.start);
    const after = applyHunks(base, edits);
    if (Buffer.byteLength(after) > maxFileBytes) throw new VantaError('The proposed file exceeds 96 KiB.');
    const hunks = createHunks(base, after);
    assertRstSectionPlacement(base, hunks, after);
    return { base, summary: proposal.summary, hunks };
  }

  #commit(file: StagedFile) {
    const { base, hunks } = file;
    if (this.#closed || this.#grant || this.files.size >= 12 || this.files.has(base.path)) {
      throw new VantaError('This proposal is sealed or the file was already staged. Stage all edits for a file in one call.');
    }
    if (this.#hunks + hunks.length > 60) throw new VantaError('The proposal has more than 60 hunks. Narrow the task.');
    for (const hunk of hunks) hunk.id = ++this.#hunks;
    this.files.set(base.path, file);
    return { ...this.reference, path: base.path, hunks: hunks.length, baseFingerprint: fingerprint(base.text) };
  }

  matches(reference: ReviewReference | undefined) {
    return !this.#closed && !!reference && reference.proposalId === this.id && reference.revision === this.files.size && this.files.size > 0;
  }

  authorize(binding: ApprovalBinding) {
    this.#grant = this.#prepareGrant(binding);
  }

  async authorizeValidated(binding: ApprovalBinding, validate: (files: readonly ApprovedFile[]) => Promise<void>) {
    const grant = this.#prepareGrant(binding);
    await validate(grant.files);
    if (this.#prepareGrant(binding).receipt.digest !== grant.receipt.digest) throw new VantaError('The selected hunks changed. Review the current selection and approve it again.');
    this.#grant = grant;
  }

  #prepareGrant(binding: ApprovalBinding) {
    if (this.#closed || this.#grant) throw new VantaError('This proposal is already sealed.');
    const files: ApprovedFile[] = [];
    const operation = [];
    for (const [path, { base, hunks }] of this.files) {
      if (hunks.some((hunk) => hunk.status === 'pending')) throw new VantaError('Review every hunk first.');
      const accepted = hunks.filter((hunk) => hunk.status === 'accepted');
      if (!accepted.length) continue;
      const after = applyHunks(base, accepted);
      assertRstSectionPlacement(base, accepted, after);
      const ids = accepted.map((hunk) => hunk.id);
      files.push({ base, after, ids });
      operation.push([path, base.version, fingerprint(base.text), fingerprint(after), ids]);
    }
    if (!files.length) throw new VantaError('Accept at least one hunk or discard the proposal.');
    const reference = this.reference;
    return { files, receipt: { ...reference, files: files.map((file) => file.base.path),
      digest: fingerprint(JSON.stringify([binding, reference, operation])) } };
  }

  consume(reference: ReviewReference): AgentReceipt {
    if (!this.matches(reference) || !this.#grant || this.#receipt) throw new VantaError('No matching local patch approval.');
    return this.#receipt = this.#grant.receipt;
  }

  approved(receipt: AgentReceipt): readonly ApprovedFile[] {
    if (this.#closed || this.#receipt !== receipt || !this.#grant) throw new VantaError('No matching approved patch.');
    return this.#grant.files;
  }

  close() { this.#closed = true; this.#grant = undefined; this.#receipt = undefined; }
}
