import { describe, expect, it } from "vitest";

import { rowTitle } from "../tape-read.js";

describe("row title", () => {
  it("prefers the live title, then the overview title, then the prompt", () => {
    expect(rowTitle({ live: "Renamed", title: "Old", lastPrompt: "first prompt" })).toBe("Renamed");
    expect(rowTitle({ live: "", title: "From the daemon", lastPrompt: "first prompt" })).toBe("From the daemon");
    expect(rowTitle({ live: "  ", title: "", lastPrompt: "  hello\nmore" })).toBe("hello");
  });

  it("does not fall back to a session id", () => {
    expect(rowTitle({ live: "", title: "", lastPrompt: "" })).toBe("New conversation");
  });
});
