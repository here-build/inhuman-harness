import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  documentImageFileName,
  KERNEL_DOCUMENT_GUID,
  KERNEL_DOCUMENT_KEY,
  publicRoomName,
  sessionDocumentGuid,
  sha256Hex,
} from "../document/index.js";

describe("document keys", () => {
  it("hashes storage identity the same way as node sha256", () => {
    expect(sha256Hex("kernel")).toBe(createHash("sha256").update("kernel").digest("hex"));
    expect(documentImageFileName("s1")).toBe(`${createHash("sha256").update("s1").digest("hex")}.yjs`);
    expect(publicRoomName("sessions")).toBe("session");
    expect(sessionDocumentGuid("s1")).toBe("harness:session:s1");
    expect(KERNEL_DOCUMENT_KEY).toEqual({ kind: "kernel", id: "kernel" });
    expect(KERNEL_DOCUMENT_GUID).toBe("harness:kernel");
  });
});
