import { Buffer } from 'node:buffer';
import { VantaError } from './trueforge';
import type { Location, Repository, SourceFile, SymbolLocation } from './repository';
import { rstHeadings } from './rst';
import { pythonBoundaries } from './verification';
import type { PythonBoundary, PythonExcerpt } from './verification';

export const contextTools = ['list_workspace_files', 'search_workspace', 'read_file', 'find_symbol', 'get_context_bundle'] as const;
const stopWords = new Set('about add and are built code could definition does explain file files find for from function get have how into likely me modify need new of parts probably related repository responsible should show tell that the their them this use want what where which with would'.split(' '));
const maxCandidateFiles = 260;
export const defaultBudget = 8000;

export interface ContextHit extends Location {
  reason: string;
  symbol?: string;
  selected: boolean;
}

export interface ContextReport {
  operation: string;
  hits: ContextHit[];
  estimatedTokens: number;
  budget: number;
  omitted: number;
  limited: boolean;
  backend?: string;
}

type SourceBlock = Pick<Location, 'start' | 'end'> & { text: string };
export interface Snippet extends Location {
  text: string;
  source: SourceFile['source'];
  pythonBoundary?: PythonBoundary;
  continuation?: SourceBlock[];
}
type RangeResult = Location & { requestedEnd: number; status: 'returned' | 'already_shared' | 'budget_skipped' | 'unavailable'; error?: string };
interface Candidate extends ContextHit { score: number; file: SourceFile; continuation?: SourceBlock[] }
const registration = /\.(?:add|register|include|mount)(?:_[a-z]+)?\s*\(/i;
const registrationTarget = /\.(?:add|register|include|mount)(?:_[a-z]+)?\s*\(\s*([\w$]+)\s*[,)]/i;
const commandDecorator = /^@[\w.]+\.command\(\s*['"]([\w-]+)['"]/;
const commandInvocation = /\b\w+\.invoke\(\s*[\w.]+\s*,\s*\[\s*(?:['"]([\w-]+)['"])?/;

function documentedEntryPoints(candidate: Candidate, implementation: Candidate) {
  if (!/\.rst$/i.test(candidate.path)) return [];
  const names = new Set(implementation.file.lines.flatMap((line) => {
    const name = registrationTarget.exec(line)?.[1];
    return name ? [name] : [];
  }));
  if (!names.size) return [];
  const lines = candidate.file.lines;
  const headings = rstHeadings(lines);
  return headings.flatMap((heading, index): Candidate[] => {
    const end = Math.min((headings[index + 1]?.start ?? lines.length + 1) - 1, heading.end + 14);
    const namesInSection = lines.slice(heading.end, end).join('\n').match(/[\w$]+/g) ?? [];
    const symbol = namesInSection.find((name) => names.has(name));
    if (!symbol) return [];
    const next = headings.slice(index + 1).find((section) => section.level <= heading.level);
    // A label introducing the next heading must stay with that heading.
    const label = next && [next.start - 1, next.start - 2].find((line) => /^\.\. _[^:]+: *$/.test(lines[line - 1] ?? ''));
    const boundary = label ?? next?.start;
    const continuation = next && boundary !== undefined && boundary > end + 1
      ? [snippet(candidate.path, candidate.file, boundary, next.end)] : undefined;
    return [{ ...candidate, start: heading.start, end: next && !continuation ? next.end : end, symbol, continuation,
      reason: `Existing documentation section for registered ${symbol}`
        + (boundary === undefined ? '' : ` · next peer or enclosing section starts at line ${boundary}`) }];
  }).slice(-2).reverse();
}

const codeTokens = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u);
const generalTerms = new Set('must using used value values type types test tests command commands default defaults error'.split(' '));
const sourceLanguage = /\.(?:py[wi]?|[cm]?[jt]sx?)$/i;
const mappingDeclaration = /^\s*(?:(?:export|const|let|var|static|readonly|public|private)\s+)*([\w$]+)\s*(?::[^=]+)?=\s*(?:\{|[\w.]+\()/;
const validationError = /^\s*(?:raise\s+|throw\s+(?:new\s+)?)(?:TypeError|ValueError|RangeError|ValidationError)\s*\(/;
const typeCheck = /\b(?:isinstance\s*\(|typeof\b|instanceof\b|Array\.isArray\s*\(|Number\.is\w+\s*\()/;

function relatedBehavior(files: ReadonlyMap<string, SourceFile>, implementation: Candidate, query: string): Candidate[] {
  if (!sourceLanguage.test(implementation.path)) return [];
  const directory = implementation.path.slice(0, implementation.path.lastIndexOf('/') + 1);
  const topics = new Set(codeTokens(query).filter((word) => word.length >= 4 && !stopWords.has(word) && !generalTerms.has(word)));
  const topicList = [...topics];
  if (!topicList.length) return [];
  const matches = (text: string) => new Set(codeTokens(text).filter((word) => topics.has(word))).size;
  const defaults: Candidate[] = [];
  const validations: Candidate[] = [];
  for (const [path, file] of files) {
    if (!path.startsWith(directory) || !sourceLanguage.test(path) || /(?:^|\/)(?:tests?|docs?)\//i.test(path)) continue;
    const pathScore = matches(path);
    for (const [index, line] of file.lines.entries()) {
      const name = mappingDeclaration.exec(line)?.[1] ?? '';
      const parts = codeTokens(name);
      if (parts.includes('default') || parts.includes('defaults')) {
        const nameScore = parts.filter((part) => part.length >= 4 && !generalTerms.has(part)
          && topicList.some((topic) => topic.startsWith(part) || part.startsWith(topic))).length;
        const matchesModule = parts.every((part) => generalTerms.has(part)) && matches(path.split('/').at(-1) ?? '') > 0;
        const end = Math.min(file.lines.length, index + 13);
        if (nameScore || matchesModule) defaults.push({ path, file, start: index + 1, end,
          score: nameScore * 3 + pathScore, selected: false, reason: 'Related runtime defaults' });
      }
      const errorScore = validationError.test(line) ? matches(line) : 0;
      if (errorScore) {
        const start = Math.max(1, index - 12);
        const checksValueTypes = file.lines.slice(start - 1, index).some((source) => typeCheck.test(source));
        validations.push({ path, file, start, end: index + 1, score: errorScore * 3 + pathScore + Number(checksValueTypes),
          selected: false, reason: 'Related validation or type handling' });
      }
    }
  }
  return [rank(defaults)[0], rank(validations)[0]].filter((hit) => !!hit);
}

function terms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]{2,64}/gu) ?? [])
    .filter((word) => !stopWords.has(word)))].slice(0, 20);
}

function rank(hits: Candidate[]) {
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en') || a.start - b.start);
}

function snippet(path: string, file: SourceFile, start: number, end: number): Snippet {
  if (start > file.lines.length) throw new VantaError('Requested line is past the end of the file.');
  const slice = file.lines.slice(start - 1, Math.min(end, start + 59));
  return { path, start, end: start + slice.length - 1, text: slice.join('\n'), source: file.source };
}

function boundaryExcerpt(excerpt: Snippet, file: SourceFile, boundary: PythonBoundary, maxLines: number): Snippet {
  const lines = new Set<number>([boundary.start]);
  for (let line = Math.max(excerpt.start, boundary.start, boundary.end - 2); line <= boundary.end; line++) lines.add(line);
  if (boundary.nextStart !== undefined) lines.add(boundary.nextStart);
  if (boundary.nextDeclaration !== undefined) lines.add(boundary.nextDeclaration);
  for (let line = excerpt.start; line <= excerpt.end && lines.size < maxLines; line++) lines.add(line);
  const blocks: Pick<Location, 'start' | 'end'>[] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const previous = blocks.at(-1);
    if (previous?.end === line - 1) previous.end = line;
    else blocks.push({ start: line, end: line });
  }
  const [head, ...continuation] = blocks.map(({ start, end }) => ({ start, end, text: file.lines.slice(start - 1, end).join('\n') }));
  return { ...excerpt, ...head, pythonBoundary: boundary, ...(continuation.length ? { continuation } : {}) };
}

function hasSharedSource(excerpt: Snippet, lines: Map<number, string>) {
  return [excerpt, ...excerpt.continuation ?? []].every(({ start, text }) =>
    text.split('\n').every((line, index) => lines.get(start + index) === line));
}

// Charge the complete serialized payload. Bytes / 3 is a sizing heuristic, not provider usage.
export function estimateContext(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3);
}

function declarations(file: SourceFile, path: string): SymbolLocation[] {
  const found: SymbolLocation[] = [];
  const python = /\.pyi?$/i.test(path);
  const script = /\.[cm]?[jt]sx?$/i.test(path);
  for (const [line, text] of file.lines.entries()) {
    const match = python ? /^\s*(?:async\s+)?(def|class)\s+([\p{L}_][\p{L}\p{N}_]*)\b/u.exec(text)
      : script ? /^\s*(?:(?:export|default|declare|async|abstract)\s+)*(function\s*\*?|class)\s+([\w$]+)/.exec(text)
        : null;
    const name = match?.[2];
    if (name) found.push({ path, start: line + 1, end: line + 1, name,
      kind: match[1] === 'class' ? 'class' : 'function', source: 'declaration match' });
  }
  return found;
}

export type Mention = { kind: 'file' | 'symbol'; value: string };

export function parseMentions(prompt: string): Mention[] {
  const matches = [...prompt.matchAll(/(?:^|[\s(])@(file|symbol):(?:"([^"\r\n]+)"(?=$|[\s)]|[,;])|([^\s"()]+))?/g)];
  if (matches.length > 8) throw new VantaError('Use up to eight references per message.');
  return matches.map((match) => {
    const value = match[2] ?? match[3]?.replace(/[.,;!?]+$/, '');
    if (!value || value.length > 480) throw new VantaError('Use @file:path or @symbol:name, with quotes around references containing spaces.');
    return { kind: match[1] === 'file' ? 'file' : 'symbol', value };
  });
}

export class ContextEngine {
  #spent = 0;
  readonly #seen = new Map<string, Location[]>();
  readonly #sharedLines = new Map<string, Map<number, string>>();

  constructor(readonly repository: Repository, readonly budget: number, private readonly publish: (report: ContextReport) => void,
    private readonly agentMode = false, private readonly python?: string, private initialTask?: string) {}

  get remainingTokens() { return Math.max(0, this.budget - this.#spent); }

  #emit<T>(operation: string, hits: ContextHit[], items: T[], limit: number, limited = false, backend?: string) {
    const output: T[] = [];
    let omitted = 0;
    const remaining = Math.min(limit, this.budget - this.#spent);
    const payload = (entries: unknown[]) => ({ items: entries, limited, totalBudget: this.budget });
    for (const [index, item] of items.entries()) {
      const hit = hits[index];
      if (estimateContext(payload([...output, item])) + 32 > remaining) { omitted++; continue; }
      output.push(item);
      if (hit) hit.selected = true;
    }
    if (output.length) this.#spent += estimateContext(payload(output)) + 32;
    this.publish({ operation, hits, estimatedTokens: this.#spent, budget: this.budget, omitted, limited, backend });
    return { items: output, omitted, limited, estimatedTokens: this.#spent, totalBudget: this.budget };
  }

  async #sources(query: string, signal: AbortSignal) {
    const catalog = await this.repository.catalog(signal);
    const words = terms(query);
    const pathScore = (name: string) => words.filter((word) => name.toLowerCase().includes(word)).length;
    const paths = [...catalog.paths].sort((a, b) => pathScore(b) - pathScore(a) || a.length - b.length || a.localeCompare(b, 'en'));
    const files = new Map<string, SourceFile>();
    for (let i = 0; i < Math.min(paths.length, maxCandidateFiles); i += 8) {
      const batch = paths.slice(i, Math.min(i + 8, maxCandidateFiles));
      const reads = await Promise.all(batch.map(async (path) => {
        try { return await this.repository.read(path, signal); } catch { signal.throwIfAborted(); return undefined; }
      }));
      reads.forEach((file, index) => { const path = batch[index]; if (file && path) files.set(path, file); });
    }
    return { files, limited: catalog.truncated || paths.length > maxCandidateFiles, backend: catalog.backend };
  }

  async list(query: string, signal: AbortSignal) {
    const { paths, truncated, backend } = await this.repository.catalog(signal);
    const matches = paths.filter((path) => path.toLowerCase().includes(query.toLowerCase()));
    const hits = matches.slice(0, 35).map((path) => ({ path, start: 1, end: 1, reason: 'Filename match', selected: false }));
    return this.#emit('Files', hits, hits.map(({ path }) => ({ path })), 1200, truncated || matches.length > 35, backend);
  }

  async search(query: string, signal: AbortSignal) {
    const { files, limited, backend } = await this.#sources(query, signal);
    const hits: ContextHit[] = [];
    const needle = query.toLowerCase();
    for (const [path, file] of files) {
      if (path.toLowerCase().includes(needle)) hits.push({ path, start: 1, end: 1, reason: 'Filename match', selected: false });
      let fileHits = 0;
      for (const [index, line] of file.lines.entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        hits.push({ path, start: index + 1, end: index + 1, reason: 'Literal text match', selected: false });
        if (++fileHits >= 3) break;
      }
    }
    const top = hits.slice(0, this.agentMode ? 12 : 30);
    return this.#emit('Search', top, top.map(({ path, start, end, reason }) => ({ path, start, end, reason,
      ...(this.agentMode && reason === 'Literal text match' ? { text: files.get(path)?.lines[start - 1]?.slice(0, 260) } : {}) })),
    1600, limited || hits.length > top.length, backend);
  }

  async #symbols(query: string, path: string | undefined, signal: AbortSignal) {
    const provided = await this.repository.providerSymbols(query, path, signal);
    const needle = query.toLowerCase();
    let limited = false;
    let backend: string | undefined;
    const files = new Map<string, SourceFile>();
    if (path) files.set(path, await this.repository.read(path, signal));
    else {
      const source = await this.#sources(query, signal);
      limited = source.limited;
      backend = source.backend;
      for (const [name, file] of source.files) files.set(name, file);
    }
    const symbols = new Map<string, SymbolLocation>();
    for (const symbol of [...provided, ...[...files].flatMap(([name, file]) => declarations(file, name))]) {
      if (!symbol.name.toLowerCase().includes(needle)) continue;
      const id = `${symbol.path}:${symbol.start}:${symbol.name}`;
      if (!symbols.has(id)) symbols.set(id, symbol);
    }
    const matches = [...symbols.values()].sort((a, b) => Number(b.name === query) - Number(a.name === query)
      || a.path.localeCompare(b.path, 'en') || a.start - b.start);
    return { matches, limited, backend };
  }

  async symbols(query: string, path: string | undefined, signal: AbortSignal) {
    const { matches, limited, backend } = await this.#symbols(query, path, signal);
    if (!matches.length) throw new VantaError('No matching symbol declarations found within the search limit.');
    const top = matches.slice(0, 24);
    const hits = top.map((item) => ({ ...item, symbol: item.name, reason: `${item.kind} · ${item.source}`, selected: false }));
    return this.#emit('Symbols', hits, top, 1600, limited || matches.length > top.length, backend);
  }

  async read(path: string, start: number, end: number, signal: AbortSignal) {
    const file = await this.repository.read(path, signal);
    const excerpt = snippet(path, file, start, end);
    return this.#emit('Open file', [{ path, start, end: excerpt.end, reason: `Requested range · ${file.source}`, selected: false }], [excerpt], 2200);
  }

  async #withPythonBoundaries<T extends Snippet>(
    items: readonly { excerpt: T; file: SourceFile; maxLines: number; includeSetup?: boolean }[], signal: AbortSignal,
  ) {
    const python = this.python;
    if (!this.agentMode || !python) return items.map(({ excerpt }) => excerpt);
    const sources = new Map<SourceFile, PythonExcerpt[]>();
    for (const [index, { excerpt, file, maxLines, includeSetup }] of items.entries()) {
      if (maxLines < 6 || !/\.py[wi]?$/i.test(excerpt.path)) continue;
      const ranges = sources.get(file) ?? [];
      ranges.push([index, excerpt.start, excerpt.end, !!includeSetup]);
      sources.set(file, ranges);
    }
    const bounds = await pythonBoundaries(python, [...sources].map(([file, ranges]) => [file.lines.join('\n'), ranges]), signal)
      .catch(() => { signal.throwIfAborted(); return {} as Record<number, PythonBoundary>; });
    return items.map(({ excerpt, file, maxLines }, index) => {
      const boundary = bounds[index];
      return boundary ? { ...excerpt, ...boundaryExcerpt(excerpt, file, boundary, maxLines) } : excerpt;
    });
  }

  #remember(excerpts: readonly Snippet[]) {
    if (!this.agentMode) return;
    for (const excerpt of excerpts) {
      const lines = this.#sharedLines.get(excerpt.path) ?? new Map<number, string>();
      for (const { start, text } of [excerpt, ...excerpt.continuation ?? []]) {
        text.split('\n').forEach((line, index) => lines.set(start + index, line));
      }
      this.#sharedLines.set(excerpt.path, lines);
    }
  }

  async readRanges(ranges: readonly Location[], maxLines: number, signal: AbortSignal) {
    const results: RangeResult[] = [];
    const items: Snippet[] = [];
    for (const { path, start, end: requestedEnd } of ranges) {
      const end = Math.min(requestedEnd, start + maxLines - 1);
      const result: RangeResult = { path, start, end, requestedEnd, status: 'unavailable' };
      results.push(result);
      try {
        if (end < start) throw new VantaError('End line must be at or after the start line.');
        const file = await this.repository.read(path, signal);
        const original = snippet(path, file, start, end);
        const [excerpt = original] = await this.#withPythonBoundaries([{ excerpt: original, file, maxLines }], signal);
        result.end = excerpt.end;
        const shared = this.#sharedLines.get(path);
        if (shared && hasSharedSource(excerpt, shared)) {
          result.status = 'already_shared';
          continue;
        }
        const hit = { path, start, end: excerpt.end, reason: `Requested range · ${file.source}`, selected: false };
        const output = this.#emit('Open file', [hit], [excerpt], 2200);
        result.status = output.items.length ? 'returned' : 'budget_skipped';
        items.push(...output.items);
        this.#remember(output.items);
      } catch (error) {
        signal.throwIfAborted();
        result.error = error instanceof VantaError ? error.message : 'Could not read this range.';
      }
    }
    return { ranges: results, items, remainingTokens: this.remainingTokens };
  }

  async mentions(references: Mention[], signal: AbortSignal) {
    const resolved: { excerpt: Snippet; hit: ContextHit }[] = [];
    for (const ref of references) {
      let path = ref.value;
      let start = 1;
      let end = 24;
      let symbol: string | undefined;
      if (ref.kind === 'symbol') {
        const separator = ref.value.lastIndexOf('#');
        const name = ref.value.slice(separator + 1);
        const scope = separator < 0 ? undefined : ref.value.slice(0, separator);
        if (!/^[\p{L}_$][\p{L}\p{N}_$]{0,95}$/u.test(name) || scope === '') throw new VantaError('Use @symbol:name or @symbol:path#name.');
        const { matches, limited } = await this.#symbols(name, scope, signal);
        const exact = matches.filter((item) => item.name === name);
        const match = exact[0];
        if (!match) throw new VantaError('Referenced symbol was not found. Use a file-scoped reference to search a specific file.');
        if (exact.length !== 1 || (!scope && limited)) throw new VantaError('Symbol is ambiguous or the search was limited. Use @symbol:path#name.');
        path = match.path; start = match.start; end = Math.max(match.end, start + 12); symbol = match.name;
      }
      let file: SourceFile;
      try { file = await this.repository.read(path, signal); }
      catch { signal.throwIfAborted(); throw new VantaError('Referenced file is missing, ignored, or outside the readable workspace.'); }
      const excerpt = snippet(path, file, start, end);
      const overlapping = resolved.filter(({ hit }) => hit.path === path && hit.start <= excerpt.end && hit.end >= start);
      const first = Math.min(start, ...overlapping.map(({ hit }) => hit.start));
      const last = Math.max(excerpt.end, ...overlapping.map(({ hit }) => hit.end));
      if (overlapping.length && last - first < 60) {
        for (const item of overlapping) resolved.splice(resolved.indexOf(item), 1);
        const reasons = new Set([...overlapping.flatMap(({ hit }) => hit.reason.split(' · ')), `Explicit @${ref.kind}`]);
        resolved.push({ excerpt: snippet(path, file, first, last), hit: {
          path, start: first, end: last, reason: [...reasons].join(' · '), symbol: symbol ?? overlapping[0]?.hit.symbol, selected: false,
        } });
      } else {
        resolved.push({ excerpt, hit: { path, start, end: excerpt.end, reason: `Explicit @${ref.kind}`, symbol, selected: false } });
      }
    }
    const context = this.#emit('Explicit references', resolved.map((entry) => entry.hit), resolved.map((entry) => entry.excerpt), Math.floor(this.budget / 2));
    if (context.omitted) throw new VantaError('Explicit references exceed the context budget. Reference fewer files or increase the budget.');
    this.#remember(context.items);
    return context.items;
  }

  async bundle(query: string, signal: AbortSignal) {
    if (this.initialTask && terms(this.initialTask).length) query = this.initialTask;
    this.initialTask = undefined;
    const words = terms(query);
    if (!words.length) throw new VantaError('Provide task terms to look up in the workspace.');
    const { files, limited, backend } = await this.#sources(query, signal);
    const candidates: Candidate[] = [];
    const symbols = await this.repository.providerSymbols(words[0]!, undefined, signal);
    for (const [path, file] of files) {
      const name = path.split('/').at(-1)!.toLowerCase();
      const filenameWords = name.split(/[^\p{L}\p{N}]+/u);
      const pathWords = words.filter((word) => filenameWords.includes(word) || (word.length >= 4 && name.includes(word)));
      const anchors = declarations(file, path).concat(symbols.filter((symbol) => symbol.path === path));
      let bestLine = 0;
      let bestCount = 0;
      for (const [index, text] of file.lines.entries()) {
        const lower = text.toLowerCase();
        const lineWords = new Set(lower.split(/[^\p{L}\p{N}_]+/u));
        const count = words.filter((word) => lineWords.has(word) || (word.length >= 4 && lower.includes(word))).length;
        if (count > bestCount) { bestLine = index; bestCount = count; }
      }
      const anchor = anchors.find((item) => words.includes(item.name.toLowerCase()));
      const score = pathWords.length * 10 + bestCount * 3 + (anchor ? 12 : 0);
      if (!score) continue;
      const start = this.agentMode ? Math.max(1, bestLine - 4) : anchor?.start ?? Math.max(1, bestLine - 4);
      const signals = [pathWords.length ? `filename matches ${pathWords.join(', ')}` : '',
        anchor ? `${anchor.source}: ${anchor.name}` : '', bestCount ? `task terms on line ${bestLine + 1}` : ''].filter(Boolean);
      candidates.push({ path, start, end: Math.min(file.lines.length, start + 22), file, score, reason: signals.join(' · '), symbol: anchor?.name, selected: false });
    }
    const seeds = rank(candidates).slice(0, 4);
    for (const seed of seeds) {
      const module = seed.path.split('/').at(-1)?.split('.')[0];
      if (!module || module.length < 3) continue;
      for (const candidate of candidates) {
        if (candidate.path === seed.path) continue;
        const related = /(^|\/)(?:tests?|docs?)(?:\/|$)/i.test(candidate.path) && candidate.path.toLowerCase().includes(module.toLowerCase());
        const imported = candidate.file.lines.some((line) => /^\s*(?:from|import|export)\b/.test(line)
          && line.match(/[\w]+/g)?.includes(module));
        if (related || imported) {
          candidate.score += 5;
          candidate.reason += related ? ` · related test/docs name for ${seed.path}` : ` · import text references ${module}`;
        }
      }
    }
    const ranked = rank(candidates);
    // Give distinct implementation, test and docs evidence a chance before similar secondary matches.
    const group = (path: string) => /(^|\/)tests?\//i.test(path) ? 'test' : /(^|\/)docs?\//i.test(path) ? 'docs' : 'code';
    const implementation = ranked.find((hit) => group(hit.path) === 'code');
    const implementationStem = implementation?.path.split('/').at(-1)?.split('.')[0]?.toLowerCase();
    const representatives = ['code', 'test', 'docs'].map((kind) => {
      const matches = ranked.filter((hit) => group(hit.path) === kind);
      if (!this.agentMode || kind === 'code' || !implementationStem || implementationStem.length < 3) return matches[0];
      // Keep a matching sibling ahead of docs or tests for a different candidate module.
      return matches.find((hit) => hit.path.split('/').at(-1)?.toLowerCase().split(/[^\p{L}\p{N}]+/u).includes(implementationStem)) ?? matches[0];
    }).filter((hit) => !!hit);
    const behavior = this.agentMode && implementation ? relatedBehavior(files, implementation, query) : [];
    if (this.agentMode) {
      const extra: Candidate[] = [];
      let peerCommand: string | undefined;
      let placedDocumentation: Candidate | undefined;
      const documentation = representatives.find((hit) => group(hit.path) === 'docs');
      if (implementation && documentation && /\b(?:docs?|document(?:ed|ation)?|guide|manual)\b/i.test(query)) {
        const [placement, peer] = documentedEntryPoints(documentation, implementation);
        if (placement) {
          representatives[representatives.indexOf(documentation)] = placement;
          placedDocumentation = placement;
        }
        if (peer) extra.push(peer);
      }
      for (const hit of representatives) {
        const kind = group(hit.path);
        const nearby = (index: number, reason: string, lines = 13) => {
          if (index < 0) return;
          const start = Math.max(1, index - 2);
          const end = Math.min(hit.file.lines.length, start + lines - 1);
          if (start >= hit.start && end <= hit.end) return;
          extra.push({ ...hit, start, end, reason, symbol: undefined });
        };
        if (kind === 'code') {
          const registrationLine = hit.file.lines.findIndex((line) => registration.test(line));
          nearby(registrationLine, 'Existing registration or entry point');
          const names = registrationLine < 0 ? [] : hit.file.lines.slice(registrationLine, registrationLine + 8).flatMap((line) => {
            const match = registrationTarget.exec(line);
            return match?.[1] ? [match[1]] : [];
          });
          const handlers = hit.file.lines.flatMap((line, index) =>
            /^(?:@[\w.]+(?:command|route|handler)|export\s+(?:default\s+)?(?:function|class))/i.test(line) ? [index] : []);
          const definitions = names.length ? declarations(hit.file, hit.path) : [];
          const registered = names.reverse().map((name) => definitions.find((definition) => definition.name === name)).find(Boolean);
          let handler = -1;
          if (registered) {
            handler = handlers.filter((index) => index < registered.start - 1 && index >= registered.start - 20).at(-1) ?? registered.start - 1;
          } else if (registrationLine >= 0 && handlers.length) {
            handler = handlers.reduce((nearest, index) => Math.abs(index - registrationLine) < Math.abs(nearest - registrationLine) ? index : nearest, handlers[0]!);
          } else {
            handler = handlers.find((index) => index + 1 >= hit.start) ?? handlers.at(-1) ?? -1;
          }
          peerCommand = commandDecorator.exec(hit.file.lines[handler] ?? '')?.[1];
          nearby(handler, 'Existing handler definition', 22);
        } else if (kind === 'test') {
          const tests = hit.file.lines.flatMap((line, index) => /^(?:async\s+)?def test_|^\s*(?:test|it|describe)\s*\(/.test(line) ? [index] : []);
          const test = tests.find((index) => index + 1 >= hit.start) ?? tests.at(-1) ?? -1;
          nearby(test, 'Existing test definition');
          if (/\b(?:cli|commands?)\b/i.test(query)) {
            const peer = peerCommand ? hit.file.lines.findIndex((line) => commandInvocation.exec(line)?.[1] === peerCommand) : -1;
            const invocation = peer >= 0 ? peer : hit.file.lines.findIndex((line) => commandInvocation.test(line));
            nearby(invocation, peer >= 0 ? 'Existing test invocation for the registered handler'
              : 'Existing test invocation: command entry point, arguments and assertions', 12);
          }
        } else if (hit !== placedDocumentation) {
          const headings = hit.file.lines.flatMap((line, index) => index > 2 && (
            /^#{2,4}\s+/.test(line) || (/^[-~=^]{3,}\s*$/.test(line) && !!hit.file.lines[index - 1]?.trim())
          ) ? [index] : []);
          nearby(headings.filter((index) => index + 1 < hit.start).at(-1) ?? -1, 'Existing documentation section');
          const next = headings.find((index) => index + 1 >= hit.start);
          nearby(next ?? -1, 'Existing documentation section');
        }
      }
      // Keep implementation, test, and documentation landmarks ahead of secondary matches.
      ranked.unshift(...extra, ...behavior);
    }
    const fresh = [...new Set([...representatives, ...ranked])].filter((hit) => !(this.#seen.get(hit.path) ?? [])
      .some((sent) => sent.start <= hit.end && sent.end >= hit.start));
    const top = fresh.slice(0, this.agentMode ? 9 + behavior.length : 12);
    const bounded = await this.#withPythonBoundaries<Snippet & { reason: string; symbol?: string }>(top.map((hit) => {
      const { path, file, start, end, reason, symbol, continuation } = hit;
      return { file, maxLines: behavior.includes(hit) ? 0 : end - start + 1,
        includeSetup: reason === 'Existing handler definition', excerpt: { ...snippet(path, file, start, end), reason, symbol, continuation } };
    }), signal);
    const payload = bounded.flatMap((item, index) => {
      const boundary = item.pythonBoundary;
      if (!boundary?.setup?.length) return [item];
      const { setup, ...pythonBoundary } = boundary;
      const { file, path } = top[index]!;
      const related = setup.map(({ name, declaration, start, end }) => {
        const tail = snippet(path, file, start, end);
        const excerpt = declaration < start ? { ...snippet(path, file, declaration, declaration), continuation: [tail] } : tail;
        return { ...excerpt, reason: 'Possible local handler setup', symbol: name };
      });
      return [{ ...item, pythonBoundary }, ...related];
    });
    const hits: ContextHit[] = payload.map(({ path, start, end, reason, symbol }) => ({ path, start, end, reason, symbol, selected: false }));
    const output = this.#emit('Context bundle', hits, payload, Math.floor(this.budget * (this.agentMode ? 0.46 : 0.6)), limited || fresh.length > top.length, backend);
    for (const hit of hits.filter((item) => item.selected)) this.#seen.set(hit.path, [...(this.#seen.get(hit.path) ?? []), hit]);
    this.#remember(output.items);
    return output;
  }
}
