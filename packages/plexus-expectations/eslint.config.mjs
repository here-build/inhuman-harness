import { shared } from "@-internal-/eslint-configs";

export default [
  // Tooling configs aren't in the tsconfig program (same as plexus-vfs).
  { ignores: ["dist/*", "node_modules/*", "vitest.config.ts", "eslint.config.mjs"] },
  ...shared,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Plexus @syncing models are PascalCase files. PEW is an acronym, not Pew.
      "unicorn/filename-case": [
        "error",
        {
          cases: { camelCase: true, kebabCase: true, pascalCase: true },
          ignore: ["PEWDriver.ts"],
        },
      ],
      // WorkExpectation is awaitable by design (`await E`).
      "unicorn/no-thenable": "off",
      // `pnpm format` is the printer; eslint-plugin-prettier disagrees on leading `|`.
      "prettier/prettier": "off",
    },
  },
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "no-console": "off",
      "unicorn/no-useless-undefined": "off",
      // Side-effect mobx register must run first; import-x wants package root first.
      "import-x/order": "off",
      // JSON round-trip asserts plain-data snapshots (AbortSignal is not structuredCloneable).
      "unicorn/prefer-structured-clone": "off",
    },
  },
];
