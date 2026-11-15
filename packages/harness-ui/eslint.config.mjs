import { nodeProject } from "@-internal-/eslint-configs";

export default [
  ...nodeProject(import.meta.dirname),
  {
    files: ["src/**"],
    settings: { browserslistOpts: { env: "browser" } },
  },
  {
    files: ["src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**"],
    settings: { browserslistOpts: { env: "node" } },
  },
];
