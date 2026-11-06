import { describe, expect, it } from "vitest";

import { displayPath, fileFace, looksBinary, readListParts } from "../read-line.js";

describe("read lines", () => {
  it("keeps in-project paths relative and outside paths absolute", () => {
    expect(displayPath("/work/app", "src/a.ts")).toBe("src/a.ts");
    expect(displayPath("/work/app", "/work/app/src/a.ts")).toBe("src/a.ts");
    expect(displayPath("/work/app", "/etc/hosts")).toBe("/etc/hosts");
    expect(displayPath("/work/app", "../secret")).toBe("/work/secret");
  });

  it("joins with locale list parts and dedupes nothing itself", () => {
    expect(readListParts(["a.ts", "b.ts"], ["en"])).toEqual([
      { kind: "path", label: "a.ts" },
      { kind: "text", text: " and " },
      { kind: "path", label: "b.ts" },
    ]);
  });

  it("classifies images, pdfs, and known binaries", () => {
    expect(fileFace("shot.PNG")).toBe("image");
    expect(fileFace("notes.pdf")).toBe("pdf");
    expect(fileFace("src/a.ts")).toBe("text");
    expect(fileFace("pack.wasm")).toBe("binary");
    expect(fileFace("clip.mp4")).toBe("binary");
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0, 0x0a]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("export const n = 1;\n"))).toBe(false);
  });
});
