import { describe, expect, it } from "vitest";

import { compile } from "./_helpers/compile.js";

describe("read_file", () => {
  it("path enable / ! / root prefix / anchor / append", async () => {
    const loaded = await compile(`{"read_file":["/tmp","."],"read_block":[".git"]}`);
    const tableWant = {
      "src/main.ts": "policyApprove",
      "./lib/a": "policyApprove",
      "/tmp/x": "policyApprove",
      ".git/HEAD": "block",
      "pkg/.git/config": "block",
      "/etc/passwd": "deny",
      ".gitignore": "policyApprove",
      "src/.gitignore": "policyApprove",
      "../secret": "ask",
      "$HOME/.ssh/id_rsa": "ask",
      "~/.npmrc": "ask",
    } as const;
    const table = Object.fromEntries(Object.keys(tableWant).map((path) => [path, loaded.read(path)]));

    const root = await compile(`{"read_file":["/"]}`);
    const slash = await compile(`{"read_file":["src/secret"]}`);
    const append = await compile(`{"read_file":["."],"read_block":[".env"]}`);

    expect({
      table,
      root: { root: root.read("/"), etc: root.read("/etc/passwd"), relative: root.read("src/a.ts") },
      slash: { under: slash.read("src/secret/x"), nested: slash.read("pkg/src/secret") },
      append: { src: append.read("src/a.ts"), env: append.read(".env") },
    }).toEqual({
      table: tableWant,
      root: { root: "policyApprove", etc: "policyApprove", relative: "deny" },
      slash: { under: "policyApprove", nested: "deny" },
      append: { src: "policyApprove", env: "block" },
    });
  });

  it("a missing cluster asks and an empty list denies", async () => {
    const bashOnly = await compile(`{"bash":{"policy":"ask","subcommands":{"ls":"approve"}}}`);
    const emptyRead = await compile(`{"read_file":[]}`);
    const oneProgram = await compile(
      `{"bash":{"policy":"ask","subcommands":{"ls":"approve"}},"read_file":["."],"write_file":["."],"read_block":[".env"],"write_block":[".env"]}`,
    );
    expect({
      missing: { read: bashOnly.read("src/a.ts"), write: bashOnly.write("src/a.ts") },
      emptyRead: { read: emptyRead.read("src/a.ts"), bash: emptyRead.bash("ls") },
      oneProgram: {
        bash: oneProgram.bash("ls"),
        src: oneProgram.read("src/a.ts"),
        envRead: oneProgram.read(".env"),
        envWrite: oneProgram.write(".env"),
        srcWrite: oneProgram.write("src/a.ts"),
      },
    }).toEqual({
      missing: { read: "ask", write: "ask" },
      emptyRead: { read: "deny", bash: "ask" },
      oneProgram: { bash: "policyApprove", src: "policyApprove", envRead: "block", envWrite: "block", srcWrite: "ask" },
    });
  });
});

describe("write_file", () => {
  it("enable ! is deny remainder; write_block is unliftable", async () => {
    const loaded = await compile(`{"write_file":[".","!package.json","!.github/workflows"],"write_block":[".env"]}`);
    const bare = await compile(`{"write_file":[".","!.env"]}`);
    expect({
      src: loaded.write("src/a.ts"),
      pkg: loaded.write("package.json"),
      nested: loaded.write("apps/web/package.json"),
      workflows: loaded.write(".github/workflows/ci.yml"),
      env: loaded.write(".env"),
      bare: { env: bare.write(".env"), src: bare.write("src/a.ts") },
      extra: loaded.write("/etc/passwd"),
      kinds: {
        src: loaded.writeKind("src/a.ts"),
        pkg: loaded.writeKind("package.json"),
        nested: loaded.writeKind("apps/web/package.json"),
        extra: loaded.writeKind("/etc/passwd"),
        otherPkg: loaded.writeKind("/home/other/package.json"),
        env: loaded.writeKind(".env"),
      },
    }).toEqual({
      src: "ask",
      pkg: "deny",
      nested: "deny",
      workflows: "deny",
      env: "block",
      bare: { env: "deny", src: "ask" },
      extra: "deny",
      kinds: {
        src: null,
        pkg: "protected",
        nested: "protected",
        extra: "outside",
        otherPkg: "risky",
        env: null,
      },
    });
  });

  it(".claude write_block carves .claude/worktrees", async () => {
    const loaded = await compile(`{"write_file":["."],"write_block":[".claude"]}`);
    expect({
      skills: loaded.write(".claude/skills/x.md"),
      settings: loaded.write(".claude/settings.json"),
      trees: loaded.write(".claude/worktrees/issue-1"),
      nested: loaded.write("pkg/.claude/worktrees/x"),
    }).toEqual({
      skills: "block",
      settings: "block",
      trees: "ask",
      nested: "ask",
    });
  });
});
