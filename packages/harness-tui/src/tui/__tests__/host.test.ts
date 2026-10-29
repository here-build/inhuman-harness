import { expect, test } from "vitest";

import { tuiBootGeometry, tuiReplaceBoot, tuiWorkerReplay } from "../channel.js";
import { hostExitCode } from "../host.js";
import { coldModelCatalog, SPINNER_PHASE } from "../spinner-phase.js";

test("hostExitCode treats worker death after attach as a crash", () => {
  expect(
    [
      { failed: null, workerCode: 0, shutdown: true },
      { failed: null, workerCode: 0, shutdown: false },
      { failed: null, workerCode: 1, shutdown: false },
      { failed: "boom", workerCode: 0, shutdown: false },
      { failed: null, workerCode: null, shutdown: false },
    ].map(hostExitCode),
  ).toEqual([
    { code: 0, reason: "shutdown" },
    { code: 1, reason: "worker 0 unexpected" },
    { code: 1, reason: "worker 1" },
    { code: 1, reason: "failed boom" },
    { code: 1, reason: "worker signal" },
  ]);
});

test("spinner phases name the /new and cold-catalog stalls", () => {
  expect({
    swap: [
      SPINNER_PHASE.closingSession,
      SPINNER_PHASE.openingSession,
      SPINNER_PHASE.syncingKernel,
      SPINNER_PHASE.kernelOccupancy,
    ],
    cold: coldModelCatalog({ connectionId: "openrouter", readyState: "bootstrapping", modelCount: 0 }),
    warm: coldModelCatalog({ connectionId: "openrouter", readyState: "ready", modelCount: 12 }),
    failed: coldModelCatalog({ connectionId: "openrouter", readyState: "failed", modelCount: 0 }),
    unset: coldModelCatalog({ connectionId: "", readyState: null, modelCount: 0 }),
  }).toEqual({
    swap: ["closing the session...", "opening the session...", "syncing the kernel...", "reading kernel occupancy..."],
    cold: true,
    warm: false,
    failed: false,
    unset: false,
  });
});

test("tuiReplaceBoot mints unless sessionId; replay drops held input", () => {
  expect({
    mint: tuiReplaceBoot("/k", { path: "/tmp/p", draft: "hi" }, "/cwd"),
    restore: tuiReplaceBoot("/k", { path: "", sessionId: " s-auth " }, "/cwd", { cols: 128, rows: 72 }),
    replay: {
      enter: tuiWorkerReplay({ lane: "paint", message: { kind: "input_events", events: [{ key: "Enter" }] } }),
      resize: tuiWorkerReplay({ lane: "paint", message: { kind: "resize", cols: 128, rows: 72 } }),
      shutdown: tuiWorkerReplay({ lane: "host", kind: "shutdown" }),
    },
    geometry: tuiBootGeometry({ cols: 128, rows: 72 }, [
      { lane: "paint", message: { kind: "resize", cols: 80, rows: 24 } },
      { lane: "paint", message: { kind: "input_events", events: [{ key: "Enter" }] } },
      { lane: "paint", message: { kind: "resize", cols: 100, rows: 40 } },
    ]),
  }).toEqual({
    mint: { kernel: "/k", path: "/tmp/p", draft: "hi" },
    restore: { kernel: "/k", path: "/cwd", sessionId: "s-auth", restore: true, cols: 128, rows: 72 },
    replay: { enter: false, resize: true, shutdown: true },
    geometry: { cols: 100, rows: 40 },
  });
});
