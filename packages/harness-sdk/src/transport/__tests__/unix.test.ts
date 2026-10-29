import { MESSAGE_QUERY_AWARENESS } from "@inhuman.tools/harness-peer";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { detachProtocolAwareness } from "../unix.js";

describe("detachProtocolAwareness", () => {
  it("stock QUERY no longer dumps {} after detach — that frame is plexus channel 0", () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider("ws://127.0.0.1:1", "n", doc, { connect: false, disableBc: true });
    provider.disconnectBc = () => undefined;
    const decoder = () => decoding.createDecoder(new Uint8Array([0]));
    const stock = encoding.createEncoder();
    provider.messageHandlers[MESSAGE_QUERY_AWARENESS](stock, decoder(), provider, false, MESSAGE_QUERY_AWARENESS);
    detachProtocolAwareness(provider);
    const silent = encoding.createEncoder();
    provider.messageHandlers[MESSAGE_QUERY_AWARENESS](silent, decoder(), provider, false, MESSAGE_QUERY_AWARENESS);
    expect({
      stockReply: encoding.length(stock) > 1,
      local: provider.awareness.getLocalState(),
      query: encoding.length(silent),
    }).toEqual({ stockReply: true, local: null, query: 0 });
    provider.destroy();
    doc.destroy();
  });
});
