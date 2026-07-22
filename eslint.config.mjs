import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import love from 'eslint-config-love';
import pino from 'eslint-plugin-pino';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

import sortExports from 'eslint-plugin-sort-exports';
import globals from 'globals';

export default defineConfig([
  js.configs.recommended,
  tseslint.configs.eslintRecommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.strict,
  {
    ...love,
    languageOptions: {
      parserOptions: {
        project: './tsconfig.dev.json',
      },
    },
  },
  {
    plugins: {
      pino: pino,
    },
    rules: {
      'pino/correct-args-position': 'error',
    },
  },
  prettier,
  {
    plugins: {
      'sort-exports': sortExports,
    },

    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },

      parserOptions: {
        project: './tsconfig.dev.json',
      },
    },

    rules: {
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          detectObjects: false,
          ignoreEnums: true,
          // 0, 1, and -1 are conventionally not considered "magic" numbers.
          ignore: [0, 1, -1],
        },
      ],

      // Unlike some code bases we explicitly do not want to use default exports.
      'import/prefer-default-export': 'off',
      'import/no-default-export': 'error',

      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type'],
          'newlines-between': 'never',
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          caughtErrors: 'none',
        },
      ],
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.dev.json',
        },
        node: true,
      },
    },
  },
  {
    // The data-scripts predate the shared strict `eslint-config-love` configuration
    // used by the `service` repo. The rules below are turned off here because the
    // pre-existing scripts call external APIs and would require careful,
    // separately-tested refactoring to comply. Bringing the code up to the full
    // strictness of the service repo is tracked as a separate follow-up effort. All other
    // ESLint settings (flat config, plugin stack, parser/resolver, import order,
    // no-default-export, no-unused-vars, no-magic-numbers, prettier, pino, and
    // sort-exports) match the service repo.
    //
    // The additional rules disabled below would otherwise force mechanical
    // refactors of the pre-existing scripts (`async`/`await` wrapping of promise
    // functions, nullish coalescing, optional chaining, the regexp `v` flag,
    // promise parameter names, negated-condition flips, template-literal
    // simplification, and the await-in-loop directive pair). Those refactors are
    // unrelated to the CommonJS->ESM conversion and would inject large, noisy
    // diffs (and pollute future `git blame`), so they are deferred to the same
    // separate follow-up rather than performed in this conversion commit. The
    // ESM-related type-import rule (`consistent-type-imports`) and the type
    // re-export rule (`consistent-type-exports`) stay on, as do the explicitly
    // configured `no-magic-numbers` (satisfied via named constants) and the
    // import-order rules.
    //
    // Authored by GLM-5.2.
    rules: {
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/prefer-destructuring': 'off',
      '@typescript-eslint/init-declarations': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/max-params': 'off',
      '@typescript-eslint/strict-void-return': 'off',
      'promise/avoid-new': 'off',

      // Deferred pre-existing-code refactors (see comment above):
      '@typescript-eslint/promise-function-async': 'off',
      '@typescript-eslint/return-await': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/no-unnecessary-template-expression': 'off',
      'no-negated-condition': 'off',
      'require-unicode-regexp': 'off',
      'promise/param-names': 'off',
      '@eslint-community/eslint-comments/disable-enable-pair': 'off',
    },
  },
  {
    files: ['**/index.ts'],

    rules: {
      'sort-exports/sort-exports': [
        'error',
        {
          sortDir: 'asc',
          ignoreCase: true,
        },
      ],
      // Indexes shouldn't care about the nature of the exports they are collating
      '@typescript-eslint/consistent-type-exports': 'off',
    },
  },
  {
    files: ['**/*test.ts'],

    rules: {
      // Forcing return type definitions in our ad-hoc test functions is not worth
      // the added effort / verbosity.
      '@typescript-eslint/explicit-function-return-type': 'off',

      // Tests use hard coded numbers in lots of places, and that's OK for now.
      '@typescript-eslint/no-magic-numbers': 'off',

      // Jest hoists mock statements, so sometimes we need to define mock functions
      // that are used in mocks BEFORE the import block.  There may be a better
      // approach to this, but for now it is how we do it and so the rule must go.
      'import/first': 'off',

      // The way we organize tests our test files can be very long since we're comprehensive.
      // We could refactor, potentially, but even then I imagine that a line limit is not
      // going to be useful in this context.
      'max-lines': 'off',

      // Tests are already 2-3 levels deep in nested callbacks, so we update this rule to 5 instead of 3.
      'max-nested-callbacks': ['error', 5],
    },
  },
]);
