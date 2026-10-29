import { nodeProject } from "@-internal-/eslint-configs";

export default [
  ...nodeProject(import.meta.dirname),
  {
    files: ["src/**"],
    rules: {
      // The tape still paints with the web app's views. The package owns the transcript, not a second copy of them.
      "import-x/no-relative-packages": "off",
    },
  },
];
