import { expect, test } from "vitest";

import { parseConfigJson } from "../well-known.js";

test("parseConfigJson fills slices and drops invalid rows and fields", () => {
  expect(parseConfigJson("nope")).toEqual({ connections: {}, plugins: {} });
  expect(
    parseConfigJson({
      connections: {
        sentry: {
          driver: "mcp-http",
          tools: ["get_*"],
          alwaysAllow: ["list_issues"],
          settings: { url: "https://mcp.sentry.dev/mcp" },
        },
        broken: { name: "no-driver" },
        also: 1,
      },
      plugins: { ok: { enabled: false }, bad: "nope" },
      authorization: "nope",
      defaultPermissionMode: "auto",
      autoModeClassifier: "./classifier.scm",
      extra: true,
    }),
  ).toEqual({
    connections: {
      sentry: {
        driver: "mcp-http",
        name: "",
        annotation: "",
        settings: {
          url: "https://mcp.sentry.dev/mcp",
          tools: ["get_*"],
          alwaysAllow: ["list_issues"],
        },
      },
    },
    plugins: { ok: { enabled: false } },
    defaultPermissionMode: "auto",
    autoModeClassifier: "./classifier.scm",
  });
});

test("obsolete configuration keys are ignored", () => {
  expect(
    parseConfigJson({ defaultPolicy: "auto", autoModeAsk: "a", autoModeJudge: "b", textOnlyContinue: {} }),
  ).toEqual({ connections: {}, plugins: {} });
});
