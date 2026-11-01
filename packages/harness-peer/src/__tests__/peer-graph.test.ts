import { resolve } from "node:path";

import { build } from "vite";
import { expect, it } from "vitest";

it("bundles the public peer entry for browsers without Node shims", async () => {
  // Use the shipped entry: source-only traversal cannot catch a stale dist
  // re-export, conditional exports, dynamic imports, or dependency side effects.
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry: resolve(import.meta.dirname, "../../dist/index.js"), formats: ["es"] },
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.message.includes("externalized for browser compatibility")) throw new Error(warning.message);
          warn(warning);
        },
      },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const forbidden = bundles.flatMap((bundle) =>
    "output" in bundle
      ? bundle.output.flatMap((chunk) => {
          if (chunk.type !== "chunk") return [];
          return [...chunk.moduleIds, ...chunk.imports, ...chunk.dynamicImports].filter(
            (id) => id.startsWith("node:") || id.includes("browser-external") || /(?:^|\/)ws(?:\/|$)/.test(id),
          );
        })
      : [],
  );
  expect(forbidden).toEqual([]);
});
