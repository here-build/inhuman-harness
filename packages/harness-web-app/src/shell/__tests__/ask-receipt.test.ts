import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SystemToolJob } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { AskReceipt } from "../composer.js";

const pending = (name: string, args: Record<string, unknown>) =>
  new SystemToolJob({ name, argsJson: JSON.stringify(args), completed: false });

describe("ask cover receipt", () => {
  it("paints a proposed shell call as the terminal the tape will show", () => {
    const html = renderToStaticMarkup(
      createElement(AskReceipt, { ask: pending("shell", { command: "rm -rf dist" }), projectPath: "/work" }),
    );
    expect(html).toContain('class="shell-term"');
    expect(html).toContain("rm -rf dist");
    expect(html).not.toContain("&quot;command&quot;");
  });

  it("falls back to the arguments when the tool has no receipt before it runs", () => {
    const html = renderToStaticMarkup(
      createElement(AskReceipt, { ask: pending("web_fetch", { url: "https://example.com" }), projectPath: "/work" }),
    );
    expect(html).toContain("&quot;url&quot;: &quot;https://example.com&quot;");
  });
});
