/**
 * Client attention occupancy: kernel-plane publish, retract, dispose.
 * Interned connections outlive a session wrap, so occupancy is not session-plane.
 */
import { PlexusAwareness, resetLocalIDs } from "@here.build/plexus";
import { KernelPlexus, KernelRoot, ProjectPlexus } from "@inhuman.tools/harness-model/kernel";
import { SessionPlexus } from "@inhuman.tools/harness-model/session";
import { forwardPlexusAwareness, ingestPlexusAwareness } from "@inhuman.tools/harness-peer/awareness";
import { revalidationDemandOf, ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { observable } from "mobx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Client } from "../client.js";

describe("client kernel attention", () => {
  beforeEach(() => resetLocalIDs());

  const clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client[Symbol.asyncDispose]();
  });

  it("publishes occupancy onto kernel awareness, not the session hub", async () => {
    const client = openClient();
    const driver = new DriverSpec({ name: "openai-compat", importPath: "test:openai" });
    const wire = new ConnectionSpec({ driver, name: "work" });
    client.kernelRoot.drivers = { "openai-compat": driver };
    client.kernelRoot.connections = { work: wire };
    const listed = observable.box(true);
    const focused = observable.box(true);

    client.setComputedAttention(() => (listed.get() ? [wire] : []));
    client.setComputedAttentionFocus(() => (focused.get() ? wire : null));

    const target = { kind: "connection", id: "work" } as const;
    expect(revalidationDemandOf(client.kernelPlexus.awareness, target)).toBe("primary");
    expect(revalidationDemandOf(client.sessionPlexus.awareness, target)).toBe("none");

    focused.set(false);
    expect(revalidationDemandOf(client.kernelPlexus.awareness, target)).toBe("secondary");

    listed.set(false);
    expect(revalidationDemandOf(client.kernelPlexus.awareness, target)).toBe("none");
  });

  it("unions simultaneous clients; dispose retracts only that client's lanes", async () => {
    const a = openClient({ sessionId: "s-a" });
    const b = openClient({ sessionId: "s-b" });
    const driver = new DriverSpec({ name: "openai-compat", importPath: "test:openai" });
    const wire = new ConnectionSpec({ driver, name: "work" });
    a.kernelRoot.drivers = { "openai-compat": driver };
    a.kernelRoot.connections = { work: wire };
    const replica = new PlexusAwareness(new Y.Doc());
    const stopA = forwardPlexusAwareness(a.kernelPlexus.awareness, (frame) => ingestPlexusAwareness(replica, frame));
    const stopB = forwardPlexusAwareness(b.kernelPlexus.awareness, (frame) => ingestPlexusAwareness(replica, frame));
    try {
      a.setComputedAttention(() => [wire]);
      b.setComputedAttentionFocus(() => wire);

      const target = { kind: "connection", id: "work" } as const;
      expect(revalidationDemandOf(replica, target)).toBe("primary");
      expect(revalidationDemandOf(a.sessionPlexus.awareness, target)).toBe("none");

      await b[Symbol.asyncDispose]();
      clients.splice(clients.indexOf(b), 1);
      expect(revalidationDemandOf(replica, target)).toBe("secondary");

      await a[Symbol.asyncDispose]();
      clients.splice(clients.indexOf(a), 1);
      expect(revalidationDemandOf(replica, target)).toBe("none");
    } finally {
      stopA();
      stopB();
      replica.destroy();
    }
  });

  function openClient(opts?: { sessionId?: string }): Client {
    const sessionId = opts?.sessionId ?? "s";
    const client = new Client(
      "/tmp/k",
      "/tmp/p",
      sessionId,
      KernelPlexus.bootstrap(new KernelRoot()),
      ProjectPlexus.create("/tmp/p"),
      SessionPlexus.create(sessionId, "/tmp/p"),
    );
    clients.push(client);
    return client;
  }
});
