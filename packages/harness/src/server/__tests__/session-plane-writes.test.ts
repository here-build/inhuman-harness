/**
 * Session plane is a lens for clients: the daemon is the one writer, and a
 * client changes session state through RPC (`door-writes.test.ts`).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import { SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { HarnessDaemon } from "../daemon/server/HarnessDaemon.js";

const SYNC_MS = 10_000;

describe("session plane writes", () => {
  it("a client replica write never reaches the daemon", async () => {
    const kernel = realpathSync(mkdtempSync(join(tmpdir(), "harness-peer-write-k-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-peer-write-p-")));
    try {
      await using daemon = new HarnessDaemon(kernel);
      await daemon.listen();
      await using client = await Client.start(kernel, workspace);
      const project = await daemon.project(workspace);
      const host = await project.session(client.sessionId);
      const leaf = new SystemToolJob({
        toolCallId: "ask-1",
        name: "write_file",
        argsJson: JSON.stringify({ path: "README.md", content: "hi" }),
        policyResult: "ask",
      });
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`write`,
        doneWork: [leaf],
        queue: [],
      });
      turn.pushChild(leaf);
      host.root.head = turn;

      await when(() => client.sessionRoot.head?.approvalHead != null, { timeout: SYNC_MS });
      const replica = client.sessionRoot.head!.approvalHead!;
      replica.humanApprove = true;
      // Same socket, so a refused request is a barrier behind the replica UPDATE.
      const barrier = await client.request("ask/answer", { sessionId: "nobody", jobId: leaf.uuid, allow: true });
      expect({ barrier, approve: leaf.humanApprove }).toEqual({
        barrier: { ok: false, reason: "not-pending" },
        approve: null,
      });
    } finally {
      rmSync(kernel, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
