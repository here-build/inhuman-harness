import { KernelDocument } from "@inhuman.tools/harness-model/kernel";
import { detachLocalPresence, encodeLocalAwarenessFrame, RoomConnection } from "@inhuman.tools/harness-peer";
import { describe, expect, it } from "vitest";

describe("detachLocalPresence", () => {
  it("clears default local state so presence query does not advertise an empty entry", () => {
    const doc = KernelDocument.create();
    const connection = new RoomConnection("ws://127.0.0.1:1", "kernel", doc, { connect: false });
    connection.awareness.setLocalState({ init: true });
    expect(encodeLocalAwarenessFrame(connection.awareness)).not.toBeNull();
    detachLocalPresence(connection);
    expect(connection.awareness.getLocalState()).toBeNull();
    expect(encodeLocalAwarenessFrame(connection.awareness)).toBeNull();
    connection.destroy();
    doc.destroy();
  });
});
