import { PlexusAwareness } from "@here.build/plexus";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  bindPlexusAwareness,
  encodeLocalAwarenessFrame,
  forwardPlexusAwareness,
  ingestPlexusAwareness,
} from "../awareness.js";

function hubs(): { author: PlexusAwareness; replica: PlexusAwareness } {
  return {
    author: new PlexusAwareness(new Y.Doc()),
    replica: new PlexusAwareness(new Y.Doc()),
  };
}

describe("plexus awareness plane", () => {
  it("forwards a local write onto a replica; remote ingest does not echo; bind sends local writes", () => {
    const forward = hubs();
    const outbound: Uint8Array[] = [];
    const echoed: Uint8Array[] = [];
    const stopAuthor = forwardPlexusAwareness(forward.author, (frame) => outbound.push(frame));
    const stopReplica = forwardPlexusAwareness(forward.replica, (frame) => echoed.push(frame));
    forward.author.setLocalStateField("role:expectation:live", {
      text: "hello ",
      thought: "",
    });
    for (const frame of outbound) ingestPlexusAwareness(forward.replica, frame);

    const bind = hubs();
    const fromAuthor: Uint8Array[] = [];
    const stopBindAuthor = forwardPlexusAwareness(bind.author, (frame) => fromAuthor.push(frame));
    bind.author.setLocalStateField("role:expectation:live", {
      text: "hi",
      thought: "hmm",
    });
    const fromReplica: Uint8Array[] = [];
    let deliver: (frame: Uint8Array) => void = () => undefined;
    const stopBind = bindPlexusAwareness(bind.replica, {
      send(frame) {
        fromReplica.push(frame);
      },
      subscribe(handler) {
        deliver = handler;
        return () => {
          deliver = () => undefined;
        };
      },
    });
    for (const frame of fromAuthor) deliver(frame);
    const inbound = bind.replica.getField("role:expectation:live", bind.author.clientID);
    const bindEcho = [...fromReplica];
    bind.replica.setLocalStateField("attention", []);

    expect({
      replica: forward.replica.getField("role:expectation:live", forward.author.clientID),
      echoed,
      inbound,
      bindEcho,
      localOut: fromReplica.length > 0,
    }).toEqual({
      replica: { text: "hello ", thought: "" },
      echoed: [],
      inbound: { text: "hi", thought: "hmm" },
      bindEcho: [],
      localOut: true,
    });

    stopAuthor();
    stopReplica();
    stopBindAuthor();
    stopBind();
    forward.author.destroy();
    forward.replica.destroy();
    bind.author.destroy();
    bind.replica.destroy();
  });

  it("reconnect flush re-enters local occupancy without a new write", () => {
    const author = new PlexusAwareness(new Y.Doc());
    const replica = new PlexusAwareness(new Y.Doc());
    author.setLocalStateField("attention", [{ kind: "connection", id: "work" }]);
    author.setLocalStateField("seat", { sessionId: "s1" });
    const frame = encodeLocalAwarenessFrame(author);
    expect(frame).not.toBeNull();
    ingestPlexusAwareness(replica, frame!);
    expect({
      attention: replica.getField("attention", author.clientID),
      seat: replica.getField("seat", author.clientID),
    }).toEqual({
      attention: [{ kind: "connection", id: "work" }],
      seat: { sessionId: "s1" },
    });
    author.destroy();
    replica.destroy();
  });
});
