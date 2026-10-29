import { keywordsOf, keywordsOf as replKeywordsOf } from "@inhuman.tools/harness-scheme/keywords";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ensure.js", () => {
  throw new Error("ensure must not load from keywordsOf");
});
vi.mock("../composition.js", () => {
  throw new Error("composition must not load from keywordsOf");
});
vi.mock("../daemon/kernel/KernelDaemon.js", () => {
  throw new Error("KernelDaemon must not load from keywordsOf");
});

describe("keywordsOf", () => {
  it("is the scheme-repl export and loads without composition or the daemon", () => {
    expect(replKeywordsOf).toBe(keywordsOf);
    expect(keywordsOf("probe", [], {})).toEqual({});
  });
});
