import { mkdtemp, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DocumentContainer, Model, model, state } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import { checkpointOf, documentKey } from "@/protocol/document";
import { DocumentContentStore } from "../content-store.js";
import { createFsImageSource } from "../registry/images.js";
import { DocumentImageStore } from "../storage.js";

@model("test:content:document")
class ContentRoot extends Model {
  @state accessor sessionId = "";
  @state accessor body = "";
}

describe("shared document content", () => {
  it("stores a body once across images, survives restart, and collects only unused content", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-content-"));
    try {
      const body = "shared body ".repeat(10_000) + "\ud800";
      const store = new DocumentImageStore(root);
      const paths: string[] = [];
      for (const id of ["a", "b"]) {
        const doc = new DocumentContainer(new ContentRoot({ sessionId: id, body }));
        const key = documentKey("sessions", id);
        expect(
          (
            await store.flush({
              checkpoint: checkpointOf(doc, key, 1, 1),
              image: doc.encodeStateAsUpdate(),
              runtimeGeneration: 1,
              connectionEpoch: 1,
            })
          ).ok,
        ).toBe(true);
        paths.push(store.pathFor(key));
        expect((await readFile(store.pathFor(key))).length).toBeLessThan(2000);
        doc.destroy();
      }
      const fans = await readdir(join(root, "documents", "content"));
      const contents = (
        await Promise.all(
          fans.map(async (fan) =>
            (await readdir(join(root, "documents", "content", fan))).map((hash) =>
              join(root, "documents", "content", fan, hash),
            ),
          ),
        )
      ).flat();
      expect(contents).toHaveLength(1);
      const reopened = new DocumentImageStore(root);
      const image = await reopened.read(documentKey("sessions", "b"));
      const restored = new DocumentContainer(new ContentRoot());
      if (image === undefined) throw new Error("missing image");
      restored.applyUpdate(image);
      expect(restored.root.body).toBe(body);
      await unlink(paths[0]);
      expect(await reopened.collectContentGarbage()).toBe(0);
      await unlink(paths[1]);
      expect(await reopened.collectContentGarbage()).toBe(1);
      restored.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing body as corruption rather than hiding the document from inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-content-missing-"));
    try {
      const content = new DocumentContentStore(root);
      const rootDoc = new DocumentContainer(new ContentRoot({ sessionId: "s", body: "body".repeat(1000) }));
      const store = new DocumentImageStore(root);
      const key = documentKey("sessions", "s");
      await store.flush({
        checkpoint: checkpointOf(rootDoc, key, 1, 1),
        image: rootDoc.encodeStateAsUpdate(),
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const fan = (await readdir(join(root, "documents", "content")))[0];
      if (fan === undefined) throw new Error("missing body");
      const hash = (await readdir(join(root, "documents", "content", fan)))[0];
      await unlink(join(root, "documents", "content", fan, hash));
      await expect(createFsImageSource(root).read(store.pathFor(key))).rejects.toMatchObject({ code: "ENOENT" });
      const held = Promise.withResolvers<void>();
      const reader = content.withImageAccess(() => held.promise);
      await expect(store.collectContentGarbage()).rejects.toThrow("idle root");
      held.resolve();
      await reader;
      rootDoc.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares maintenance admission across filesystem aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-content-alias-"));
    try {
      const first = new DocumentContentStore(root);
      const second = new DocumentContentStore(await realpath(root));
      const release = Promise.withResolvers<void>();
      const reader = first.withImageAccess(() => release.promise);
      try {
        await expect(second.collectGarbage()).rejects.toThrow("idle root");
      } finally {
        release.resolve();
        await reader;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
