import { describe, expect, it } from "vitest";

import { openUrlFieldType, parsePark } from "../connect-park.js";

describe("park bodies", () => {
  it("reads a browser sign-in", async () => {
    expect(
      await parsePark(
        String.raw`(harness/open-url :url "https://auth.example/authorize?x=1&y=\"2\"" :description "Authorize in the browser")`,
      ),
    ).toEqual({
      kind: "open-url",
      url: 'https://auth.example/authorize?x=1&y="2"',
      description: "Authorize in the browser",
      paste: "",
      input: null,
    });
  });

  it("offers a paste field when the sign-in also takes a typed input", async () => {
    expect(
      await parsePark(
        `(harness/open-url :url "https://a.example/" :description "Go" :name "Or paste a key" :input 'password)`,
      ),
    ).toEqual({
      kind: "open-url",
      url: "https://a.example/",
      description: "Go",
      paste: "Or paste a key",
      input: "password",
    });
    expect(openUrlFieldType("Or paste a key", "password")).toBe("password");
    expect(openUrlFieldType("OAuth client ID", "text")).toBe("text");
    expect(openUrlFieldType("Browser on another machine? Paste the address it ended on", "password")).toBe("url");
    expect(openUrlFieldType("Or paste a token, or the address the browser ended on", "password")).toBe("password");
  });

  it("paints only web links", async () => {
    expect(await parsePark(`(harness/open-url :url "javascript:alert(1)" :description "x")`)).toEqual({
      kind: "unknown",
    });
    expect(await parsePark(`(harness/open-url :description "no link")`)).toEqual({ kind: "unknown" });
  });

  it("reads a field, secret or not", async () => {
    expect(await parsePark(`(harness/input :name "API key" :description "Paste it." :secret #t)`)).toEqual({
      kind: "input",
      name: "API key",
      description: "Paste it.",
      secret: true,
    });
    expect(await parsePark(`(harness/input :name "Base URL")`)).toEqual({
      kind: "input",
      name: "Base URL",
      description: "",
      secret: false,
    });
    expect(await parsePark(`(harness/input)`)).toMatchObject({ kind: "input", name: "Input" });
  });

  it("reads a confirmation", async () => {
    expect(await parsePark(`(harness/confirm :title "Replace" :description "Replace it?")`)).toEqual({
      kind: "confirm",
      name: "Replace",
      description: "Replace it?",
    });
  });

  it("leaves everything else to the terminal", async () => {
    for (const body of [
      `(harness/notice :message "hi")`,
      `(+ 1 2)`,
      `"just a string"`,
      `(harness/input :name "a") (harness/input :name "b")`,
      `(unbalanced`,
      ``,
    ]) {
      expect(await parsePark(body)).toEqual({ kind: "unknown" });
    }
  });
});
