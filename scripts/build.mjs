import { build, context } from 'esbuild';

const builds = [
  { entryPoints: { extension: 'src/extension.ts', 'extension-test': 'test/extension/suite.ts' },
    platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], outExtension: { '.js': '.cjs' } },
  { entryPoints: { studio: 'src/webview/studio.tsx' }, platform: 'browser', format: 'iife', target: 'chrome132',
    define: { 'process.env.NODE_ENV': '"production"' }, minify: true },
];

for (const options of builds) {
  const config = { ...options, outdir: 'dist', bundle: true, sourcemap: true, logLevel: 'info' };
  if (process.argv.includes('--watch')) {
    await (await context(config)).watch();
  } else {
    await build(config);
  }
}
