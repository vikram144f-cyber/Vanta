import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', '.vscode-test/**'] },
  ...tseslint.configs.recommended,
];
