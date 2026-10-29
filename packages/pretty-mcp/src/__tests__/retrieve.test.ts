import { describe, expect, it } from "vitest";

import { parseChromeToolReference, parsePlaywrightReadme } from "../official.js";
import {
  admitSmithery,
  argHistogram,
  assembleCalibration,
  isMegaSkipped,
  namespaceOf,
  parseArgv,
} from "../retrieve.js";
import { slimTool } from "../smithery.js";
import { TOOLKIT } from "../toolkit.js";
import type { SmitheryDetail } from "../types.js";

const PLAYWRIGHT = `
- **browser_click**
  - Title: Click
  - Description: Click an element.
  - Parameters:
    - \`element\` (string): Human-readable element description
    - \`ref\` (string, optional): Exact target
`;

const CHROME = `
  - [\`click\`](#click)
  - [\`navigate_page\`](#navigate_page)

### \`click\`

**Description:** Clicks on the provided element

### \`navigate_page\`

**Description:** Navigates the currently selected page
`;

function detail(partial: Partial<SmitheryDetail> & Pick<SmitheryDetail, "qualifiedName">): SmitheryDetail {
  return {
    displayName: partial.displayName,
    description: partial.description ?? "",
    useCount: partial.useCount ?? 0,
    verified: partial.verified ?? false,
    toolCount: partial.toolCount ?? partial.tools?.length ?? 0,
    tools: partial.tools ?? [],
    ...partial,
  };
}

describe("slimTool", () => {
  it("keeps required flags and enum type", () => {
    expect(
      slimTool({
        name: "search",
        description: "  find it  ",
        inputSchema: {
          required: ["q"],
          properties: {
            q: { type: "string", description: "query" },
            sort: { enum: ["asc", "desc"] },
            junk: "nope",
          },
        },
      }),
    ).toEqual({
      name: "search",
      description: "find it",
      args: [
        { name: "q", type: "string", required: true, description: "query" },
        { name: "sort", type: "enum", required: false, description: "" },
        { name: "junk", type: "unknown", required: false, description: "" },
      ],
      inputSchema: {
        required: ["q"],
        properties: {
          q: { type: "string", description: "query" },
          sort: { enum: ["asc", "desc"] },
          junk: "nope",
        },
      },
    });
  });

  it("drops nameless tools", () => {
    expect(slimTool({ description: "no" })).toBeUndefined();
  });

  it("passes through already-slimmed cache rows", () => {
    expect(
      slimTool({
        name: "brave_web_search",
        description: "search",
        args: [{ name: "query", type: "string", required: false, description: "" }],
      }),
    ).toEqual({
      name: "brave_web_search",
      description: "search",
      args: [{ name: "query", type: "string", required: false, description: "" }],
    });
  });
});

describe("admitSmithery", () => {
  it("takes use≥2k and 1–100 tools", () => {
    expect(admitSmithery(detail({ qualifiedName: "@github/mcp", useCount: 2000, toolCount: 86, tools: [] }))).toBe(
      true,
    );
  });

  it("rejects farms, low use, empty, and mega", () => {
    expect(admitSmithery(detail({ qualifiedName: "axel-belfort/x", useCount: 9000, toolCount: 1 }))).toBe(false);
    expect(admitSmithery(detail({ qualifiedName: "ok", useCount: 1999, toolCount: 1 }))).toBe(false);
    expect(admitSmithery(detail({ qualifiedName: "ok", useCount: 5000, toolCount: 0 }))).toBe(false);
    expect(admitSmithery(detail({ qualifiedName: "ok", useCount: 5000, toolCount: 101 }))).toBe(false);
  });

  it("counts mega separately from admit", () => {
    const mega = detail({ qualifiedName: "pipeworx/gateway", useCount: 8000, toolCount: 2530 });
    expect(isMegaSkipped(mega)).toBe(true);
    expect(admitSmithery(mega)).toBe(false);
  });
});

describe("namespaceOf", () => {
  it("splits on the first slash", () => {
    expect(namespaceOf("axel-belfort/one")).toBe("axel-belfort");
    expect(namespaceOf("filesystem")).toBe("filesystem");
  });
});

describe("official parsers", () => {
  it("reads Playwright README blocks", () => {
    const rec = parsePlaywrightReadme(PLAYWRIGHT);
    expect(rec?.id).toBe("playwright");
    expect(rec?.tools).toEqual([
      {
        name: "browser_click",
        description: "Click an element.",
        args: [
          { name: "element", type: "string", required: true, description: "Human-readable element description" },
          { name: "ref", type: "string", required: false, description: "Exact target" },
        ],
      },
    ]);
  });

  it("does not steal the next tool's Parameters after Parameters: None", () => {
    const rec = parsePlaywrightReadme(`
- **browser_close**
  - Title: Close browser
  - Description: Close the page
  - Parameters: None

- **browser_console_messages**
  - Description: Returns all console messages
  - Parameters:
    - \`level\` (string): Level of the console messages
`);
    expect(rec?.tools).toEqual([
      { name: "browser_close", description: "Close the page", args: [] },
      {
        name: "browser_console_messages",
        description: "Returns all console messages",
        args: [{ name: "level", type: "string", required: true, description: "Level of the console messages" }],
      },
    ]);
  });

  it("reads Chrome TOC names", () => {
    const rec = parseChromeToolReference(CHROME);
    expect(rec?.tools.map((t) => t.name)).toEqual(["click", "navigate_page"]);
    expect(rec?.tools[0]?.description).toBe("Clicks on the provided element");
  });
});

describe("assembleCalibration", () => {
  it("always includes toolkit and histograms args", () => {
    const admitted = detail({
      qualifiedName: "@brave/brave-search",
      displayName: "Brave",
      useCount: 4000,
      toolCount: 1,
      tools: [
        {
          name: "brave_web_search",
          description: "search",
          args: [
            { name: "q", type: "string", required: false, description: "" },
            { name: "count", type: "integer", required: false, description: "" },
          ],
        },
      ],
    });
    const mega = detail({ qualifiedName: "pipeworx/gateway", useCount: 9000, toolCount: 200 });
    const farm = detail({ qualifiedName: "axel-belfort/x", useCount: 9000, toolCount: 1 });
    const payload = assembleCalibration([admitted, mega, farm], [], "2026-09-08T00:00:00Z");
    expect(payload.servers[0]).toBe(TOOLKIT);
    expect(payload.counts).toEqual({
      servers: 2,
      tools: TOOLKIT.tools.length + 1,
      smitheryAdmitted: 1,
      megaSkipped: 1,
    });
    expect(payload.argNames.path).toBeGreaterThan(0);
    expect(payload.argNames.q).toBe(1);
    expect(argHistogram(payload.servers).count).toBe(1);
  });
});

describe("parseArgv", () => {
  const defaults = {
    cachePath: "/cache.json",
    outPath: "/out.json",
    docsDir: "/docs",
    catalogDir: "/catalog",
  };

  it("defaults to retrieve and accepts flags", () => {
    expect(parseArgv(["--fetch", "--cache", "a", "--out", "b", "--docs-dir", "c"], defaults)).toEqual({
      fetch: true,
      cachePath: "a",
      outPath: "b",
      docsDir: "c",
    });
    expect(parseArgv(["retrieve"], defaults)).toEqual({
      fetch: false,
      cachePath: "/cache.json",
      outPath: "/out.json",
      docsDir: "/docs",
    });
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgv(["--wat"], defaults)).toThrow(/unknown argument/);
  });
});
