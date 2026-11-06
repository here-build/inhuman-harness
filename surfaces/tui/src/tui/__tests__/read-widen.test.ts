import { describe, expect, it } from "vitest";

import { fileReadParent, fileReadWiden } from "../read-widen.js";

const ROOT = "/Users/me/project";

describe("fileReadWiden", () => {
  it("offers the same-parent folder; fences home and disjoint trees; Enter is not this", () => {
    const docs = "/Users/me/docs";
    expect({
      parent: fileReadParent(`${docs}/spec.md`),
      sibling: fileReadWiden(ROOT, `${docs}/readme.md`, [`${docs}/spec.md`]),
      inflightDir: fileReadWiden(ROOT, `${docs}/spec.md`, [docs]),
      lone: fileReadWiden(ROOT, `${docs}/spec.md`, []),
      self: fileReadWiden(ROOT, `${docs}/spec.md`, [`${docs}/spec.md`]),
      disjoint: fileReadWiden(ROOT, `${docs}/spec.md`, ["/Users/me/other/a.ts"]),
      nestedNotLca: fileReadWiden(ROOT, `${docs}/spec.md`, [`${docs}/api/x.md`]),
      home: fileReadParent("/Users/me/notes.md"),
      users: fileReadParent("/Users/me"),
      slash: fileReadParent("/etc/passwd"),
      tmpRoot: fileReadParent("/tmp/a.txt"),
      tmpOther: fileReadParent("/tmp/other/a.ts"),
      relative: fileReadParent("src/a.ts"),
    }).toEqual({
      parent: docs,
      sibling: { path: docs, label: "../docs" },
      inflightDir: { path: docs, label: "../docs" },
      lone: undefined,
      self: undefined,
      disjoint: undefined,
      nestedNotLca: undefined,
      home: undefined,
      users: undefined,
      slash: undefined,
      tmpRoot: undefined,
      tmpOther: "/tmp/other",
      relative: undefined,
    });
  });
});
