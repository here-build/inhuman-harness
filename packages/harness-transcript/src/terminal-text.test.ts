import { describe, expect, it } from "vitest";

import { plainTerminal } from "./terminal-text.js";

describe("plainTerminal", () => {
  it("drops colour and cursor sequences", () => {
    expect(plainTerminal("\u001B[31mred\u001B[0m ok\u001B[2K")).toBe("red ok");
  });
  it("keeps the last write of a carriage-returned progress line", () => {
    expect(plainTerminal("10%\r50%\r100%\ndone")).toBe("100%\ndone");
  });
  it("leaves CRLF as newlines", () => {
    expect(plainTerminal("a\r\nb")).toBe("a\nb");
  });
});
