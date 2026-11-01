import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { evalProgramOf, findEvalTurnByRequestId } from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { when } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";

import { openWorld } from "../__tests__/world.js";

const TIMEOUT = 20_000;

describe("eval CLI reconnect", () => {
  it(
    "reconnects mid-flight to the same program and does not admit another",
    async () => {
      const { kernel, workspace } = await openWorld();
      execFileSync("mkfifo", [join(workspace, "hang.fifo")]);
      const client = await Client.start(kernel, workspace);
      const admitted = (await client.request("eval", {
        requestId: "req-mid",
        expr: '(read_file "hang.fifo")',
        policy: "yolo",
      })) as { ok: true; turnId: string; programId: string };
      await when(() => evalProgramOf(findEvalTurnByRequestId(client.sessionRoot, "req-mid")!) != null, {
        timeout: TIMEOUT,
      });
      const sessionId = client.sessionId;
      await client[Symbol.asyncDispose]();
      const again = await Client.connect(kernel, workspace, sessionId);
      onTestFinished(async () => {
        await again[Symbol.asyncDispose]();
      });
      const turn = findEvalTurnByRequestId(again.sessionRoot, "req-mid");
      const program = evalProgramOf(turn!);
      const reused = (await again.request("eval", {
        requestId: "req-mid",
        expr: '(read_file "hang.fifo")',
        policy: "yolo",
      })) as { ok: true; turnId: string; programId: string };
      expect({
        completed: program?.completed ?? true,
        programId: program?.uuid,
        reused,
      }).toEqual({
        completed: false,
        programId: admitted.programId,
        reused: { ok: true, turnId: admitted.turnId, programId: admitted.programId },
      });
      await again.request("turn/cancel", { requestId: "req-mid" });
    },
    TIMEOUT,
  );
});
