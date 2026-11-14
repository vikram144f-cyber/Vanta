import { Buffer } from 'node:buffer';
import { VantaError } from './trueforge';
import type { Location, Repository, SourceFile, SymbolLocation } from './repository';

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

interface Snippet extends Location { text: string; source: SourceFile['source'] }
interface Candidate extends ContextHit { score: number; file: SourceFile }

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

  constructor(readonly repository: Repository, readonly budget: number, private readonly publish: (report: ContextReport) => void,
    private readonly agentMode = false) {}

  #emit(operation: string, hits: ContextHit[], items: unknown[], limit: number, limited = false, backend?: string) {
    const output: unknown[] = [];
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
    return context.items;
  }

  async bundle(query: string, signal: AbortSignal) {
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
    const representatives = ['code', 'test', 'docs'].map((kind) => ranked.find((hit) => group(hit.path) === kind)).filter((hit) => !!hit);
    const fresh = [...new Set([...representatives, ...ranked])].filter((hit) => !(this.#seen.get(hit.path) ?? [])
      .some((sent) => sent.start <= hit.end && sent.end >= hit.start));
    const top = fresh.slice(0, 12);
    const hits: ContextHit[] = top.map(({ path, start, end, reason, symbol, selected }) => ({ path, start, end, reason, symbol, selected }));
    const payload = top.map((hit) => ({ ...snippet(hit.path, hit.file, hit.start, hit.end), reason: hit.reason, symbol: hit.symbol }));
    const output = this.#emit('Context bundle', hits, payload, Math.floor(this.budget * (this.agentMode ? 0.24 : 0.6)), limited || fresh.length > top.length, backend);
    for (const hit of hits.filter((item) => item.selected)) this.#seen.set(hit.path, [...(this.#seen.get(hit.path) ?? []), hit]);
    return output;
  }
}
