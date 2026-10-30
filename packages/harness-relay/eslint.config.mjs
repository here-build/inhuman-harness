import { nodeProject } from "@-internal-/eslint-configs";

export default [
  { ignores: ["worker-configuration.d.ts"] },
  ...nodeProject(import.meta.dirname),
  {
    rules: {
      // Worker runtime, not browsers: URL and friends are always there, cloudflare:* is virtual.
      "compat/compat": "off",
      "import-x/no-unresolved": ["error", { ignore: ["^cloudflare:"] }],
    },
  },
  { files: ["**/__tests__/**"], rules: { "unicorn/no-await-expression-member": "off" } },
];
