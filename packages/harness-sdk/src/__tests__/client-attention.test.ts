/**
 * Client attention occupancy: kernel-plane publish, retract, dispose.
 * Interned connections outlive a session wrap, so occupancy is not session-plane.
 */
import { revalidationDemandOf, ConnectionSpec, DriverSpec } from "@inhuman.tools/expectations";
import { KernelDocument, KernelRoot, ProjectDocument } from "@inhuman.tools/harness-model/kernel";
import { SessionDocument } from "@inhuman.tools/harness-model/session";
import { forwardAwareness, ingestAwareness } from "@inhuman.tools/harness-peer/awareness";
import { ReactiveAwareness } from "@inhuman.tools/model";
import { observable } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import { Client } from "../client.js";

describe("client kernel attention", () => {
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
    expect(revalidationDemandOf(client.kernelDoc.awareness, target)).toBe("primary");
    expect(revalidationDemandOf(client.sessionDoc.awareness, target)).toBe("none");

    focused.set(false);
    expect(revalidationDemandOf(client.kernelDoc.awareness, target)).toBe("secondary");

    listed.set(false);
    expect(revalidationDemandOf(client.kernelDoc.awareness, target)).toBe("none");
  });

  it("unions simultaneous clients; dispose retracts only that client's lanes", async () => {
    const a = openClient({ sessionId: "s-a" });
    const b = openClient({ sessionId: "s-b" });
    const driver = new DriverSpec({ name: "openai-compat", importPath: "test:openai" });
    const wire = new ConnectionSpec({ driver, name: "work" });
    a.kernelRoot.drivers = { "openai-compat": driver };
    a.kernelRoot.connections = { work: wire };
    const replica = new ReactiveAwareness();
    const stopA = forwardAwareness(a.kernelDoc.awareness, (frame) => ingestAwareness(replica, frame));
    const stopB = forwardAwareness(b.kernelDoc.awareness, (frame) => ingestAwareness(replica, frame));
    try {
      a.setComputedAttention(() => [wire]);
      b.setComputedAttentionFocus(() => wire);

      const target = { kind: "connection", id: "work" } as const;
      expect(revalidationDemandOf(replica, target)).toBe("primary");
      expect(revalidationDemandOf(a.sessionDoc.awareness, target)).toBe("none");

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
      KernelDocument.bootstrap(new KernelRoot()),
      ProjectDocument.create("/tmp/p"),
      SessionDocument.create(sessionId, "/tmp/p"),
    );
    clients.push(client);
    return client;
  }
});
