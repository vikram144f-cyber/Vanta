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
