import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateContext } from '../../src/context';
import { quickEditEvidence } from '../../src/quickContext';
import { redactSourceLines } from '../../src/repository';
import type { SymbolLocation } from '../../src/repository';

function fixture() {
  const eol = '\r\n';
  const path = 'formatting.py';
  const selected = '    """Format a title."""' + eol;
  const lines = [
    'def format_title(value, fallback="untitled"):',
    ...Array.from({ length: 14 }, (_, index) => `    # initial note ${index + 1}`),
    selected.trimEnd(),
    ...Array.from({ length: 13 }, (_, index) => `    # additional note ${index + 1}`),
    '    if value is None:',
    '        return fallback',
    '    return value.strip()',
    '',
    'def neighboring_function():',
    '    return "separate"',
  ];
  const text = lines.join(eol);
  const start = text.indexOf(selected);
  const base = { path, text, start, end: start + selected.length, version: 1, eol } as const;
  const range = { start: { line: 16, column: 1 }, end: { line: 17, column: 1 } };
  const symbol: SymbolLocation = { path, name: 'format_title', kind: 'function', start: 1, end: 32, source: 'language service' };
  return { base, range, symbol, lines, selected };
}

test('Quick Edit captures the containing function around a partial selection', () => {
  const { base, range, symbol, lines, selected } = fixture();
  const evidence = quickEditEvidence(base, 'python', range, lines, [symbol], 2000);
  const decoded = JSON.parse(evidence);
  assert.equal(decoded.selected, selected);
  assert.deepEqual(decoded.range, range);
  assert.equal(decoded.before, base.text.slice(0, base.start));
  assert.equal(decoded.after, lines.slice(16, 32).join(base.eol));
  assert.match(decoded.after, /if value is None:\r\n {8}return fallback/);
  assert.doesNotMatch(evidence, /neighboring_function/);
});

test('Quick Edit falls back to nearby context when more source exceeds the budget', () => {
  const { base, range, symbol, lines } = fixture();
  const nearby = { ...JSON.parse(quickEditEvidence(base, 'python', range, lines, [], 2000)), symbols: [symbol] };
  const budget = estimateContext(nearby);
  const evidence = quickEditEvidence(base, 'python', range, lines, [symbol], budget);
  const decoded = JSON.parse(evidence);
  assert.deepEqual(decoded, nearby);
  assert.ok(estimateContext(decoded) <= budget);
});

test('Quick Edit keeps ordinary context when a containing symbol is unavailable', () => {
  const { base, range, lines } = fixture();
  const decoded = JSON.parse(quickEditEvidence(base, 'python', range, lines, [], 2000));
  assert.equal(decoded.before, lines.slice(5, 15).join(base.eol) + base.eol);
  assert.equal(decoded.after, lines.slice(16, 27).join(base.eol));
  assert.deepEqual(decoded.symbols, []);
});

test('Quick Edit excludes redacted extended context and rejects a redacted selection', () => {
  const { base, range, symbol, lines } = fixture();
  lines[28] = '    password = "synthetic-credential"';
  const withRedactedNeighbor = { ...base, text: lines.join(base.eol) };
  const sourceLines = redactSourceLines(withRedactedNeighbor.text);
  const evidence = quickEditEvidence(withRedactedNeighbor, 'python', range, sourceLines, [symbol], 2000);
  assert.doesNotMatch(evidence, /synthetic-credential/);
  assert.equal(JSON.parse(evidence).after, lines.slice(16, 27).join(base.eol));
  sourceLines[15] = '[Potential credential redacted]';
  assert.throws(() => quickEditEvidence(withRedactedNeighbor, 'python', range, sourceLines, [symbol], 2000), /selected region/);
});
