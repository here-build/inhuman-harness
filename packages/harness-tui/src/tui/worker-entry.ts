import { parentPort, workerData } from "node:worker_threads";

import { fail, installProcessLog, note, step } from "@inhuman.tools/harness-diagnostics";
import { Client } from "@inhuman.tools/harness-sdk";
import { applyResolvedAgent, stampTermContinue } from "@inhuman.tools/harness-sdk/launch";

import { tuiBootGeometry, tuiWorkerReplay, type HostToWorker } from "./channel.js";
import { SPINNER_PHASE } from "./spinner-phase.js";
import { bootComposerDraft, Tea } from "./tea.js";
import { workerBootSchema } from "../schemas/worker-boot.js";

const port = parentPort;
if (port === null) {
  throw new Error("tui worker: no parentPort");
}

installProcessLog("worker", (error) => {
  try {
    port.postMessage({
      lane: "host",
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  } catch {
    /* parent already gone */
  }
});

const boot = workerBootSchema.parse(workerData);

// WORKER_BOOT_QUEUE: host posts resize/input before Client.start returns — dropping them loses the first geometry/keys.
const pending: HostToWorker[] = [];
let deliver = (message: HostToWorker): void => {
  pending.push(message);
};
port.on("message", (message: HostToWorker) => deliver(message));

const phase = (text: string): void => {
  port.postMessage({ lane: "host", kind: "phase", text });
};

try {
  step(`worker boot ${boot.restore === true ? "restore" : (boot.sessionId ?? "mint")}`);
  phase(SPINNER_PHASE.openingSession);
  const client =
    boot.sessionId !== undefined && boot.restore === true
      ? await Client.restore(boot.kernel, boot.sessionId)
      : await Client.start(boot.kernel, boot.path, phase);
  if ((boot.connection ?? "") !== "" || (boot.model ?? "") !== "") phase(SPINNER_PHASE.applyingModel);
  await applyResolvedAgent((method, params) => client.request(method, params), {
    connection: boot.connection ?? "",
    model: boot.model,
  });
  await stampTermContinue((method, params) => client.kernelRequest(method, params), process.env, client.sessionRoot);
  const { cols, rows } = tuiBootGeometry(boot, pending);
  step(`worker tea ${client.sessionId} ${cols}x${rows}`);
  const draft = bootComposerDraft(boot.draft, Object.values(client.kernelRoot.connections));
  const tea = new Tea(
    client,
    (batch) => {
      port.postMessage({ lane: "paint", batch });
    },
    {
      cols,
      rows,
      ...(draft != null && draft !== "" ? { draft } : {}),
      title: (text) => port.postMessage({ lane: "host", kind: "title", text }),
      quit: () => port.postMessage({ lane: "host", kind: "quit" }),
      resident: (on) => port.postMessage({ lane: "host", kind: "resident", resident: on }),
      replaceSession: (opts) =>
        port.postMessage({
          lane: "host",
          kind: "replace",
          path: opts.path,
          ...(opts.draft != null && opts.draft !== "" ? { draft: opts.draft } : {}),
          ...(opts.sessionId != null && opts.sessionId !== "" ? { sessionId: opts.sessionId } : {}),
        }),
    },
  );
  deliver = (message: HostToWorker): void => {
    if (message.lane === "paint") {
      tea.handle(message.message);
      return;
    }
    if (message.kind === "shutdown") {
      note("worker shutdown");
      phase(SPINNER_PHASE.closingSession);
      tea[Symbol.dispose]();
      void client[Symbol.asyncDispose]().finally(() => {
        process.exit(0);
      });
    }
  };
  for (const message of pending.splice(0)) {
    if (tuiWorkerReplay(message)) deliver(message);
  }
  port.postMessage({ lane: "host", kind: "attached" });
  step("worker attached");
} catch (error) {
  fail("worker boot", error);
  port.postMessage({
    lane: "host",
    kind: "failed",
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
