import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ApprovedFile, StagedFile } from './agentPatch';
import { applyHunks } from './quickPatch';
import { safeRelativePath } from './repository';
import type { Repository } from './repository';
import { VantaError } from './trueforge';

// The base Python process owns the Windows Job. The cancellation marker reaches
// it even when the configured venv interpreter starts a Windows redirector.
const processBootstrap = String.raw`
import os, sys, threading, time
if os.name == 'nt':
    import ctypes as c
    from ctypes import wintypes as w
    class Basic(c.Structure):
        _fields_ = [('process_time', c.c_longlong), ('job_time', c.c_longlong),
                    ('flags', w.DWORD), ('min_ws', c.c_size_t), ('max_ws', c.c_size_t),
                    ('active', w.DWORD), ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
    class Extended(c.Structure):
        _fields_ = [('basic', Basic), ('io', c.c_ulonglong * 6), ('memory', c.c_size_t * 4)]
    k = c.WinDLL('kernel32', use_last_error=True)
    k.CreateJobObjectW.restype = w.HANDLE
    k.GetCurrentProcess.restype = w.HANDLE
    k.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
    k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    job = k.CreateJobObjectW(None, None)
    info = Extended()
    info.basic.flags = 0x2000
    if not job or not k.SetInformationJobObject(job, 9, c.byref(info), c.sizeof(info)) or not k.AssignProcessToJobObject(job, k.GetCurrentProcess()):
        sys.exit('VANTA could not attach the verification process to a Windows Job Object.')
def cancel_when_requested(path):
    while not os.path.exists(path):
        time.sleep(0.05)
    os._exit(124)
threading.Thread(target=cancel_when_requested, args=(sys.argv[1],), daemon=True).start()
`;

const pytestBootstrap = processBootstrap + String.raw`
import pytest
sys.argv = ['pytest', *sys.argv[2:]]
root = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(root, 'src'), root]
sys.exit(pytest.console_main())
`;

const syntaxBootstrap = processBootstrap + String.raw`
from pathlib import Path
failed = False
for name in sys.argv[2:]:
    try:
        compile(Path(name).read_bytes(), name, 'exec')
    except SyntaxError as error:
        print(f'{name}:{error.lineno or 1}:{error.offset or 1}: {type(error).__name__}: {error.msg}')
        failed = True
sys.exit(int(failed))
`;

const boundaryBootstrap = processBootstrap + String.raw`
import ast, json
from collections import defaultdict
from pathlib import Path

functions = (ast.FunctionDef, ast.AsyncFunctionDef)
def first_line(node):
    return min((item.lineno for item in getattr(node, 'decorator_list', [])), default=node.lineno)

def handler_setup(handler, body):
    local_functions = defaultdict(list)
    local_methods = defaultdict(list)
    for statement in body:
        if isinstance(statement, functions):
            local_functions[statement.name].append(statement)
        elif isinstance(statement, ast.ClassDef):
            for method in statement.body:
                if isinstance(method, functions):
                    local_methods[method.name].append(method)
    for decorator in reversed(handler.decorator_list):
        ref = decorator.func if isinstance(decorator, ast.Call) else decorator
        wrappers = local_functions.get(ref.id, []) if isinstance(ref, ast.Name) else []
        if len(wrappers) != 1:
            continue
        wrapper = wrappers[0]
        related = [wrapper]
        for call in sorted((node for node in ast.walk(wrapper) if isinstance(node, ast.Call)),
                           key=lambda node: (node.lineno, -node.col_offset)):
            ref = call.func
            if isinstance(ref, ast.Attribute):
                targets = local_methods.get(ref.attr, [])
            elif isinstance(ref, ast.Name):
                targets = local_functions.get(ref.id, [])
            else:
                continue
            if len(targets) == 1 and targets[0] not in (handler, wrapper):
                related.append(targets[0])
                break
        return [dict(name=node.name, declaration=node.lineno,
                     start=max(node.end_lineno - 11, node.lineno), end=node.end_lineno)
                for node in related]
    return []

result = {}
for source, excerpts in json.loads(Path('sources.json').read_text(encoding='utf-8')):
    try:
        body = ast.parse(source).body
    except (SyntaxError, ValueError, RecursionError):
        continue
    definitions = [(node, index, first_line(node)) for index, statement in enumerate(body)
                   for node in ast.walk(statement) if isinstance(node, functions)]
    for key, start, end, include_setup in excerpts:
        overlapping = [(node, index, first) for node, index, first in definitions
                       if first <= end and node.end_lineno >= start]
        if not overlapping:
            continue
        node, index, first = max(overlapping, key=lambda item: (item[0].end_lineno > end, item[2]))
        boundary = dict(start=first, end=node.end_lineno)
        if index + 1 < len(body):
            following = body[index + 1]
            boundary['nextStart'] = first_line(following)
            boundary['nextDeclaration'] = following.lineno
        if include_setup:
            setup = handler_setup(node, body)
            if setup:
                boundary['setup'] = setup
        result[key] = boundary
print(json.dumps(result))
`;

const stagingBootstrap = processBootstrap + String.raw`
import ast, json
from pathlib import Path

before, after, edits, suffix = json.loads(Path('source.json').read_text(encoding='utf-8'))
try:
    original = ast.parse(before).body
    candidate = ast.parse(after).body
except (SyntaxError, ValueError, RecursionError):
    sys.exit(0)

definitions = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
for line, first_unchanged, start, end in edits:
    if not any(isinstance(node, definitions) and start <= node.lineno <= end for node in candidate):
        continue
    for node in original:
        first = min((item.lineno for item in getattr(node, 'decorator_list', [])), default=node.lineno)
        if isinstance(node, definitions) and first < line <= first_unchanged <= node.end_lineno:
            print(f'The new top-level declaration splits an existing definition at original line {line}. '
                  f'Place it before line {first} or after line {node.end_lineno}, using a complete source boundary.')
            sys.exit(0)

if len(sys.argv) == 2:
    sys.exit(0)

import subprocess
from collections import Counter

def undefined_names(source):
    target = f'py{sys.version_info.major}{sys.version_info.minor}'
    result = subprocess.run([sys.argv[2], 'check', '--isolated', '--no-cache', '--select', 'F821',
                             '--target-version', target, '--output-format', 'json',
                             '--stdin-filename', 'staged' + suffix, '-'],
                            input=source.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode not in (0, 1):
        raise ValueError('Ruff could not check this file')
    lines = source.split('\n')
    for item in json.loads(result.stdout):
        if item['code'] == 'F821':
            row, column = item['location']['row'], item['location']['column']
            yield (item['message'], lines[row - 1].strip()), row, column

try:
    baseline = Counter(key for key, _, _ in undefined_names(before))
    reported = 0
    for key, row, column in undefined_names(after):
        if baseline[key]:
            baseline[key] -= 1
            continue
        print(f'Proposed line {row}:{column}: F821 {key[0][:240]}.')
        reported += 1
        if reported == 5:
            break
except (OSError, ValueError, KeyError, IndexError):
    sys.exit(2)
if reported:
    print('Fix the undefined names in this file and stage its complete edit set again.')
`;

export async function validatePythonStaging(python: string, { base, hunks }: StagedFile, signal: AbortSignal, ruff?: string) {
  const suffix = base.path.toLowerCase().match(/\.py[wi]?$/)?.[0];
  if (!suffix) return;
  const edits: [number, number, number, number][] = [];
  let shiftedLines = 0;
  for (const { start, end, replacement } of hunks) {
    const addedLines = replacement.split('\n').length - 1;
    const removedLines = base.text.slice(start, end).split('\n').length - 1;
    if (/^(?:async\s+def|def|class)\s/m.test(replacement)) {
      const line = base.text.slice(0, start).split('\n').length;
      const firstUnchanged = end < base.text.length ? line + removedLines : Number.MAX_SAFE_INTEGER;
      const endLine = line + shiftedLines + addedLines - Number(replacement.endsWith('\n'));
      edits.push([line, firstUnchanged, line + shiftedLines, endLine]);
    }
    shiftedLines += addedLines - removedLines;
  }
  if (!edits.length && !ruff) return;
  const snapshot = await mkdtemp(join(tmpdir(), 'vanta-python-staging-'));
  try {
    const script = join(snapshot, 'staging.py');
    const source = JSON.stringify([base.text, applyHunks(base, hunks), edits, suffix]);
    await writeFile(script, stagingBootstrap, { flag: 'wx' });
    await writeFile(join(snapshot, 'source.json'), source, { flag: 'wx' });
    const result = await execute(python, script, snapshot, ruff ? [ruff] : [], 'Python staging check', signal, 2_500, ['-S']);
    signal.throwIfAborted();
    if (ruff && result.status !== 'passed') throw new VantaError('The configured Ruff staging check could not finish. Check VANTA: Verification Ruff.');
    if (result.status !== 'passed') throw new VantaError('The Python structural staging check could not finish.');
    if (result.output.trim()) throw new VantaError(result.output.trim());
  } finally { await rm(snapshot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

export interface PythonBoundary {
  start: number;
  end: number;
  nextStart?: number;
  nextDeclaration?: number;
  setup?: readonly { name: string; declaration: number; start: number; end: number }[];
}

export type PythonExcerpt = [key: number, start: number, end: number, includeSetup: boolean];

// Parse the same redacted source that is eligible for context. Source code is never imported or run.
export async function pythonBoundaries(python: string, sources: readonly [string, readonly PythonExcerpt[]][],
  signal: AbortSignal): Promise<Record<number, PythonBoundary>> {
  if (!sources.length) return {};
  const snapshot = await mkdtemp(join(tmpdir(), 'vanta-python-context-'));
  try {
    const script = join(snapshot, 'boundaries.py');
    await writeFile(script, boundaryBootstrap, { flag: 'wx' });
    await writeFile(join(snapshot, 'sources.json'), JSON.stringify(sources), { flag: 'wx' });
    const result = await execute(python, script, snapshot, [], 'Python function boundaries', signal, 2_500, ['-S']);
    signal.throwIfAborted();
    return result.status === 'passed' ? JSON.parse(result.output) as Record<number, PythonBoundary> : {};
  } finally { await rm(snapshot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

export interface VerificationResult {
  command: string;
  exitCode: number | null;
  status: 'passed' | 'failed' | 'timed out' | 'cancelled';
  output: string;
}

export function verificationTarget(path: string) {
  return safeRelativePath(path) && /^(?:[\w-]+\/)*[\w.-]+\.py$/.test(path) && !path.startsWith('-');
}

async function resolveExecutable(path: string) {
  const executable = await realpath(path);
  const valid = (await lstat(executable)).isFile() && (process.platform !== 'win32' || /\.exe$/i.test(executable));
  return valid ? executable : undefined;
}

export async function verificationPython(path: string) {
  if (!isAbsolute(path)) throw new VantaError('Set VANTA: Verification Python to an absolute path in User Settings.');
  const executable = await resolveExecutable(path);
  if (!executable) throw new VantaError('The configured verification interpreter is unavailable.');
  return executable;
}

export async function verificationRuff(path: string) {
  const executable = isAbsolute(path) ? await resolveExecutable(path).catch(() => undefined) : undefined;
  if (!executable) throw new VantaError('Set VANTA: Verification Ruff to an absolute path to a trusted Ruff executable in User Settings.');
  return executable;
}

export function pytestCommand(target: string) { return `python -m pytest ${target} -q`; }

export async function checkPythonSyntax(python: string, files: readonly { path: string; text: string }[], signal: AbortSignal) {
  const sources = files.filter(({ path }) => /\.py[wi]?$/i.test(path));
  if (!sources.length) return;
  const snapshot = await mkdtemp(join(tmpdir(), 'vanta-syntax-'));
  try {
    for (const { path, text } of sources) {
      signal.throwIfAborted();
      if (!safeRelativePath(path)) throw new VantaError('Invalid staged Python path.');
      const dest = join(snapshot, ...path.split('/'));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, text, { flag: 'wx' });
    }
    const script = join(snapshot, '.vanta-syntax-check.py');
    await writeFile(script, syntaxBootstrap, { flag: 'wx' });
    return await execute(python, script, snapshot, sources.map(({ path }) => path), 'Python syntax check', signal, 10_000, ['-S']);
  } finally { await rm(snapshot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

export async function runPytest(repo: Repository, python: string, target: string, files: readonly ApprovedFile[], signal: AbortSignal,
  { timeout = 45_000, fixtures = [] }: { timeout?: number; fixtures?: readonly string[] } = {}): Promise<VerificationResult> {
  if (!verificationTarget(target)) throw new VantaError('Choose an existing relative Python test file.');
  await repo.location(target, signal);
  const snapshot = await mkdtemp(join(tmpdir(), 'vanta-verify-'));
  try {
    const overlay = new Map(files.map(({ base, after }) => [base.path, { before: base.text, after }]));
    let copiedTarget = false;
    await repo.snapshot(AbortSignal.any([signal, AbortSignal.timeout(20_000)]), async (path, text) => {
      const edit = overlay.get(path);
      if (edit && edit.before !== text) throw new VantaError(`Verification base changed for ${path}.`);
      const dest = join(snapshot, ...path.split('/'));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, edit?.after ?? text, { flag: 'wx' });
      overlay.delete(path);
      if (path === target) copiedTarget = true;
    }, fixtures);
    if (overlay.size || !copiedTarget) throw new VantaError('The approved files or test target are missing from the snapshot.');
    // The Windows venv launcher forwards a command line to its base Python.
    // Keep the bootstrap out of that command line so quote handling is identical.
    const script = join(snapshot, '.vanta-pytest.py');
    await writeFile(script, pytestBootstrap, { flag: 'wx' });
    return await execute(python, script, snapshot, [target, '-q'], pytestCommand(target), signal, timeout);
  } finally { await rm(snapshot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

function execute(python: string, script: string, cwd: string, args: string[], command: string, signal: AbortSignal, timeout: number,
  pythonOptions: string[] = []): Promise<VerificationResult> {
  signal.throwIfAborted();
  const windows = process.platform === 'win32';
  const env: NodeJS.ProcessEnv = { TEMP: cwd, TMP: cwd, TMPDIR: cwd, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' };
  if (windows) env.SystemRoot = process.env.SystemRoot;
  return new Promise((resolve, reject) => {
    const marker = join(cwd, '.vanta-cancel');
    const child = spawn(python, ['-I', '-B', '-u', '-X', 'utf8', ...pythonOptions, script, marker, ...args], { cwd, env, shell: false, windowsHide: true,
      detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped: 'timed out' | 'cancelled' | undefined;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: typeof stopped) => {
      if (stopped) return;
      stopped = reason;
      if (windows) {
        const killTree = () => {
          if (!child.pid || child.exitCode !== null) return;
          if (!env.SystemRoot) { child.kill(); return; }
          const terminator = spawn(join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)],
            { shell: false, windowsHide: true, stdio: 'ignore', env });
          terminator.once('error', () => { child.kill(); });
          terminator.once('exit', () => { if (child.exitCode === null) child.kill(); });
        };
        hardStop = setTimeout(killTree, 2500);
        void writeFile(marker, '', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') { clearTimeout(hardStop); killTree(); }
        });
      } else killGroup();
    };
    const killGroup = () => {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group already exited */ }
    };
    const cancel = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed out'), timeout);
    const dispose = () => { clearTimeout(timer); clearTimeout(hardStop); signal.removeEventListener('abort', cancel); };
    const collect = (chunk: Buffer) => {
      const max = 8192 - size;
      if (max > 0) chunks.push(chunk.subarray(0, max));
      size += chunk.length;
    };
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', () => { dispose(); reject(new VantaError('Could not start the configured Python interpreter.')); });
    child.once('exit', () => { if (!windows) killGroup(); });
    child.once('close', (exitCode) => {
      dispose();
      const raw = Buffer.concat(chunks).toString('utf8');
      const output = raw.replaceAll(cwd, '<verification snapshot>').replaceAll(python, '<configured Python>')
        .replace(/^.*(?:authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password|private key|\b(?:gh[pousr]_|sk-|AIza)[A-Za-z0-9_-]{12,}).*$/gim, '[Potential credential redacted]');
      resolve({ command, status: stopped ?? (exitCode === 0 ? 'passed' : 'failed'), exitCode,
        output: output + (size > 8192 ? '\n[Output truncated]' : '') });
    });
    if (signal.aborted) cancel();
  });
}
