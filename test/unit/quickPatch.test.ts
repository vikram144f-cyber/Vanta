import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, assertBase, assertDocumentationEvidence, createHunks, explicitlyRequestsDocumentation,
  fingerprint, proposalSchema, QuickPatch, reviewSchema } from '../../src/quickPatch';
import type { BaseSelection } from '../../src/quickPatch';

const before = 'before\r\nfirst 😀\r\nunchanged\r\nthird\r\nafter\r\n';
const base: BaseSelection = { path: 'source.py', version: 7, text: before,
  start: before.indexOf('first'), end: before.indexOf('after'), eol: '\r\n' };
const replacement = 'first edited 😀\nnew line\nunchanged\nthird edited\n';

test('documentation checks reject implicit and invented coverage before review', () => {
  const draft = new QuickPatch(base, 'Explain the mode', '// Normal mode is the default.\n');
  const omitted = { scenario: 'Missing or blank mode', outcome: 'Select normal mode.',
    documentation: { inputs: ['missing', 'blank'], quote: 'Normal mode is the default.' } };
  const invented = { ...omitted, documentation: { ...omitted.documentation, quote: 'Missing or blank mode selects normal mode.' } };
  assert.throws(() => assertDocumentationEvidence(draft, [{ scenario: 'Missing mode', outcome: 'Normal' }], true), /Provide a documentation quote/);
  assert.throws(() => assertDocumentationEvidence(draft, [omitted], true), /specific input words/);
  assert.throws(() => assertDocumentationEvidence(draft, [{
    scenario: 'When mode is not provided, use the default.', outcome: 'Select normal mode.',
    documentation: { inputs: ['default'], quote: 'Normal mode is the default.' },
  }], true), /the quote does not name that condition/);
  assert.throws(() => assertDocumentationEvidence(draft, [invented], true), /quote the actual wording/);
  const corrected = new QuickPatch(base, 'Name both cases', '// Missing or blank mode\n// selects normal mode.\n');
  assert.doesNotThrow(() => assertDocumentationEvidence(corrected, [
    { ...invented, documentation: { ...invented.documentation, quote: 'Missing or blank mode\n// selects normal mode.' } },
  ], true));
  assert.equal(explicitlyRequestsDocumentation('Change the default and update its documentation.'), true);
  assert.equal(explicitlyRequestsDocumentation('Fix the default without updating its documentation.'), false);
  assert.equal(explicitlyRequestsDocumentation("Change the default. Don't update the documentation."), false);
});

test('independent CRLF and Unicode hunks apply at original offsets', () => {
  const hunks = createHunks(base, replacement);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(base, hunks), 'before\r\nfirst edited 😀\r\nnew line\r\nunchanged\r\nthird edited\r\nafter\r\n');
  assert.equal(applyHunks(base, hunks.slice(1)), 'before\r\nfirst 😀\r\nunchanged\r\nthird edited\r\nafter\r\n');
  assert.equal(applyHunks(base, hunks.slice(0, 1)), 'before\r\nfirst edited 😀\r\nnew line\r\nunchanged\r\nthird\r\nafter\r\n');
});

test('validate scope, schema, overlap, Unicode boundaries and stale content', () => {
  assert.equal(proposalSchema.safeParse({ replacement, explanation: 'edit', path: '../elsewhere' }).success, false);
  assert.equal(reviewSchema.safeParse({ proposalId: 'incorrect' }).success, false);
  assert.throws(() => createHunks({ ...base, end: base.start }, replacement), /nonempty/);
  assert.throws(() => createHunks({ ...base, start: before.indexOf('😀') + 1 }, replacement), /valid/);
  assert.throws(() => createHunks(base, '\uD800'), /invalid text/);
  const hunks = createHunks(base, replacement);
  assert.throws(() => applyHunks(base, [hunks[0]!, hunks[0]!]), /overlapping/);
  assert.throws(() => applyHunks(base, [{ ...hunks[0]!, start: 0 }]), /out-of-range/);
  assert.throws(() => assertBase(base, base.version + 1, base.text), /stale/);
  assert.throws(() => assertBase(base, base.version, `${base.text}!`), /stale/);
});

test('review freezes exactly the accepted hunks and permits one bounded receipt and apply', () => {
  const patch = new QuickPatch(base, 'Edit lines', replacement);
  assert.throws(() => patch.consume(patch.id), /authorization/);
  patch.decide(1, 'rejected');
  assert.throws(() => patch.authorize(), /Review all/);
  patch.decide(2, 'accepted');
  const grant = patch.authorize();
  patch.decide(1, 'accepted');
  assert.throws(() => patch.consume('forged'), /authorization/);
  const receipt = patch.consume(patch.id);
  assert.deepEqual(receipt.accepted, [2]);
  assert.equal(receipt.digest, grant.digest);
  assert.throws(() => patch.consume(patch.id), /authorization/);
  assert.throws(() => patch.claim({ ...receipt }), /matching/);
  assert.equal(fingerprint(applyHunks(base, patch.claim(receipt))), receipt.digest);
  assert.throws(() => patch.claim(receipt), /matching/);
});

test('revoking a disputed or cancelled proposal retires its authorization', () => {
  const patch = new QuickPatch(base, 'Edit lines', replacement);
  patch.decide(1, 'accepted');
  patch.decide(2, 'rejected');
  const grant = patch.authorize();
  patch.revoke();
  assert.throws(() => patch.consume(patch.id), /authorization/);
  assert.throws(() => patch.claim(grant), /matching/);
});
