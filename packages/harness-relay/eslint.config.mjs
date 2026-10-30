import { nodeProject } from "@-internal-/eslint-configs";

export default [
  { ignores: ["worker-configuration.d.ts", ".wrangler/**"] },
  ...nodeProject(import.meta.dirname),
  {
    rules: {
      // Worker runtime, not browsers: URL and friends are always there, cloudflare:* is virtual.
      "compat/compat": "off",
      "import-x/no-unresolved": ["error", { ignore: ["^cloudflare:"] }],
    },
  },
  { files: ["**/__tests__/**"], rules: { "unicorn/no-await-expression-member": "off" } },
  {
    // Real processes in a temp dir, dummy credentials, paths built at run time.
    files: ["e2e/**"],
    rules: {
      "unicorn/no-await-expression-member": "off",
      "security/detect-non-literal-fs-filename": "off",
      "no-secrets/no-secrets": "off",
      "no-console": "off",
    },
  },
];
