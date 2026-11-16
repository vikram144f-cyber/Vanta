import { spawn } from 'node:child_process';
import { access, lstat, open, opendir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { VantaError } from './trueforge';
import { bindRoot, normalizeDrive } from './workspace';
import type { WorkspaceScope } from './workspace';

const excluded = /^(?:node_modules|vendor|dist|build|out|coverage|__pycache__|target|venv|env|credentials|secrets|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;
const sensitive = /credential|password|secret|(?:^|[_.-])token(?:[_.-]|$)|^id_(?:rsa|ed25519)|\.(?:pem|p12|pfx|key|keystore|kdbx)$/i;
const device = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const maxFiles = 1200;
export function normalizeWorkspacePath(path: string): string { return normalizeDrive(resolve(path)); }
export const maxFileBytes = 96 * 1024;

export interface Location { path: string; start: number; end: number }
export interface SymbolLocation extends Location { name: string; kind: string; source: 'language service' | 'declaration match' }
export interface SymbolProvider {
  find(query: string, path: string | undefined, signal: AbortSignal): Promise<SymbolLocation[]>;
}
export interface Catalog { paths: string[]; truncated: boolean; backend: 'ripgrep' | 'filesystem' }
export interface SourceFile { lines: string[]; source: 'disk' | 'editor buffer' }
export interface RepositoryOptions {
  ripgrep?: string | false;
  buffer?(absolute: string): string | undefined;
  symbols?: SymbolProvider;
}

export function safeRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 480 && path.split('/').every((segment) =>
    /^[\p{L}\p{N}_-][\p{L}\p{N}_ .@+()-]{0,119}$/u.test(segment) && !/[ .]$/.test(segment)
    && !excluded.test(segment) && !sensitive.test(segment) && !device.test(segment));
}

function childOf(root: string, absolute: string): boolean {
  const child = relative(root, absolute);
  return !!child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function findRipgrep(root: string): Promise<string | undefined> {
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    const executable = join(folder, process.platform === 'win32' ? 'rg.exe' : 'rg');
    try {
      const actual = await realpath(executable);
      if (childOf(root, executable) || childOf(root, actual)) continue;
      await access(actual, constants.X_OK);
      return actual;
    } catch { /* try the next PATH entry */ }
  }
  return undefined;
}

async function rgFiles(root: string, executable: string, signal: AbortSignal): Promise<{ paths: string[]; truncated: boolean } | undefined> {
  return new Promise((done, reject) => {
    const child = spawn(executable, ['--no-config', '--files', '--null', '--no-ignore-global', '--no-ignore-parent', '--no-ignore-exclude'], {
      cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 2500);
    const abort = () => { child.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      if (bytes + chunk.length > 512 * 1024) {
        truncated = true;
        child.kill();
        return;
      }
      if (truncated) return;
      chunks.push(chunk);
      bytes += chunk.length;
    });
    let unavailable = false;
    child.on('error', () => { unavailable = true; });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(signal.reason); return; }
      if (unavailable || timedOut || (!truncated && code !== 0 && code !== 1)) { done(undefined); return; }
      const paths = Buffer.concat(chunks).toString('utf8').split('\0');
      paths.pop();
      done({ paths: paths.map((path) => path.replaceAll('\\', '/')), truncated });
    });
  });
}

export class Repository {
  readonly #ignore = new Map<string, Promise<Ignore>>();
  #catalog?: Promise<Catalog>;

  private constructor(private readonly root: string, private readonly verify: () => Promise<void>, private readonly options: RepositoryOptions) {}

  static async bind(scope: WorkspaceScope, options: RepositoryOptions = {}): Promise<Repository> {
    const { root, verify } = await bindRoot(scope);
    return new Repository(root, verify, options);
  }

  async #checked(relativePath: string, signal: AbortSignal, directory = false, ignoreFile = false) {
    const segments = relativePath.split('/');
    if (!safeRelativePath(relativePath) && !(ignoreFile && segments.pop() === '.gitignore'
      && (!segments.length || safeRelativePath(segments.join('/'))))) throw new VantaError('Path is outside the workspace policy.');
    signal.throwIfAborted();
    await this.verify();
    const path = join(this.root, ...relativePath.split('/'));
    if (!childOf(this.root, path) || normalizeDrive(await realpath(path)) !== path) throw new VantaError('Linked or aliased paths are excluded.');
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      throw new VantaError('Only ordinary workspace entries are supported.');
    }
    return { path, info };
  }

  async #readBytes(path: string, signal: AbortSignal, limit: number, ignoreFile = false): Promise<string> {
    const before = await this.#checked(path, signal, false, ignoreFile);
    if (before.info.size > limit) throw new VantaError('File exceeds the supported read size.');
    const file = await open(before.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      const after = await this.#checked(path, signal, false, ignoreFile);
      if (!info.isFile() || info.nlink !== 1 || info.ino !== before.info.ino || info.dev !== before.info.dev
        || info.ino !== after.info.ino || info.dev !== after.info.dev) throw new VantaError('File changed during validation.');
      const bytes = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      await this.verify();
      signal.throwIfAborted();
      if (bytesRead > limit || bytes.subarray(0, bytesRead).includes(0)) throw new VantaError('File is too large or is binary.');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } finally { await file.close(); }
  }

  #ignoreRules(folder: string, signal: AbortSignal) {
    let rules = this.#ignore.get(folder);
    if (!rules) {
      rules = this.#readBytes(folder ? `${folder}/.gitignore` : '.gitignore', signal, 64 * 1024, true)
        .then((text) => ignore({ ignorecase: process.platform === 'win32' }).add(text), (error: unknown) => {
          signal.throwIfAborted();
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new VantaError('Could not safely read workspace ignore rules.');
          return ignore();
        });
      this.#ignore.set(folder, rules);
    }
    return rules;
  }

  async #ignored(path: string, directory: boolean, signal: AbortSignal): Promise<boolean> {
    const parts = path.split('/');
    // An ignored parent cannot be resurrected by rules in its children.
    for (let end = 1; end <= parts.length; end++) {
      const suffix = end < parts.length || directory ? '/' : '';
      let ignored = false;
      for (let start = 0; start < end; start++) {
        const rules = await this.#ignoreRules(parts.slice(0, start).join('/'), signal);
        const result = rules.test(parts.slice(start, end).join('/') + suffix);
        if (result.ignored || result.unignored) ignored = result.ignored;
      }
      if (ignored) return true;
    }
    return false;
  }

  async location(path: string, signal: AbortSignal): Promise<string> {
    const checked = await this.#checked(path, signal);
    if (await this.#ignored(path, false, signal)) throw new VantaError('File is ignored by this workspace.');
    return checked.path;
  }

  async diskText(path: string, signal: AbortSignal): Promise<string> {
    await this.location(path, signal);
    return this.#readBytes(path, signal, maxFileBytes);
  }

  async snapshot(signal: AbortSignal, copy: (path: string, text: string) => Promise<void>) {
    const catalog = await this.#collect(signal);
    if (catalog.truncated) throw new VantaError('This workspace exceeds the file limit for verification.');
    let size = 0;
    for (const path of catalog.paths) {
      signal.throwIfAborted();
      const checked = await this.#checked(path, signal);
      if (checked.info.size > maxFileBytes) continue;
      let text;
      try { text = await this.#readBytes(path, signal, maxFileBytes); }
      catch (error) {
        if (error instanceof TypeError || (error instanceof VantaError && error.message === 'File is too large or is binary.')) continue;
        throw error;
      }
      size += Buffer.byteLength(text);
      if (size > 16 * 1024 * 1024) throw new VantaError('The verification snapshot exceeds 16 MiB.');
      await copy(path, text);
    }
  }

  relative(absolute: string): string | undefined {
    const path = relative(this.root, absolute).split(sep).join('/');
    return safeRelativePath(path) ? path : undefined;
  }

  async read(path: string, signal: AbortSignal): Promise<SourceFile> {
    const absolute = await this.location(path, signal);
    const buffer = this.options.buffer?.(absolute);
    const text = buffer ?? await this.#readBytes(path, signal, maxFileBytes);
    await this.verify();
    signal.throwIfAborted();
    if (Buffer.byteLength(text) > maxFileBytes || text.includes('\0')) throw new VantaError('File is too large or is binary.');
    const lines = redactSourceLines(text);
    return { lines, source: buffer === undefined ? 'disk' : 'editor buffer' };
  }

  catalog(signal: AbortSignal) {
    this.#catalog ??= this.#collect(signal).catch((error: unknown) => {
      this.#catalog = undefined;
      throw error;
    });
    return this.#catalog;
  }

  async #collect(signal: AbortSignal): Promise<Catalog> {
    await this.verify();
    const executable = this.options.ripgrep === false ? undefined : this.options.ripgrep ?? await findRipgrep(this.root);
    signal.throwIfAborted();
    const rg = executable ? await rgFiles(this.root, executable, signal) : undefined;
    if (rg) {
      const paths: string[] = [];
      const candidates = rg.paths.filter(safeRelativePath).sort();
      for (const path of candidates.slice(0, maxFiles)) {
        signal.throwIfAborted();
        if (!await this.#ignored(path, false, signal)) paths.push(path);
      }
      return { paths: [...new Set(paths)], backend: 'ripgrep', truncated: rg.truncated || candidates.length > maxFiles };
    }
    const paths: string[] = [];
    const queue = [''];
    let entries = 0;
    while (queue.length && entries < 5000 && paths.length < maxFiles) {
      const folder = queue.shift()!;
      signal.throwIfAborted();
      const dir = folder ? (await this.#checked(folder, signal, true)).path : this.root;
      const children = [];
      for await (const entry of await opendir(dir)) {
        if (++entries > 5000) break;
        children.push(entry);
      }
      children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of children) {
        signal.throwIfAborted();
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (!safeRelativePath(path) || entry.isSymbolicLink() || await this.#ignored(path, entry.isDirectory(), signal)) continue;
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile() && paths.length < maxFiles) paths.push(path);
      }
    }
    return { paths: paths.sort(), backend: 'filesystem', truncated: queue.length > 0 || entries >= 5000 || paths.length >= maxFiles };
  }

  async providerSymbols(query: string, path: string | undefined, signal: AbortSignal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(900)]);
    const provider = this.options.symbols;
    if (!provider) return [];
    const results = await new Promise<SymbolLocation[]>((resolve) => {
      const finish = () => resolve([]);
      deadline.addEventListener('abort', finish, { once: true });
      if (deadline.aborted) { finish(); return; }
      void provider.find(query, path, deadline).then(resolve, finish).finally(() => deadline.removeEventListener('abort', finish));
    });
    signal.throwIfAborted();
    const checked: SymbolLocation[] = [];
    for (const result of results.slice(0, 60)) {
      if (path && result.path !== path) continue;
      try {
        const file = await this.read(result.path, deadline);
        if (result.start > 0 && result.start <= file.lines.length) checked.push({ ...result, end: Math.min(result.end, file.lines.length) });
      } catch { signal.throwIfAborted(); }
    }
    return checked;
  }
}

export function redactSourceLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/).map((line) =>
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["'][^"']{8,}|\b(?:gh[pousr]_|sk-[a-z]|AIza)[A-Za-z0-9_-]{16,}/i.test(line)
      ? '[Potential credential redacted]' : line);
}
