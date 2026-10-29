import type { StorybookConfig } from "@storybook/react-vite";

// The builder loads vite.config.mjs, so stories share the app's Tailwind pass and workspace aliases.
const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/__stories__/*.stories.tsx", "../../harness-transcript/src/**/*.stories.tsx"],
  core: { disableTelemetry: true },
};

export default config;
