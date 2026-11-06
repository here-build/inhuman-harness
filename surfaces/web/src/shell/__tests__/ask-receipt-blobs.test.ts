// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { FileMutateToolJob, storedBlobJson } from "@inhuman.tools/harness-model";
import { afterEach, expect, it } from "vitest";

import { bindBlobCache } from "../blob-cache.js";
import { AskReceipt } from "../composer.js";

const SHA = "b".repeat(64);
const file = `${Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n")}\n`;

let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
});

it("an ask for an overwrite fills in its diff when the prior text lands", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const ask = new FileMutateToolJob({
    name: "write_file",
    argsJson: JSON.stringify({ path: "a.ts", content: "replacement\n", overwriteExisting: true }),
    priorBlobJson: storedBlobJson({ sha256: SHA, bytes: file.length, mime: "text/plain", head: file.slice(0, 64) }),
    existed: true,
    completed: false,
  });
  let answer: (value: unknown) => void = () => undefined;
  const asked: unknown[] = [];
  release = bindBlobCache(
    (method, params) =>
      new Promise((resolve) => {
        asked.push({ method, params });
        answer = resolve;
      }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(AskReceipt, { ask, projectPath: "/work" }));
    });
    // Without the file there is no diff to show: the arguments are the receipt.
    expect(asked).toEqual([{ method: "blob/get", params: { sha256: SHA } }]);
    expect(container.querySelector("pre.tool-body")?.textContent).toContain("replacement");

    await act(async () => {
      answer({ sha256: SHA, bytes: file.length, mime: "text/plain", text: file, bytesBase64: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("pre.tool-body")).toBeNull();
    expect(container.querySelector(".ask-receipt")?.children.length).toBeGreaterThan(0);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
