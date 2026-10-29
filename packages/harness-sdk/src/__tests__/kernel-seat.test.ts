import { PlexusAwareness } from "@here.build/plexus";
import {
  occupiedSessionIds,
  unseatedConversationIds,
  otherSessionSeatCount,
  publishKernelSeat,
  sessionIsOccupied,
} from "@inhuman.tools/harness-model/kernel";
import { forwardPlexusAwareness, ingestPlexusAwareness } from "@inhuman.tools/harness-peer/awareness";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

describe("kernel seat", () => {
  it("replica sees a published seat; clear frees it", () => {
    const author = new PlexusAwareness(new Y.Doc());
    const replica = new PlexusAwareness(new Y.Doc());
    const stop = forwardPlexusAwareness(author, (frame) => ingestPlexusAwareness(replica, frame));

    publishKernelSeat(author, "s1");
    expect({
      local: sessionIsOccupied(author, "s1"),
      replica: sessionIsOccupied(replica, "s1"),
      ids: [...occupiedSessionIds(replica)],
    }).toEqual({ local: true, replica: true, ids: ["s1"] });

    publishKernelSeat(author, null);
    expect(sessionIsOccupied(replica, "s1")).toBe(false);

    stop();
    author.destroy();
    replica.destroy();
  });

  it("other seats exclude the local window", () => {
    const local = new PlexusAwareness(new Y.Doc());
    const peer = new PlexusAwareness(new Y.Doc());
    const elsewhere = new PlexusAwareness(new Y.Doc());
    const stopPeer = forwardPlexusAwareness(peer, (frame) => ingestPlexusAwareness(local, frame));
    const stopElsewhere = forwardPlexusAwareness(elsewhere, (frame) => ingestPlexusAwareness(local, frame));

    publishKernelSeat(local, "s1");
    publishKernelSeat(peer, "s1");
    publishKernelSeat(elsewhere, "s2");
    expect({
      shared: otherSessionSeatCount(local, "s1"),
      otherSession: otherSessionSeatCount(local, "s2"),
      alone: otherSessionSeatCount(peer, "s1"),
    }).toEqual({ shared: 1, otherSession: 1, alone: 0 });

    stopPeer();
    stopElsewhere();
    local.destroy();
    peer.destroy();
    elsewhere.destroy();
  });

  it("orphans sort by recency and skip occupied", () => {
    expect(
      unseatedConversationIds(
        {
          old: { lastMessageAt: 1 },
          live: { lastMessageAt: 9 },
          fresh: { lastMessageAt: 5 },
          worker: { lastMessageAt: 20, recipeScope: "session" },
          ask: { lastMessageAt: 15, oneShot: true },
        },
        new Set(["live"]),
      ),
    ).toEqual(["fresh", "old"]);
  });
});
