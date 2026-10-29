import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KernelToolCatalog } from "@/tool-catalog";

import { SYSTEM_ENTRIES, ToolError, asToolResult, constrainQuery, finderFor } from "../index.js";

const catalog = new KernelToolCatalog();
catalog.replacePack(SYSTEM_ENTRIES);

async function run(name: string, args: Record<string, unknown>, root: string) {
  const execute = catalog.catalogEntry(name)?.execute;
  if (execute === undefined) throw new Error(`no execute for ${name}`);
  return asToolResult(await execute(args, { root, catalog }));
}

describe("builtin effect bodies", () => {
  let root = "";
  let outside = "";

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "bt-root-")));
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), "bt-out-")));
    writeFileSync(path.join(root, "note.txt"), "alpha\nbeta\nalpha\n");
    writeFileSync(path.join(outside, "secret.txt"), "not yours");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("read_file / list_dir / write_file run through catalog execute", async () => {
    const listed = await run("list_dir", { path: "." }, root);
    const read = await run("read_file", { path: "note.txt" }, root);
    const created = await run("write_file", { path: "out.txt", content: "ok" }, root);
    const reread = await run("read_file", { path: "out.txt" }, root);
    expect({
      listed: (listed.value as string[]).includes("note.txt"),
      read: read.text,
      created: created.ok,
      reread: reread.text,
    }).toEqual({
      listed: true,
      read: "alpha\nbeta\nalpha\n",
      created: true,
      reread: "ok",
    });
  });

  it("write_file refuses an existing path without overwriteExisting", async () => {
    const refused = await run("write_file", { path: "note.txt", content: "nope" }, root);
    expect(refused).toEqual({
      ok: false,
      text: expect.stringMatching(/overwriteExisting/),
    });
  });

  it("path confinement throws before the body writes outside the root", async () => {
    await expect(run("read_file", { path: path.join(outside, "secret.txt") }, root)).rejects.toBeInstanceOf(ToolError);
    await expect(run("write_file", { path: "../evil.txt", content: "x" }, root)).rejects.toBeInstanceOf(ToolError);
  });

  it("shell effect body runs in the project root", async () => {
    const result = await run("shell", { command: "pwd" }, root);
    expect({
      ok: result.ok,
      cwd: String((result.value as { stdout?: string } | undefined)?.stdout ?? "").trim(),
    }).toEqual({ ok: true, cwd: root });
  });

  it("grep path to a file matches inside that file, not a fake directory prefix", async () => {
    const inFile = await run("grep", { pattern: "alpha", path: "note.txt" }, root);
    const missing = await run("grep", { pattern: "no-such-token-zzz", path: "note.txt" }, root);
    const dir = await run("grep", { pattern: "alpha", path: "." }, root);
    const lines = (inFile.value as string[] | undefined) ?? [];
    const dirLines = (dir.value as string[] | undefined) ?? [];
    expect({
      query: {
        file: constrainQuery("alpha", "note.txt", undefined, false),
        dir: constrainQuery("alpha", "src", undefined, true),
        alreadySlash: constrainQuery("alpha", "src/", undefined, true),
      },
      ok: inFile.ok,
      hit: lines.some((line) => line.includes("note.txt:") && line.includes("alpha")),
      onlyThatFile: lines.every((line) => line.startsWith("note.txt:")),
      dirHit: dirLines.some((line) => line.includes("note.txt:") && line.includes("alpha")),
      missingOk: missing.ok,
      missingEmpty: Array.isArray(missing.value) && missing.value.length === 0,
    }).toEqual({
      query: {
        file: "note.txt alpha",
        dir: "src/ alpha",
        alreadySlash: "src/ alpha",
      },
      ok: true,
      hit: true,
      onlyThatFile: true,
      dirHit: true,
      missingOk: true,
      missingEmpty: true,
    });
  });

  it("fff treats a slashed file path as a directory prefix and finds nothing", async () => {
    const finder = await finderFor(root);
    const file = finder.grep("note.txt alpha", { mode: "plain", pageSize: 20 });
    const slashed = finder.grep("note.txt/ alpha", { mode: "plain", pageSize: 20 });
    expect({
      fileOk: file.ok,
      fileHits: file.ok ? file.value.items.map((item) => `${item.relativePath}:${item.lineContent.trim()}`) : [],
      slashOk: slashed.ok,
      slashHits: slashed.ok ? slashed.value.items.length : -1,
    }).toEqual({
      fileOk: true,
      fileHits: ["note.txt:alpha", "note.txt:alpha"],
      slashOk: true,
      slashHits: 0,
    });
  });

  it("update_metadata and context_need ack through execute", async () => {
    const meta = await run(
      "update_metadata",
      { current_turn_title: "Title", current_turn_description: "Doing work" },
      root,
    );
    const need = await run("context_need", { min_remaining_tokens: 100 }, root);
    expect({ meta: meta.value, need: need.value }).toEqual({
      meta: {
        current_turn_title: "Title",
        current_turn_description: "Doing work",
      },
      need: { ok: true },
    });
  });
});
