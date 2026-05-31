/**
 * Root ESLint config — operationalizes the project hard bans (CLAUDE.md §2.1)
 * as machine gates. `no-explicit-any` is the mandated bar for M1 (PROJECT_SPEC).
 * Runs syntactically (no type-aware `project`), so it stays fast for the gate.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  env: {
    node: true,
    es2022: true,
  },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    'no-console': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ExportDefaultDeclaration',
        message: 'Default exports are banned (CLAUDE.md §2.1); use named exports.',
      },
    ],
    'no-undef': 'off',
  },
  overrides: [
    {
      files: ['**/*.tsx'],
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    {
      files: ['**/*.d.ts'],
      rules: {
        '@typescript-eslint/triple-slash-reference': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
  ignorePatterns: [
    'node_modules',
    'dist',
    'build',
    'coverage',
    'playwright-report',
    '*.config.ts',
    '*.config.cjs',
    '*.config.js',
  ],
}
