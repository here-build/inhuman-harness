import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelDocument } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { KernelReflector } from "../fs-reflection/KernelReflector.js";

describe("KernelReflector (native watchFiles)", () => {
  it("reflects on boot and follows a config.json written after start", async () => {
    const root = mkdtempSync(join(tmpdir(), "reflect-native-"));
    mkdirSync(join(root, "documents", "kernel"), { recursive: true });
    const doc = KernelDocument.bootstrap();

    using reflector = new KernelReflector(root, doc.root);
    await reflector.ready;
    expect(doc.root.commands.compact?.source).toContain("compact.scm");

    // config.json lands after the watcher started; the poll loop must pick it up.
    writeFileSync(join(root, "config.json"), JSON.stringify({ connections: {}, compact: "./my.scm" }));
    writeFileSync(join(root, "my.scm"), "(defined)");

    const reflected = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      const check = setInterval(() => {
        if (doc.root.compactStrategy.includes("my.scm")) {
          clearTimeout(timer);
          clearInterval(check);
          resolve(true);
        }
      }, 50);
    });
    expect(reflected).toBe(true);

    reflector[Symbol.dispose]();
    rmSync(root, { recursive: true, force: true });
  }, 12_000);

  it("re-reflects when a watched file changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "reflect-native2-"));
    mkdirSync(join(root, "documents", "kernel"), { recursive: true });
    const doc = KernelDocument.bootstrap();
    writeFileSync(join(root, "config.json"), JSON.stringify({ connections: {}, defaultPermissionMode: "manual" }));

    using reflector = new KernelReflector(root, doc.root);
    await reflector.ready;
    expect(doc.root.defaultPermissionMode).toBe("manual");

    // Let the watcher arm before editing; a same-tick write can outrun kqueue.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // An edit to the already-watched config.json must re-run the reflector.
    writeFileSync(join(root, "config.json"), JSON.stringify({ connections: {}, defaultPermissionMode: "yolo" }));
    const saw = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      const check = setInterval(() => {
        if (doc.root.defaultPermissionMode === "yolo") {
          clearTimeout(timer);
          clearInterval(check);
          resolve(true);
        }
      }, 50);
    });
    expect(saw).toBe(true);

    reflector[Symbol.dispose]();
    rmSync(root, { recursive: true, force: true });
  }, 12_000);
});
