import { nodeProject } from "@-internal-/eslint-configs";

export default [
  ...nodeProject(import.meta.dirname),
  {
    files: ["src/**"],
    // The exported transcript renders in the browser; Node owns its test host.
    settings: { browserslistOpts: { env: "browser" } },
    rules: {
      // The tape still paints with the web app's views. The package owns the transcript, not a second copy of them.
      "import-x/no-relative-packages": "off",
    },
  },
  {
    files: ["src/**/__tests__/**", "src/**/*.test.ts"],
    settings: { browserslistOpts: { env: "node" } },
  },
];
