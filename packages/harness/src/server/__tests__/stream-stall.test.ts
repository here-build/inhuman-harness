import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentCallJob,
  CompletionExpectation,
  FailureOutcome,
  SessionTurn,
  tapeCompletion,
} from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { walkWork } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import { OpenAiCompatActor } from "@/providers/openai-compat";

import type { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";
import { HarnessDaemon } from "../daemon/server/HarnessDaemon.js";

const PARENT = "delegate now";
const WORKER = "inspect the latch";
const PARTIAL = "partial answer";
const STALL_MS = 200;

async function listenStall() {
  let workerPosts = 0;
  let delegated = false;
  let releaseWorker: () => void = () => undefined;
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  const hung: ServerResponse[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m1" }] }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.includes("Probe prefix")) {
      json(res, { choices: [{ message: { content: "p" }, finish_reason: "stop" }] });
      return;
    }
    if (raw.includes(WORKER) && !raw.includes(PARENT)) {
      workerPosts += 1;
      await workerGate;
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: PARTIAL } }] })}\n\n`);
      hung.push(res);
      return;
    }
    if (!delegated) {
      delegated = true;
      json(res, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_ask",
                  type: "function",
                  function: { name: "agent__ask", arguments: JSON.stringify({ message: WORKER }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
      return;
    }
    json(res, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  };
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(addr.port);
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    workerPosts: () => workerPosts,
    releaseWorker: () => releaseWorker(),
    close: async () => {
      releaseWorker();
      for (const res of hung) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function turnsOf(root: { head: unknown; liveTurns: Iterable<SessionTurn> }): SessionTurn[] {
  const out: SessionTurn[] = [];
  const seen = new Set<SessionTurn>();
  let unit: unknown = root.head;
  while (unit instanceof SessionTurn && !seen.has(unit)) {
    seen.add(unit);
    out.push(unit);
    unit = unit.turnTail instanceof SessionTurn ? unit.turnTail : null;
  }
  for (const turn of root.liveTurns) {
    if (seen.has(turn)) continue;
    seen.add(turn);
    out.push(turn);
  }
  return out;
}

function armStall(project: ProjectDaemon): boolean {
  for (const session of Object.values(project.sessions)) {
    for (const turn of turnsOf(session.root)) {
      for (const node of walkWork(turn)) {
        const pew = node instanceof CompletionExpectation ? node : tapeCompletion(node);
        if (pew == null || pew.outcome != null) continue;
        const actor = session.orchestrator.actorOf(pew);
        if (!(actor instanceof OpenAiCompatActor)) continue;
        actor.stallMs = STALL_MS;
        return true;
      }
    }
  }
  return false;
}

function internedRoots(project: ProjectDaemon): Array<{ head: unknown; liveTurns: Iterable<SessionTurn> }> {
  const roots = new Map<string, { head: unknown; liveTurns: Iterable<SessionTurn> }>();
  for (const [id, session] of Object.entries(project.sessions)) {
    if (session != null) roots.set(id, session.root);
  }
  for (const id of Object.keys(project.kernel.plexus.root.sessions)) {
    const plexus = project.kernel.sessionPlexus(id);
    if (plexus != null) roots.set(id, plexus.root);
  }
  return [...roots.values()];
}

function settled(
  project: ProjectDaemon,
  workerPosts: number,
): {
  completed: boolean;
  code: string;
  message: string;
  partial: string;
  workerPosts: number;
} | null {
  let call: { completed: boolean; code: string; message: string } | null = null;
  let partial = "";
  for (const root of internedRoots(project)) {
    for (const turn of turnsOf(root)) {
      for (const node of walkWork(turn)) {
        if (node instanceof AgentCallJob) {
          const outcome = node.outcome;
          call = {
            completed: node.completed,
            code: outcome instanceof FailureOutcome ? outcome.code : "",
            message: outcome instanceof FailureOutcome ? outcome.message : "",
          };
        }
        const pew = node instanceof CompletionExpectation ? node : tapeCompletion(node);
        if (pew != null && pew.responseText === PARTIAL) partial = PARTIAL;
      }
    }
  }
  if (call == null) return null;
  return { ...call, partial, workerPosts };
}

describe("stream stall", () => {
  it("a silent worker stream fails once and releases the parent ask", async () => {
    const kernel = realpathSync(mkdtempSync(join(tmpdir(), "harness-stall-k-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-stall-p-")));
    const compat = await listenStall();
    try {
      await using daemon = new HarnessDaemon(kernel);
      await daemon.listen();
      await using client = await Client.start(kernel, workspace);
      await client.request("connect/adopt", {
        driver: "openai-compat",
        name: "Work",
        settings: { baseUrl: compat.baseUrl },
      });
      await client.request("kv/set", { key: "model", value: "m1" });
      await client.request("policy/set", { policy: "yolo" });
      await expect(client.request("turn", { prompt: PARENT })).resolves.toEqual({ ok: true });

      const project = await daemon.project(workspace);
      await expect.poll(() => armStall(project), { timeout: 10_000 }).toBe(true);
      compat.releaseWorker();
      await expect
        .poll(() => settled(project, compat.workerPosts()), { timeout: 10_000 })
        .toEqual({
          completed: true,
          code: "error",
          message: `stream stalled after ${STALL_MS}ms`,
          partial: PARTIAL,
          workerPosts: 1,
        });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(settled(project, compat.workerPosts())).toEqual({
        completed: true,
        code: "error",
        message: `stream stalled after ${STALL_MS}ms`,
        partial: PARTIAL,
        workerPosts: 1,
      });
    } finally {
      await compat.close();
      rmSync(kernel, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
