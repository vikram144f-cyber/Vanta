import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContextEngine, parseMentions } from '../../src/context';
import type { ContextReport } from '../../src/context';
import { Repository } from '../../src/repository';

test('scoped repository discovery, symbols, mentions and budget', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'vanta-context-'));
  const root = join(folder, 'repo');
  const signal = new AbortController().signal;
  try {
    for (const path of ['src', 'tests', 'docs', 'scratch', 'node_modules']) await mkdir(join(root, path), { recursive: true });
    const files: Record<string, string> = {
      '.gitignore': 'scratch/\n*.tmp\n', 'src/.gitignore': 'ignored.py\n',
      'src/router.py': 'class Router:\n    def publish(self):\n        return "route publish"\n\ndef publish_preview():\n    pass\n',
      'tests/test_router.py': 'from app.router import Router\ndef publish():\n    assert Router().publish()\n',
      'docs/router.md': '# Router publish commands\n', 'src/ignored.py': 'ignored', 'scratch/route.py': 'ignored',
      'node_modules/route.js': 'excluded', 'src/route.tmp': 'ignored', 'src/private.pem': 'sensitive fixture',
      'src/settings.py': 'api_key = "synthetic-credential"\nordinary = True\n',
    };
    for (const [path, body] of Object.entries(files)) await writeFile(join(root, path), body);
    await mkdir(join(folder, 'sibling'));
    await writeFile(join(folder, 'sibling', 'outside.txt'), 'outside');
    await symlink(join(folder, 'sibling'), join(root, 'escape'), 'junction');
    let allowed = true;
    const repository = await Repository.bind({ path: root, isAvailable: () => allowed }, { ripgrep: false });
    const paths = (await repository.catalog(signal)).paths;
    assert.deepEqual(paths, ['docs/router.md', 'src/router.py', 'src/settings.py', 'tests/test_router.py']);
    assert.match((await repository.read('src/settings.py', signal)).lines[0]!, /redacted/);
    for (const path of ['../sibling/outside.txt', 'escape/outside.txt', 'src/private.pem', 'src/ignored.py', 'src/route.tmp', 'C:/repo', 'src/router.py:stream', 'missing.py']) {
      await assert.rejects(repository.read(path, signal));
    }
    const reports: ContextReport[] = [];
    const context = new ContextEngine(repository, 2500, (report) => reports.push(report));
    assert.ok((await context.search('route publish', signal)).items.length);
    await context.symbols('publish', 'src/router.py', signal);
    assert.deepEqual(reports.at(-1)?.hits.map((hit) => [hit.symbol, hit.start]), [['publish', 2], ['publish_preview', 5]]);
    await assert.rejects(context.symbols('missing', undefined, signal), /No matching symbol/);
    await assert.rejects(context.mentions(parseMentions('@symbol:publish'), signal), /ambiguous/);
    await assert.rejects(context.mentions(parseMentions('@symbol:missing'), signal), /not found/);
    await assert.rejects(context.mentions(parseMentions('@file:missing.py'), signal), /missing/);
    assert.throws(() => parseMentions('Use @file:'), /Use @file/);
    assert.throws(() => parseMentions('Use @symbol:"missing quote'), /Use @file/);
    assert.deepEqual(parseMentions('Explain @file:docs/router.md.'), [{ kind: 'file', value: 'docs/router.md' }]);
    const attached = await context.mentions(parseMentions('@file:"src/router.py" @symbol:src/router.py#publish'), signal);
    assert.equal(attached.length, 1);
    assert.match(reports.at(-1)?.hits[0]?.reason ?? '', /@file.*@symbol/);
    const ranking = new ContextEngine(repository, 2500, (report) => reports.push(report));
    const first = await ranking.bundle('router publish commands tests documentation', signal);
    assert.ok(first.items.length >= 3);
    assert.ok(reports.at(-1)?.hits.some((hit) => hit.path === 'tests/test_router.py' && hit.selected));
    assert.equal((await ranking.bundle('router publish commands tests documentation', signal)).items.length, 0);
    const small = new ContextEngine(repository, 60, (report) => reports.push(report));
    assert.ok((await small.bundle('publish', signal)).omitted > 0);
    assert.ok(reports.every((report) => report.estimatedTokens <= report.budget));
    allowed = false;
    await assert.rejects(repository.read('src/router.py', signal), /trusted/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Agent Mode bundle includes nearby implementation, test, and documentation landmarks', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'vanta-agent-context-'));
  const root = join(folder, 'repo');
  const signal = new AbortController().signal;
  try {
    for (const path of ['src/flask', 'tests', 'docs']) await mkdir(join(root, path), { recursive: true });
    const code = Array.from({ length: 90 }, (_, index) => `# unrelated implementation line ${index + 1}`);
    code[19] = '@app.cli.command("config")';
    code[20] = 'def config_command():';
    code[21] = '    return {"ok": True}';
    code[50] = '# config command JSON SECRET masking';
    code[74] = '@app.cli.command("unrelated")';
    code[75] = 'def unrelated_command():';
    code[78] = 'app.cli.add_command(config_command)';
    const tests = Array.from({ length: 45 }, (_, index) => `# unrelated test line ${index + 1}`);
    tests[0] = 'def test_config_command():';
    tests[30] = '    assert "config command JSON SECRET masking"';
    const docs = Array.from({ length: 45 }, (_, index) => `CLI notes ${index + 1}`);
    docs[24] = 'Usage details';
    docs[25] = '----------------------';
    docs[29] = 'The config command prints JSON and masks SECRET values.';
    await writeFile(join(root, 'src/flask/cli.py'), code.join('\n'));
    await writeFile(join(root, 'tests/test_cli.py'), tests.join('\n'));
    await writeFile(join(root, 'docs/cli.rst'), docs.join('\n'));
    await writeFile(join(root, 'docs/config.rst'), 'Config command JSON SECRET masking\n==================================\n');

    const repository = await Repository.bind({ path: root, isAvailable: () => true }, { ripgrep: false });
    const reports: ContextReport[] = [];
    const context = new ContextEngine(repository, 8000, (report) => reports.push(report), true);
    const result = await context.bundle('Add the flask config command, test JSON masking, and document it in CLI', signal);
    const serialized = JSON.stringify(result.items);
    assert.match(serialized, /Existing registration or entry point/);
    assert.match(serialized, /Existing handler definition/);
    assert.match(serialized, /def config_command/);
    assert.match(serialized, /Existing test definition/);
    assert.match(serialized, /Existing documentation section/);
    assert.equal(result.items[2]?.path, 'docs/cli.rst');
    assert.ok(reports.at(-1)?.hits.some((hit) => hit.path === 'src/flask/cli.py'));
    assert.ok(reports.at(-1)?.hits.some((hit) => hit.path === 'tests/test_cli.py'));
    assert.ok(reports.at(-1)?.hits.some((hit) => hit.path === 'docs/cli.rst'));

    const anchor = result.items.find((item) => item.reason === 'Existing handler definition')!;
    const repeat = await context.readRanges([anchor], 24, signal);
    assert.equal(repeat.ranges[0]?.status, 'already_shared');
    assert.deepEqual(repeat.items, []);
    code[21] = '    return {"ok": False}';
    await writeFile(join(root, 'src/flask/cli.py'), code.join('\n'));
    const updated = await context.readRanges([anchor], 24, signal);
    assert.equal(updated.ranges[0]?.status, 'returned');
    assert.match(updated.items[0]!.text, /False/);
    const tooSmall = new ContextEngine(repository, 60, () => undefined, true);
    const skipped = await tooSmall.readRanges([anchor], 24, signal);
    assert.equal(skipped.ranges[0]?.status, 'budget_skipped');
    assert.equal(skipped.remainingTokens, 60);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Agent Mode reserves source lines for actual Python boundaries across a clipped function', { skip: !process.env.VANTA_TEST_PYTHON }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vanta-context-boundaries-'));
  const path = 'router.py';
  const lines = [
    'def build_routes():',
    '    items = list_active_routes()',
    '    if not items:',
    '        print("No active routes")',
    '        return',
    '    sample = """',
    'def misleading_declaration():',
    '"""',
    ...Array.from({ length: 40 }, (_, index) => `    step_${index} = items`),
    '    return sorted(items)',
    '',
    '@registered(',
    '    "next",',
    ')',
    'async def next_handler():',
    '    return True',
  ];
  const signal = new AbortController().signal;
  try {
    await writeFile(join(root, path), lines.join('\n'));
    const repository = await Repository.bind({ path: root, isAvailable: () => true }, { ripgrep: false });
    const context = new ContextEngine(repository, 8000, () => undefined, true, process.env.VANTA_TEST_PYTHON);
    const bundle = await context.bundle('build_routes', signal);
    const item = bundle.items.find((hit) => hit.path === path)!;
    assert.deepEqual(item.pythonBoundary, { start: 1, end: 49, nextStart: 51, nextDeclaration: 54 });
    assert.ok(item.text.includes('print("No active routes")'));
    assert.deepEqual(item.continuation?.map(({ start, end }) => [start, end]), [[47, 49], [51, 51], [54, 54]]);
    assert.ok(item.continuation?.[0]?.text.endsWith('    return sorted(items)'));
    assert.equal([item, ...item.continuation ?? []].reduce((count, block) => count + block.end - block.start + 1, 0), 23);
    const clipped = { path, start: 3, end: 32 };
    const result = await context.readRanges([clipped], 24, signal);
    const read = result.items[0]!;
    assert.equal(read.pythonBoundary?.end, 49);
    assert.equal([read, ...read.continuation ?? []].reduce((count, block) => count + block.end - block.start + 1, 0), 24);
    assert.equal((await context.readRanges([clipped], 24, signal)).ranges[0]?.status, 'already_shared');
    lines[48] = '    return reversed(items)';
    await writeFile(join(root, path), lines.join('\n'));
    assert.match((await context.readRanges([clipped], 24, signal)).items[0]?.continuation?.[0]?.text ?? '', /return reversed/);
    const limited = new ContextEngine(repository, 60, () => undefined, true, process.env.VANTA_TEST_PYTHON);
    assert.equal((await limited.readRanges([clipped], 24, signal)).ranges[0]?.status, 'budget_skipped');
  } finally { await rm(root, { recursive: true, force: true }); }
});
