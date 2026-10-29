import { describe, expect, it } from "vitest";

import { readEmbed } from "../embed.js";

describe("readEmbed", () => {
  it("is the full shell without the flag", () => {
    expect(readEmbed("")).toEqual({ active: false, safeTop: 0, safeBottom: 0 });
    expect(readEmbed("?safeTop=40").active).toBe(false);
  });

  it("reads insets and drops values that are not a bar height", () => {
    expect(readEmbed("?embed=1&safeTop=96&safeBottom=12")).toEqual({
      active: true,
      safeTop: 96,
      safeBottom: 12,
    });
    expect(readEmbed("embed=1&safeTop=-4&safeBottom=9999")).toEqual({
      active: true,
      safeTop: 0,
      safeBottom: 0,
    });
  });
});
