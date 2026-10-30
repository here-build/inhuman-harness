import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Relative assets; index.html pins <base> so deep links resolve them too.
  base: "./",
  resolve: {
    dedupe: ["yjs", "@here.build/plexus", "react", "react-dom", "mobx-react-lite"],
  },
  // Pierre's diff worker dynamically imports its highlighter. An IIFE worker cannot split.
  worker: { format: "es" },
  plugins: [tailwindcss()],
  build: {
    outDir: join(here, "dist/client"),
    emptyOutDir: true,
  },
});
