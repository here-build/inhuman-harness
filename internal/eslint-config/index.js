// Copied from here.build/commons packages/eslint-config (MIT). Local private copy.
import eslint from "@eslint/js";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import compat from "eslint-plugin-compat";
import importX from "eslint-plugin-import-x";
import noSecrets from "eslint-plugin-no-secrets";
import promise from "eslint-plugin-promise";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import * as regexp from "eslint-plugin-regexp";
import security from "eslint-plugin-security";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

const baseConfig = [
  { ignores: ["**/dist/**", "**/node_modules/**", "**/build/**", "**/.next/**", "eslint.config.*"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  unicorn.configs["flat/recommended"],
  compat.configs["flat/recommended"],
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  promise.configs["flat/recommended"],
  regexp.configs["flat/recommended"],
  {
    plugins: {
      "no-secrets": noSecrets,
    },
    rules: {
      "no-secrets/no-secrets": [
        "warn",
        {
          ignoreContent: [
            /https?:\/\/[^ ]+/,
            /^[a-zA-Z0-9+/=]+$/,
            /^iVBORw0KGgo/,
          ],
        },
      ],
    },
  },
  security.configs.recommended,
  {
    rules: {
      // Stylistic rules - should be warnings, not errors
      "arrow-body-style": "warn",
      "@typescript-eslint/consistent-type-imports": "off",

      // Performance and best practices
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/prefer-readonly": "warn",

      // Critical async/await rules - these should be errors
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-new": "error",

      // Type safety — default case satisfies exhaustiveness (supports switch(true) pattern)
      "@typescript-eslint/switch-exhaustiveness-check": ["error", {
        considerDefaultExhaustiveForUnions: true,
      }],
      "@typescript-eslint/no-shadow": "error",

      // Unused vars with _ prefix ignore pattern
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // TypeScript relaxations - reasonable defaults
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-empty-interface": "warn",

      // Allow empty catch blocks
      "no-empty": ["error", { allowEmptyCatch: true }],

      // Assertion message requirements
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.name='ensure'][arguments.length<2]",
          message: "`ensure` must always be invoked with a message.",
        },
        {
          selector: "CallExpression[callee.name='assert'][arguments.length<2]",
          message: "`assert` must always be invoked with a message.",
        },
        {
          selector: "CallExpression[callee.name='invariant'][arguments.length<2]",
          message: "`invariant` must always be invoked with a message.",
        },
      ],

      // Code quality improvements
      "prefer-const": "warn",
      "no-var": "error",
      "object-shorthand": "warn",
      "prefer-template": "warn",
      "no-console": "warn", // Should be removed before production

      // Import organization
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", ["parent", "sibling"], "index", "object"],
          "newlines-between": "always",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
          pathGroups: [
            {
              pattern: "react",
              group: "external",
              position: "before",
            },
            {
              pattern: "react-dom/**",
              group: "external",
              position: "before",
            },
            {
              pattern: "@/**",
              group: "internal",
              position: "before",
            },
          ],
          pathGroupsExcludedImportTypes: ["react", "react-dom"],
          distinctGroup: false,
          warnOnUnassignedImports: true,
        },
      ],
      "import-x/first": "error",
      "import-x/newline-after-import": "error",
      // `prefer-inline` is load-bearing, not cosmetic: without it, the autofix that merges
      // multiple imports from one module hoists everything into `import type { … }` and drags
      // VALUE specifiers in with it — producing invalid `import type { …, aValue }` (TS2206/
      // TS1361). Inline `type` markers keep values as values. (eslint-plugin-import-x ≤4.16.2.)
      "import-x/no-duplicates": ["error", { "prefer-inline": true }],
      "import-x/no-useless-path-segments": "off",
      "import-x/no-relative-packages": "error",

      // Existing rules
      "security/detect-object-injection": "off",
      "unicorn/no-null": "off",
      "unicorn/prefer-dom-node-append": "off",
      "unicorn/prefer-top-level-await": "off",
      "import-x/no-named-as-default": "off",
      "import-x/namespace": "off", // acts weirdly
      "regexp/strict": "off",
      "unicorn/no-array-callback-reference": "off",
      "unicorn/no-array-for-each": "warn",
      "unicorn/no-array-reduce": "off",
      "unicorn/switch-case-braces": "off",
      "unicorn/no-useless-fallback-in-spread": "off",
      "unicorn/prefer-global-this": "off",
      "@typescript-eslint/no-misused-promises": "off", //heavy ESLint performance impact
      "unicorn/no-useless-undefined": "off",
      "unicorn/prevent-abbreviations": "off",
      // Named `node:path` / `node:fs` imports are the house style. Default-import is not.
      "unicorn/import-style": "off",
      // Daemons, CLIs, and storybook hosts call `process.exit`.
      "unicorn/no-process-exit": "off",
      // TUI / ANSI / CSI sequences are the product. `\x1b` is the house ESC
      // spelling; `\u001B` reads as Unicode, not a control sequence.
      "no-control-regex": "off",
      "unicorn/escape-case": "off",
      "unicorn/no-hex-escape": "off",
      "unicorn/prefer-string-raw": "off",
      // Protocol numbers (CSI 2026, 256 colors, 80 cols, timeouts) are
      // identifiers, not quantities. Do not force `1_000`.
      "unicorn/numeric-separators-style": "off",
      // nUIA is off except two packages; `[len-1]` is `T`, `.at(-1)` is `T | undefined`.
      "unicorn/prefer-at": "off",
      // Fetch mocks want the stringify body; `Response.json` hides it.
      "unicorn/prefer-response-static-json": "off",
      // Indexed scans (`tapeIndexOf`) need the index; `for-of` + entries allocates.
      "unicorn/no-for-loop": "off",
      // Early-return `if (!x)` is the house shape; do not flip or ternary-fold it.
      "unicorn/no-negated-condition": "off",
      "unicorn/prefer-ternary": "off",
      // In-place `sort` is often the contract; `toSorted` is a different value.
      "unicorn/no-array-sort": "off",
      // Inner functions that close over locals are the usual shape here.
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-new-array": "warn",
      "unicorn/prefer-math-trunc": "warn",
      "unicorn/prefer-code-point": "warn",
      "unicorn/prefer-spread": "warn",
      "unicorn/prefer-single-call": "warn",
      "unicorn/no-await-expression-member": "warn",
      "unicorn/prefer-default-parameters": "warn",
      // Style leftovers. Lint fails on errors only (`prefer-string-replace-all` stays error).
      "unicorn/prefer-export-from": "warn",
      "unicorn/prefer-number-properties": "warn",
      "unicorn/explicit-length-check": "warn",
      "unicorn/prefer-set-has": "warn",
      "unicorn/catch-error-name": "warn",
      "unicorn/relative-url-style": "warn",
      "unicorn/no-useless-spread": "warn",
      "unicorn/no-object-as-default-parameter": "warn",
      "unicorn/no-lonely-if": "warn",
      "unicorn/prefer-type-error": "warn",
      "unicorn/prefer-string-starts-ends-with": "warn",
      "unicorn/prefer-logical-operator-over-ternary": "warn",
      "unicorn/prefer-array-some": "warn",
      "unicorn/prefer-array-index-of": "warn",
      "unicorn/no-zero-fractions": "warn",
      "unicorn/no-array-reverse": "warn",
      "unicorn/consistent-existence-index-check": "warn",
      "regexp/no-unused-capturing-group": "warn",
      "regexp/no-obscure-range": "warn",
      "regexp/no-super-linear-backtracking": "warn",
      "regexp/no-dupe-disjunctions": "warn",
      "regexp/no-misleading-capturing-group": "warn",
      "unicorn/prefer-add-event-listener": "warn",
      "unicorn/no-useless-switch-case": "warn",
      "unicorn/filename-case": [
        "warn", // Changed from error to warn
        {
          cases: {
            camelCase: true,
            kebabCase: true,
          },
        },
      ],
    },
  },
  {
    files: ["**/*.jsx", "**/*.tsx"],
    rules: {
      "unicorn/filename-case": [
        "warn", // Changed from error to warn
        {
          cases: {
            camelCase: true,
            kebabCase: true,
            pascalCase: true,
          },
        },
      ],
    },
  },
  prettierRecommended,
].flat();

const browserRelatedRules = {
  rules: {
    "import-x/no-dynamic-require": "warn",
    "import-x/no-nodejs-modules": "warn"
  }
};

export const reactConfig = [
  react.configs.flat.recommended,
  {
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      ...reactHooks.configs.recommended.rules,

      // React stylistic rules - warnings not errors
      "react/jsx-no-useless-fragment": "warn",
      "react/jsx-boolean-value": ["warn", "never", { assumeUndefinedIsFalse: false, always: ["initialValue"] }],
      "react/jsx-curly-brace-presence": "warn",
      "react/self-closing-comp": "warn",

      // React best practices - warnings for maintainability
      "react/no-array-index-key": "warn",
      "react/no-danger": "warn",
      "react/no-unused-prop-types": "warn",

      // Security-related React rules - keep as errors
      "react-hooks/exhaustive-deps": ["warn", {
        additionalHooks: "(useTransactionalCallback|useTransactionalEffect|useComputedValue|useAutorunEffect|useReactionEffect)"
      }]
    }
  },
  browserRelatedRules
];

export const nodejs = [
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    settings: {
      browserslistOpts: { env: "node" },
    },
  },
  ...baseConfig,
];

export const browser = [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      browserslistOpts: { env: "browser" },
    },
  },
  ...baseConfig,
  ...reactConfig,
];

export const shared = [
  {
    languageOptions: {
      globals: {
        ...globals["shared-node-browser"],
      },
    },
    settings: {
      browserslistOpts: { env: "node" },
    },
  },
  ...baseConfig,
  ...reactConfig,
];

export const cloudflare = [
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    settings: {
      browserslistOpts: { env: "cf" },
    },
  },
  ...baseConfig,
];

export const landing = [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      browserslistOpts: { env: "browser-widespread" },
    },
  },
  ...baseConfig,
  ...reactConfig,
];

/** Globs for files this repo's emit tsconfigs typically exclude. */
export const outsideProgram = [
  "**/__tests__/**",
  "**/__test__/**",
  "**/__visual__/**",
  "**/__benchmarks__/**",
  "**/__research__/**",
  "**/eval/**",
  "**/*.test.ts",
  "**/vitest*.config.ts",
  "**/*.js",
  "**/*.cjs",
  "**/*.mjs",
  "**/*.d.ts",
];

/**
 * Still out of the tsconfig program when tests are in it. `__research__` is
 * not tests; fixture `*.js` packs are not the package graph. projectService
 * fails those files unless they stay ignored.
 */
const neverInProgram = ["**/vitest*.config.ts", "**/__research__/**", "**/__tests__/fixtures/**"];

/**
 * `nodejs` plus typed-lint projectService. Tests belong in the tsconfig program.
 * Pass `ignoreTests: true` only when a package still cannot see tests.
 */
export function nodeProject(tsconfigRootDir, { ignoreTests = false } = {}) {
  return [
    ...nodejs,
    { ignores: ignoreTests ? outsideProgram : neverInProgram },
    {
      languageOptions: {
        parserOptions: {
          projectService: {
            allowDefaultProject: ["*.mjs", "*.js", "bin/*.mjs", "scripts/*.mjs", "scripts/*.ts"],
          },
          tsconfigRootDir,
        },
      },
    },
    {
      files: ["**/__tests__/**", "**/__visual__/**", "**/*.test.ts"],
      rules: {
        // Tests reach sibling package src. Those modules are not on the public export map;
        // the autofix path (`@scope/pkg/src/...`) does not resolve.
        "import-x/no-relative-packages": "off",
      },
    },
  ];
}
