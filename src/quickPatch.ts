import { createHash, randomUUID } from 'node:crypto';
import { diffLines } from 'diff';
import { z } from 'zod';
import { VantaError } from './trueforge';

export const proposeTool = 'propose_quick_edit';
export const reviewTool = 'review_quick_edit';
export const proposalSchema = z.strictObject({
  replacement: z.string().max(24_000), explanation: z.string().trim().min(1).max(600),
});
export const reviewSchema = z.strictObject({ proposalId: z.uuid() });

export interface BaseSelection {
  path: string;
  text: string;
  version: number;
  start: number;
  end: number;
  eol: '\n' | '\r\n';
}

export interface HunkEdit { start: number; end: number; replacement: string }
export interface Hunk extends HunkEdit { id: number; status: 'pending' | 'accepted' | 'rejected' }
export interface ReviewReceipt { proposalId: string; accepted: readonly number[]; digest: string }

export function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf16le').digest('hex');
}

export function assertBase(base: BaseSelection, version: number, text: string) {
  if (version !== base.version || text !== base.text) throw new VantaError('Quick Edit is stale. The source document changed. Run Quick Edit again.');
}

export function createHunks(base: BaseSelection, replacement: string): Hunk[] {
  if (!Number.isInteger(base.start) || !Number.isInteger(base.end) || base.start < 0 || base.end > base.text.length
    || base.start >= base.end || [base.start, base.end].some((offset) => /[\uD800-\uDBFF]/.test(base.text.charAt(offset - 1))
      && /[\uDC00-\uDFFF]/.test(base.text.charAt(offset)))) throw new VantaError('Select a nonempty, valid code range.');
  if (Buffer.from(replacement).toString('utf8') !== replacement || /[\0\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(replacement)) {
    throw new VantaError('Replacement contains invalid text.');
  }
  const text = replacement.replace(/\r\n?|\n/g, base.eol);
  const changes = diffLines(base.text.slice(base.start, base.end), text, { timeout: 250, maxEditLength: 2000 });
  if (!changes) throw new VantaError('The proposed change exceeds the diff limit.');
  let cursor = base.start;
  let group: Hunk | undefined;
  const hunks: Hunk[] = [];
  for (const change of changes) {
    if (!change.added && !change.removed) { cursor += change.value.length; group = undefined; continue; }
    if (!group) {
      group = { id: hunks.length + 1, status: 'pending', start: cursor, end: cursor, replacement: '' };
      hunks.push(group);
    }
    if (change.removed) { cursor += change.value.length; group.end = cursor; }
    else group.replacement += change.value;
  }
  if (!hunks.length || hunks.length > 60) throw new VantaError('The proposal must contain 1 to 60 changed hunks.');
  return hunks;
}

export function applyHunks(base: BaseSelection, hunks: readonly HunkEdit[]): string {
  let cursor = 0;
  let previousStart = -1;
  const parts: string[] = [];
  for (const hunk of hunks) {
    if (!Number.isInteger(hunk.start) || !Number.isInteger(hunk.end) || hunk.start <= previousStart
      || hunk.start < Math.max(base.start, cursor) || hunk.end < hunk.start || hunk.end > base.end) {
      throw new VantaError('Proposal contains overlapping or out-of-range changes.');
    }
    parts.push(base.text.slice(cursor, hunk.start), hunk.replacement);
    cursor = hunk.end;
    previousStart = hunk.start;
  }
  return parts.join('') + base.text.slice(cursor);
}

export class QuickPatch {
  readonly id = randomUUID();
  readonly baseDigest: string;
  readonly hunks: Hunk[];
  #grant?: ReviewReceipt;
  #receipt?: ReviewReceipt;
  #spent = false;

  constructor(readonly base: BaseSelection, readonly explanation: string, replacement: string) {
    this.baseDigest = fingerprint(base.text);
    this.hunks = createHunks(base, replacement);
  }

  decide(id: number, status: Hunk['status']) {
    const hunk = this.hunks.find((entry) => entry.id === id);
    if (hunk && !this.#grant && !this.#spent) hunk.status = status;
  }

  authorize(): ReviewReceipt {
    if (this.#grant || this.#spent) throw new VantaError('This proposal is already sealed.');
    const accepted = this.hunks.filter((hunk) => hunk.status === 'accepted');
    if (!accepted.length || this.hunks.some((hunk) => hunk.status === 'pending')) throw new VantaError('Review all hunks before applying.');
    this.#grant = { proposalId: this.id, accepted: accepted.map((hunk) => hunk.id), digest: fingerprint(applyHunks(this.base, accepted)) };
    return this.#grant;
  }

  consume(id: string): ReviewReceipt {
    if (this.#spent || !this.#grant || this.#grant.proposalId !== id) throw new VantaError('This proposal has no matching local review authorization.');
    this.#spent = true;
    this.#receipt = this.#grant;
    return this.#receipt;
  }

  claim(receipt: ReviewReceipt): HunkEdit[] {
    if (this.#receipt !== receipt) throw new VantaError('Quick Edit is missing its matching approval receipt.');
    this.#receipt = undefined;
    const hunks = this.hunks.filter((hunk) => receipt.accepted.includes(hunk.id));
    if (fingerprint(applyHunks(this.base, hunks)) !== receipt.digest) throw new VantaError('The reviewed changes no longer match the receipt.');
    return hunks;
  }

  revoke() { this.#spent = true; this.#grant = undefined; this.#receipt = undefined; }
}
