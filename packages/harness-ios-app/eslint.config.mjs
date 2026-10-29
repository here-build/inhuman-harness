import { nodeProject } from "@-internal-/eslint-configs";

export default [
  { ignores: ["ios/**", "android/**", "index.js", "metro.config.js", "babel.config.js"] },
  ...nodeProject(import.meta.dirname),
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // The phone reuses the web app's source. Those modules are not a published export.
      "import-x/no-relative-packages": "off",
    },
  },
];
