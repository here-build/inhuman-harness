import { prompt } from "@inhuman.tools/harness-commons";
import {
  applyDenyReceipt,
  KernelPlexus,
  ProgrammaticJob,
  SCHEME_WATCH_TOOL_NAME,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  USER_REFUSED,
} from "@inhuman.tools/harness-model";
import { Orchestrator } from "@inhuman.tools/plexus-expectations/executor";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import { KernelToolCatalog, type CatalogEntry } from "@inhuman.tools/turn/catalog";
import { describe, expect, it, onTestFinished } from "vitest";

import { interpretSchemeRepl, type SchemeReplHost } from "../index.js";

// Same as the package testTimeout: 8s was tripped on a loaded 4-core CI runner (cold first test).
const TIMEOUT = 30_000;

function outcomeOf(chunk: ProgrammaticJob): {
  ok: boolean;
  text?: string;
  value?: unknown;
  code?: string;
} {
  return JSON.parse(chunk.receiptJson ?? "null") as {
    ok: boolean;
    text?: string;
    value?: unknown;
    code?: string;
  };
}

function packEntry(
  wireName: string,
  extra?: Partial<CatalogEntry> & { readonly execute?: CatalogEntry["execute"] },
): CatalogEntry {
  return {
    wireName,
    description: wireName,
    parameters: { type: "object", properties: {} },
    class: wireName === "write_file" ? "write" : "effect",
    source: { kind: "pack", pluginName: "toolkit" },
    ...extra,
  };
}

class ActorHost extends Orchestrator {
  async loadDriverModule(): Promise<never> {
    throw new Error("loadDriverModule must not run");
  }
}

describe("ProgrammaticJob actor", () => {
  it(
    "cancel, timeout, watch, and a denied inner call stay on the PEW guard path",
    async () => {
      const kernel = KernelPlexus.bootstrap();
      const session = SessionPlexus.create("scheme-actor", "/tmp/scheme-actor");
      const orch = new ActorHost(kernel, session);
      onTestFinished(() => {
        orch[Symbol.dispose]();
        session.destroy();
        kernel.destroy();
      });

      let catalogBodies = 0;
      let pewBodies = 0;
      const catalog = new KernelToolCatalog();
      catalog.replacePack([
        packEntry("write_file", {
          execute: async () => {
            catalogBodies += 1;
            return "catalog-write";
          },
        }),
        packEntry("shell", {
          execute: async () => {
            catalogBodies += 1;
            return "catalog-shell";
          },
        }),
        packEntry("ping", {
          class: "read",
          source: { kind: "pack", pluginName: "eval-pack" },
          execute: async () => {
            catalogBodies += 1;
            return "catalog-ping";
          },
        }),
      ]);

      orch.activate();
      orch.registerExecutor(
        SystemToolJob,
        (job) => {
          if (job.humanApprove === false) {
            applyDenyReceipt(job);
            return false;
          }
          return true;
        },
        async (job) => {
          pewBodies += 1;
          job.receiptJson = JSON.stringify({ ok: true, value: `${job.name}:ok` });
        },
      );

      function attach(bag: ProgrammaticJob): void {
        const turn = new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`scheme actor`,
          queue: [bag],
        });
        turn.pushChild(bag);
        session.root.head = turn;
      }

      function hostOf(): SchemeReplHost {
        return {
          catalog,
          root: "/tmp/scheme-actor",
          doors: new DoorSession(),
          admit: (call) =>
            new SystemToolJob({
              name: call.function.name,
              toolCallId: call.id,
              argsJson: call.function.arguments,
              humanApprove: call.function.name === "write_file" ? false : true,
            }),
        };
      }

      const ac = new AbortController();
      ac.abort(new DOMException("This operation was aborted", "AbortError"));
      const aborted = new ProgrammaticJob({
        toolCallId: "r-abort",
        argsJson: JSON.stringify({ description: "test", expr: "(+ 1 2)" }),
      });
      await interpretSchemeRepl(aborted, { ...hostOf(), signal: ac.signal });

      const hanging = new SystemToolJob({
        name: "shell",
        toolCallId: "hang",
        argsJson: JSON.stringify({ command: "sleep 5" }),
      });
      const timed = new ProgrammaticJob({
        toolCallId: "r-timeout",
        argsJson: JSON.stringify({ description: "test", expr: '(shell "sleep 5")', timeoutMs: 40 }),
      });
      await interpretSchemeRepl(timed, {
        catalog,
        root: "/tmp/scheme-actor",
        doors: new DoorSession(),
        admit: () => hanging,
      });

      const watch = new ProgrammaticJob({
        toolName: SCHEME_WATCH_TOOL_NAME,
        toolCallId: "r-watch",
        argsJson: JSON.stringify({
          description: "test",
          expr: '(self/notify "tick") (meta-reactivity/done-condition #t "done")',
          period: "1 minutes",
        }),
      });
      await interpretSchemeRepl(watch, hostOf());

      const denied = new ProgrammaticJob({
        toolCallId: "r-deny",
        argsJson: JSON.stringify({ description: "test", expr: '(write_file "x" "y")' }),
      });
      attach(denied);
      await interpretSchemeRepl(denied, hostOf());

      const allowed = new ProgrammaticJob({
        toolCallId: "r-allow",
        argsJson: JSON.stringify({ description: "test", expr: "(ping)" }),
      });
      attach(allowed);
      await interpretSchemeRepl(allowed, hostOf());

      expect({
        abort: outcomeOf(aborted),
        timeout: {
          bag: outcomeOf(timed),
          inner: hanging.receiptJson,
          cancelled: hanging.cancelled,
          orchestrated: hanging.orchestrated,
        },
        watch: {
          outcome: outcomeOf(watch),
          notes: watch.notifications.map((note) => note.message),
        },
        denied: {
          outcome: outcomeOf(denied),
          inner: denied.toolCalls[0]?.receiptJson,
          humanApprove: denied.toolCalls[0]?.humanApprove,
          orchestrated: denied.toolCalls[0]?.orchestrationResult,
          completed: denied.toolCalls[0]?.completed,
        },
        allowed: {
          outcome: outcomeOf(allowed),
          inner: allowed.toolCalls[0]?.receiptJson,
          orchestrated: allowed.toolCalls[0]?.orchestrationResult,
        },
        bodies: { catalog: catalogBodies, pew: pewBodies },
      }).toEqual({
        abort: { ok: false, text: "Error: Scheme REPL call cancelled" },
        timeout: {
          bag: { ok: false, text: expect.stringMatching(/timed out after 40ms/) },
          inner: JSON.stringify({ ok: false, text: "evaluation timed out after 40ms" }),
          cancelled: true,
          orchestrated: false,
        },
        watch: {
          outcome: { ok: true, value: ["done"] },
          notes: ["tick"],
        },
        denied: {
          outcome: { ok: false, text: expect.stringMatching(new RegExp(USER_REFUSED)) },
          inner: JSON.stringify({ ok: false, text: USER_REFUSED, refusalReason: USER_REFUSED }),
          humanApprove: false,
          orchestrated: false,
          completed: true,
        },
        allowed: {
          outcome: { ok: true, value: ["ping:ok"] },
          inner: JSON.stringify({ ok: true, value: "ping:ok" }),
          orchestrated: true,
        },
        bodies: { catalog: 0, pew: 1 },
      });
    },
    TIMEOUT,
  );

  it("a failed tool names its arguments and keeps earlier statements", async () => {
    const kernel = KernelPlexus.bootstrap();
    const session = SessionPlexus.create("scheme-fail", "/tmp/scheme-fail");
    const orch = new ActorHost(kernel, session);
    orch.activate();
    onTestFinished(() => {
      orch[Symbol.dispose]();
      session.destroy();
      kernel.destroy();
    });
    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      packEntry("ping", { class: "read", source: { kind: "pack", pluginName: "eval-pack" } }),
      packEntry("shell"),
    ]);
    orch.registerExecutor(
      SystemToolJob,
      () => true,
      async (job) => {
        job.receiptJson =
          job.name === "shell"
            ? JSON.stringify({
                ok: false,
                value: { exitCode: 1, stdout: "No test files found", stderr: "" },
              })
            : JSON.stringify({ ok: true, value: "pong" });
      },
    );
    const bag = new ProgrammaticJob({
      toolCallId: "r-shell-fail",
      argsJson: JSON.stringify({
        description: "test",
        expr: '(+ 1 2)\n(ping)\n(list (ping) (shell "vitest"))',
      }),
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`scheme fail`,
      queue: [bag],
    });
    turn.pushChild(bag);
    session.root.head = turn;
    await interpretSchemeRepl(bag, {
      catalog,
      root: "/tmp/scheme-fail",
      doors: new DoorSession(),
      admit: (call) =>
        new SystemToolJob({
          name: call.function.name,
          toolCallId: call.id,
          argsJson: call.function.arguments,
          humanApprove: true,
        }),
    });
    expect(outcomeOf(bag).text ?? "").toBe(
      [
        "3",
        "pong",
        "pong",
        [
          'Error: shell {:command vitest} failed: {:exitCode 1 :stdout "No test files found" :stderr ""}',
          'raw {:exitCode 1 :stdout "No test files found" :stderr ""}',
        ].join("\n"),
      ].join("\n\n"),
    );
  });
});
