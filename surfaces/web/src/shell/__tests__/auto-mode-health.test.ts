import { ConnectionSpec, DriverSpec } from "@inhuman.tools/expectations";
import { KernelRoot, SessionRoot } from "@inhuman.tools/harness-model";
import { autoModeProblem } from "@inhuman.tools/harness-transcript/names";
import { expect, it } from "vitest";

it("shows judge faults only for the selected wire and clears after a successful retry", () => {
  const session = new SessionRoot({ sessionId: "s", path: "/work" });
  const kernel = new KernelRoot({});
  const connection = new ConnectionSpec({ driver: new DriverSpec(), configuration: { model: "judge" } });
  kernel.connections.local = connection;
  session.kvs.judgeConnection = "local";
  session.kvs.judgeModel = "judge";
  expect(autoModeProblem(session, kernel)).toBeNull();
  session.autoModeProblems["local\njudge"] = "No models loaded";
  expect(autoModeProblem(session, kernel)).toContain("No models loaded");
  session.kvs.judgeModel = "another";
  expect(autoModeProblem(session, kernel)).toBeNull();
  session.kvs.judgeModel = "judge";
  delete session.autoModeProblems["local\njudge"];
  expect(autoModeProblem(session, kernel)).toBeNull();
  connection.stampProcess({ readyState: "failed", error: "Connection refused", live: {} });
  session.autoModeProblems["local\njudge"] = "Connection refused";
  expect(autoModeProblem(session, kernel)).toContain("Connection refused");
});

it("does not claim a model-free classifier is broken when no model connection exists", () => {
  const session = new SessionRoot({ sessionId: "s", path: "/work" });
  session.judgeAskProgram = "allow";
  expect(autoModeProblem(session, new KernelRoot({}))).toBeNull();
});

it("uses the same kernel model fallback as the backend when session overrides were cleared", () => {
  const session = new SessionRoot({ sessionId: "s", path: "/work" });
  const kernel = new KernelRoot({ kvs: { connection: "local", model: "selected", judgeConnection: "local" } });
  const connection = new ConnectionSpec({ driver: new DriverSpec() });
  connection.live = { models: ["first", "selected"] };
  kernel.connections.local = connection;
  session.autoModeProblems["local\nselected"] = "No models loaded";
  expect(autoModeProblem(session, kernel)).toContain("No models loaded");
});
