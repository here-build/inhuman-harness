import { describe, expect, it } from "vitest";

import { detectShellEmbeds, guessLang, langFromPath, resolveLang } from "../lang.js";

describe("language ids", () => {
  it("maps tape aliases onto shiki languages", () => {
    expect(resolveLang("ts")).toBe("typescript");
    expect(resolveLang("mjs")).toBe("javascript");
    expect(resolveLang("scheme")).toBe("scm");
    expect(resolveLang("arrival")).toBe("scm");
    expect(resolveLang("shell")).toBe("bash");
    expect(resolveLang("")).toBe("text");
  });

  it("reads a grammar from the path", () => {
    expect(langFromPath("src/hook.scm")).toBe("scm");
    expect(langFromPath("src/view.tsx")).toBe("tsx");
    expect(langFromPath("Dockerfile")).toBe("docker");
    expect(langFromPath("Makefile")).toBe("makefile");
    expect(langFromPath("changes.diff")).toBe("diff");
    expect(langFromPath("README")).toBeUndefined();
  });

  it("guesses an untagged fence and refuses a weak signal", () => {
    expect(guessLang("#!/usr/bin/env python3\nprint(1)\n")).toBe("python");
    expect(guessLang("interface Box {\n  value: string;\n}\n")).toBe("typescript");
    expect(guessLang("hello there\n")).toBeUndefined();
  });

  it("finds a heredoc body and inline interpreter code", () => {
    const heredoc = "cat > hook.scm << EOF\n{:key 1}\nEOF";
    const regions = detectShellEmbeds(heredoc);
    expect(regions).toHaveLength(1);
    expect(heredoc.slice(regions[0]?.start, regions[0]?.end)).toBe("{:key 1}");
    expect(regions[0]?.lang).toBe("scm");

    const inline = 'python -c "print(1)"';
    const code = detectShellEmbeds(inline);
    expect(inline.slice(code[0]?.start, code[0]?.end)).toBe("print(1)");
    expect(code[0]?.lang).toBe("python");
  });
});
