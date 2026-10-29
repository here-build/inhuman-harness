import { nodeProject } from "@-internal-/eslint-configs";

export default [
  ...nodeProject(import.meta.dirname),
  {
    rules: {
      // Kernel/session models are PascalCase files.
      "unicorn/filename-case": [
        "warn",
        {
          cases: { camelCase: true, kebabCase: true, pascalCase: true },
        },
      ],
    },
  },
];

