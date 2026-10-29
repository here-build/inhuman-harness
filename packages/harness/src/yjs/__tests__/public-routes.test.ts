import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { documentKey } from "@/protocol/document";

import { classifyPublicUpgrade, UPGRADE_NOT_FOUND, YjsServer } from "../index.js";
import { SESSION_ROOT_TYPE } from "../registry/identity.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "yjs-routes-"));
  temps.push(root);
  return root;
}

function encodeSession(sessionId: string, extra?: string): Uint8Array {
  const doc = new Y.Doc();
  const typeMap = new Y.Map();
  doc.getMap("types").set(SESSION_ROOT_TYPE, typeMap);
  const node = new Y.XmlElement(SESSION_ROOT_TYPE);
  typeMap.set("extract-root", node);
  node.setAttribute("sessionId", sessionId);
  doc.getMap("meta").set("root", "extract-root");
  if (extra != null) doc.getMap("root").set("extra", extra);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

describe("public routes", () => {
  it("classifies existing open separately from delegated creation", () => {
    expect({
      session: classifyPublicUpgrade("/session?sessionId=s1"),
      create: classifyPublicUpgrade("/session?path=/tmp/ws"),
      mint: classifyPublicUpgrade("/session?path=/tmp/ws&sessionId=s1"),
      missing: classifyPublicUpgrade("/session"),
      kernel: classifyPublicUpgrade("/kernel"),
      unknown: classifyPublicUpgrade("/nope"),
    }).toEqual({
      session: {
        action: "open",
        key: { kind: "sessions", id: "s1" },
      },
      create: { action: "create", room: "session", path: "/tmp/ws" },
      mint: {
        action: "create",
        room: "session",
        path: "/tmp/ws",
        sessionId: "s1",
      },
      missing: { action: "refuse", status: 400, reason: "missing path" },
      kernel: {
        action: "open",
        key: { kind: "kernel", id: "kernel" },
      },
      unknown: {
        action: "refuse",
        status: UPGRADE_NOT_FOUND,
        reason: "not found",
      },
    });
  });

  it("open-existing of a classified identity does not mint; create is separate", async () => {
    const yjs = new YjsServer({ root: tempRoot() });
    const classified = classifyPublicUpgrade("/session?sessionId=s1");
    expect(classified.action).toBe("open");
    if (classified.action !== "open") return;
    const missing = await yjs.openExisting(classified.key);
    const created = await yjs.create(documentKey("sessions", "s1"), encodeSession("s1", "minted"));
    const opened = await yjs.openExisting(classified.key);
    expect({
      missing,
      created: created.ok,
      extra: created.ok ? created.ref.doc.getMap("root").get("extra") : undefined,
      same: opened.ok && created.ok && opened.room.doc === created.ref.doc,
    }).toEqual({
      missing: { ok: false, reason: "not-found" },
      created: true,
      extra: "minted",
      same: true,
    });
    yjs[Symbol.dispose]();
  });
});
