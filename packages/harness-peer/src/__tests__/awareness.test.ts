import { ReactiveAwareness } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import { bindAwareness, encodeLocalAwarenessFrame, forwardAwareness, ingestAwareness } from "../awareness.js";

function hubs(): { author: ReactiveAwareness; replica: ReactiveAwareness } {
  return {
    author: new ReactiveAwareness(),
    replica: new ReactiveAwareness(),
  };
}

describe("awareness plane", () => {
  it("forwards a local write onto a replica; remote ingest does not echo; bind sends local writes", () => {
    const forward = hubs();
    const outbound: string[] = [];
    const echoed: string[] = [];
    const stopAuthor = forwardAwareness(forward.author, (frame) => outbound.push(frame));
    const stopReplica = forwardAwareness(forward.replica, (frame) => echoed.push(frame));
    forward.author.setLocalStateField("role:expectation:live", {
      text: "hello ",
      thought: "",
    });
    for (const frame of outbound) ingestAwareness(forward.replica, frame);

    const bind = hubs();
    const fromAuthor: string[] = [];
    const stopBindAuthor = forwardAwareness(bind.author, (frame) => fromAuthor.push(frame));
    bind.author.setLocalStateField("role:expectation:live", {
      text: "hi",
      thought: "hmm",
    });
    const fromReplica: string[] = [];
    let deliver: (frame: string) => void = () => undefined;
    const stopBind = bindAwareness(bind.replica, {
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
    const author = new ReactiveAwareness();
    const replica = new ReactiveAwareness();
    author.setLocalStateField("attention", [{ kind: "connection", id: "work" }]);
    author.setLocalStateField("seat", { sessionId: "s1" });
    const frame = encodeLocalAwarenessFrame(author);
    expect(frame).not.toBeNull();
    ingestAwareness(replica, frame!);
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
