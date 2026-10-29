import "@fontsource/jetbrains-mono/400-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700-italic.css";
import "@fontsource/jetbrains-mono/700.css";
import type { Preview } from "@storybook/react-vite";

import "../src/styles.css";

const preview: Preview = {
  parameters: { layout: "fullscreen", controls: { disable: true }, actions: { disable: true } },
  globalTypes: {
    scheme: {
      description: "Color scheme",
      toolbar: {
        title: "Scheme",
        icon: "mirror",
        dynamicTitle: true,
        items: [
          { value: "system", title: "System" },
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
  },
  initialGlobals: { scheme: "system" },
  decorators: [
    // The page's own pin: `data-scheme` decides `color-scheme`, and every token follows.
    (Story, context) => {
      const scheme: unknown = context.globals.scheme;
      if (scheme === "light" || scheme === "dark") document.documentElement.dataset.scheme = scheme;
      else delete document.documentElement.dataset.scheme;
      return <Story />;
    },
  ],
};

export default preview;
