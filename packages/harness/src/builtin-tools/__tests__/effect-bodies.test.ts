import invariant from "tiny-invariant";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KernelToolCatalog } from "@/tool-catalog";

import { SYSTEM_ENTRIES, ToolError, asToolResult, constrainQuery, finderFor } from "../index.js";

const catalog = new KernelToolCatalog();
catalog.replacePack(SYSTEM_ENTRIES);

async function run(name: string, args: Record<string, unknown>, root: string) {
  const execute = catalog.catalogEntry(name)?.execute;
  invariant(execute !== undefined, `no execute for ${name}`);
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

  it.each(["docs/plan.md", "note.txt"])(
    "write_file rejects a replayed history placeholder without mutating %s, then accepts actual content",
    async (target) => {
      const placeholder = "[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]";
      const refused = await run(
        "write_file",
        { path: target, content: `\n${placeholder}\n`, overwriteExisting: true },
        root,
      );
      expect(refused).toMatchObject({ ok: false, code: "elided_content" });
      expect(refused.text).toContain("context_recall");
      expect(refused.text).toContain("da78b0b5#args");
      expect(refused.text).toContain("generate");
      if (target === "note.txt") {
        expect(readFileSync(path.join(root, target), "utf8")).toBe("alpha\nbeta\nalpha\n");
      } else {
        expect(existsSync(path.join(root, "docs"))).toBe(false);
      }
      const recovered = await run(
        "write_file",
        { path: target, content: "The actual plan.\n", overwriteExisting: true },
        root,
      );
      expect(recovered.ok).toBe(true);
      expect(readFileSync(path.join(root, target), "utf8")).toBe("The actual plan.\n");
    },
  );

  it("write_file preserves elision examples embedded in real documents", async () => {
    const content = "Example of a history marker:\n[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]\n";
    const result = await run("write_file", { path: "example.md", content }, root);
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(root, "example.md"), "utf8")).toBe(content);
  });

  it("write_file preserves mixed text literally rather than inferring whether a marker is intentional", async () => {
    const content = "# Implementation plan\n\n[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]\n";
    const result = await run(
      "write_file",
      {
        path: "plan.md",
        content,
      },
      root,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(root, "plan.md"), "utf8")).toBe(content);
  });

  it("edit_file can intentionally insert a literal marker into a document", async () => {
    const result = await run(
      "edit_file",
      {
        path: "note.txt",
        old_string: "beta",
        new_string: "[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]",
      },
      root,
    );
    expect({ ok: result.ok, content: readFileSync(path.join(root, "note.txt"), "utf8") }).toEqual({
      ok: true,
      content: "alpha\n[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]\nalpha\n",
    });
  });

  it("edit_file refuses an elided match with recovery guidance", async () => {
    const result = await run(
      "edit_file",
      {
        path: "note.txt",
        old_string: "[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]",
        new_string: "the actual replacement",
      },
      root,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("elided_match");
    expect(result.text).toMatch(/elision|abbreviat/i);
    expect(result.text).toContain("context_recall");
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("alpha\nbeta\nalpha\n");
  });

  it("shell writes literal marker text when explicitly supplied in a script", async () => {
    const result = await run(
      "shell",
      { command: "printf '%s' '[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]' > plan.md" },
      root,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(root, "plan.md"), "utf8")).toBe(
      "[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]",
    );
  });

  it("edit_file can replace an actual marker already present in the file", async () => {
    const marker = "[elided: 182 lines, 18.6 KB — recall job:da78b0b5#args]";
    writeFileSync(path.join(root, "note.txt"), marker);
    const result = await run("edit_file", { path: "note.txt", old_string: marker, new_string: "recovered text" }, root);
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("recovered text");
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

  it("update_metadata and context_need propose their effects through execute", async () => {
    const actions: unknown[] = [];
    const context = {
      root,
      storage: { session: {}, invocation: {}, propose: (action: unknown) => actions.push(action) },
    };
    const executeMetadata = catalog.catalogEntry("update_metadata")?.execute;
    const executeNeed = catalog.catalogEntry("context_need")?.execute;
    invariant(executeMetadata !== undefined, "no execute for update_metadata");
    invariant(executeNeed !== undefined, "no execute for context_need");
    const meta = await executeMetadata(
      { current_turn_title: "  Title  ", current_turn_description: "Doing work" },
      context,
    );
    const need = await executeNeed({ min_remaining_tokens: 100 }, context);
    expect({ meta, need, actions }).toEqual({
      meta: { ok: true, value: { current_turn_title: "Title", current_turn_description: "Doing work" } },
      need: { ok: true, value: { ok: true } },
      actions: [
        { type: "metadata-updated", title: "Title", description: "Doing work" },
        { type: "context-need", need: { min_remaining_tokens: 100 } },
      ],
    });
  });
});
