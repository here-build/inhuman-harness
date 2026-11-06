import { KernelDocument } from "@inhuman.tools/harness-model/kernel";
import { detachProtocolAwareness, encodeLocalAwarenessFrame, WebsocketProvider } from "@inhuman.tools/harness-peer";
import { describe, expect, it } from "vitest";

describe("detachProtocolAwareness", () => {
  it("stock QUERY no longer dumps {} after detach — that frame is plexus channel 0", () => {
    const doc = KernelDocument.create();
    const provider = new WebsocketProvider("ws://127.0.0.1:1", "n", doc, { connect: false });
    provider.awareness.setLocalState({ init: true });
    expect(encodeLocalAwarenessFrame(provider.awareness)).not.toBeNull();
    detachProtocolAwareness(provider);
    expect(provider.awareness.getLocalState()).toBeNull();
    expect(encodeLocalAwarenessFrame(provider.awareness)).toBeNull();
    provider.destroy();
    doc.destroy();
  });
});
