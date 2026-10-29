import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { documentImageFileName, documentKey, KERNEL_DOCUMENT_KEY, sha256Hex } from "@/protocol/document";

import {
  decodeImageIdentity,
  documentGuid,
  documentImagePath,
  identifyStoredImage,
  PROJECT_ROOT_TYPE,
  SESSION_ROOT_TYPE,
} from "../registry/identity.js";
import { encodeLogEntry } from "../update-log.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "yjs-identity-"));
  temps.push(root);
  return root;
}

function encodeRoot(typeName: string, field: string, id: string): Uint8Array {
  const doc = new Y.Doc();
  const typeMap = new Y.Map();
  doc.getMap("types").set(typeName, typeMap);
  const node = new Y.XmlElement(typeName);
  typeMap.set("extract-root", node);
  node.setAttribute(field, id);
  node.setAttribute("noise", "ignored");
  doc.getMap("meta").set("root", "extract-root");
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function writeImage(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodeLogEntry(bytes));
}

describe("stored image identity", () => {
  it("decodes session and project ids from the hashed path shape", () => {
    const root = tempRoot();
    const sessionId = "s1";
    const projectPath = "/tmp/workspace";
    const sessionFile = documentImagePath(root, "sessions", sessionId);
    const projectFile = documentImagePath(root, "projects", projectPath);
    writeImage(sessionFile, encodeRoot(SESSION_ROOT_TYPE, "sessionId", sessionId));
    writeImage(projectFile, encodeRoot(PROJECT_ROOT_TYPE, "path", projectPath));
    expect(sessionFile).toBe(join(root, "documents", "sessions", documentImageFileName(sessionId)));
    expect(projectFile).toBe(join(root, "documents", "projects", `${sha256Hex(projectPath)}.yjs`));
    expect(identifyStoredImage(root, "sessions", sessionFile, readFileSync(sessionFile))).toEqual({
      ok: true,
      id: sessionId,
    });
    expect(identifyStoredImage(root, "projects", projectFile, readFileSync(projectFile))).toEqual({
      ok: true,
      id: projectPath,
    });
  });

  it("treats kernel as a fixed identity at sha256(kernel).yjs", () => {
    const root = tempRoot();
    const doc = new Y.Doc();
    doc.getMap("root").set("k", "v");
    const bytes = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const path = documentImagePath(root, "kernel", KERNEL_DOCUMENT_KEY.id);
    expect(path.endsWith(join("documents", "kernel", `${sha256Hex("kernel")}.yjs`))).toBe(true);
    expect(identifyStoredImage(root, "kernel", path, encodeLogEntry(bytes))).toEqual({
      ok: true,
      id: "kernel",
    });
  });

  it("records mismatch, empty, corrupt, and decode-failure without publishing", () => {
    const root = tempRoot();
    const sessionBytes = encodeRoot(SESSION_ROOT_TYPE, "sessionId", "s1");
    const wrongPath = documentImagePath(root, "sessions", "other");
    expect(identifyStoredImage(root, "sessions", wrongPath, encodeLogEntry(sessionBytes))).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(decodeImageIdentity("sessions", new Uint8Array())).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(decodeImageIdentity("sessions", new Uint8Array([0, 1, 2, 3]))).toEqual({
      ok: false,
      reason: "corrupt",
    });
    const emptyDoc = new Y.Doc();
    const hollow = Y.encodeStateAsUpdate(emptyDoc);
    emptyDoc.destroy();
    expect(decodeImageIdentity("sessions", encodeLogEntry(hollow))).toEqual({
      ok: false,
      reason: "decode-failure",
    });
    expect(decodeImageIdentity("sessions", encodeLogEntry(sessionBytes))).toEqual({
      ok: true,
      id: "s1",
    });
    const logged = encodeLogEntry(sessionBytes);
    const barePlusTail = new Uint8Array(sessionBytes.byteLength + logged.byteLength);
    barePlusTail.set(sessionBytes, 0);
    barePlusTail.set(logged, sessionBytes.byteLength);
    expect({
      logged: decodeImageIdentity("sessions", logged),
      barePlusTail: decodeImageIdentity("sessions", barePlusTail),
    }).toEqual({
      logged: { ok: true, id: "s1" },
      barePlusTail: { ok: false, reason: "corrupt" },
    });
    expect(documentKey("sessions", "s1")).toEqual({
      kind: "sessions",
      id: "s1",
    });
    expect({
      kernel: documentGuid(KERNEL_DOCUMENT_KEY),
      session: documentGuid(documentKey("sessions", "s1")),
      project: documentGuid(documentKey("projects", "/tmp/workspace")),
    }).toEqual({
      kernel: "harness:kernel",
      session: "harness:session:s1",
      project: "harness:project",
    });
  });
});
