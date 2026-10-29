/**
 * Logic thread (worker_threads).
 * Owns TEA model. Never touches stdout.
 */

import { parentPort } from "node:worker_threads";

import type { HostToWorker, WorkerToHost } from "./host.js";
import { init, update, type Model, type Msg } from "./model.js";
import type { Snapshot } from "./tea.js";

if (!parentPort) {
  throw new Error("worker must run as worker_thread");
}

const port = parentPort;
let model: Model = init(80, 24);
let gen = 0;

function publish(): void {
  gen += 1;
  const snap: Snapshot<Model> = {
    gen,
    model,
    at: performance.now(),
  };
  const msg: WorkerToHost<Model> = { type: "snapshot", snap };
  port.postMessage(msg);
}

function apply(msg: Msg): void {
  model = update(msg, model);
  publish();
}

port.on("message", (raw: HostToWorker) => {
  switch (raw.type) {
    case "init":
      model = init(raw.cols, raw.rows);
      gen = 0;
      publish();
      break;
    case "resize":
      apply({ type: "resize", cols: raw.cols, rows: raw.rows });
      break;
    case "key":
      apply({ type: "key", key: raw.key });
      break;
    case "tick":
      // coalesce: only one tick worth of work per message
      apply({ type: "tick", now: raw.now });
      break;
  }
});
