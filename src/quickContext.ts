import { estimateContext } from './context';
import type { BaseSelection } from './quickPatch';
import type { SymbolLocation } from './repository';
import { VantaError } from './trueforge';

interface SelectionRange {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export function quickEditEvidence(base: BaseSelection, language: string, range: SelectionRange, sourceLines: readonly string[],
  symbols: readonly SymbolLocation[], budget: number): string {
  const lines = base.text.split(/\r?\n/);
  const offsets = [0, ...Array.from(base.text.matchAll(/\r?\n/g), (match) => match.index + match[0].length)];
  const start = range.start.line - 1;
  const end = range.end.line - 1;
  const lastSelected = range.end.column === 1 ? end - 1 : end;
  const safe = (first: number, last: number) => {
    for (let line = first; line <= last; line++) {
      if (lines[line] === undefined || lines[line] !== sourceLines[line]) return false;
    }
    return true;
  };
  if (!safe(start, lastSelected)) throw new VantaError('The selected region includes unsupported text or a potential credential.');

  const before = (first: number) => safe(first, start) ? base.text.slice(offsets[first]!, base.start) : '';
  const after = (last: number) => safe(end, last) ? base.text.slice(base.end, offsets[last]! + lines[last]!.length) : '';
  const nearbyStart = Math.max(0, start - 10);
  const nearbyEnd = Math.min(lines.length - 1, end + 10);
  const overlapping = symbols.filter((symbol) => symbol.path === base.path && symbol.start <= lastSelected + 1 && symbol.end > start);
  const payload = { path: base.path, language, range, selected: base.text.slice(base.start, base.end), before: before(nearbyStart),
    after: after(nearbyEnd), symbols: overlapping.slice(0, 8) };
  const fits = () => estimateContext(payload) <= budget;
  if (!fits()) throw new VantaError('Select a smaller region to fit the Quick Edit context budget.');

  // For a partial selection, include more of the innermost function when safe and affordable.
  const enclosing = overlapping.filter((symbol) => (symbol.kind === 'function' || symbol.kind === 'method')
    && symbol.start <= start + 1 && symbol.end >= lastSelected + 1)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  if (enclosing) {
    const first = Math.max(0, start - 30, enclosing.start - 1);
    const last = Math.min(lines.length - 1, end + 30, enclosing.end - 1);
    for (const side of ['before', 'after'] as const) {
      const nearby = payload[side];
      const extended = side === 'before' && first < nearbyStart ? before(first)
        : side === 'after' && last > nearbyEnd ? after(last) : '';
      if (!extended) continue;
      payload[side] = extended;
      if (!fits()) payload[side] = nearby;
    }
  }
  return JSON.stringify(payload);
}
