import { AskAgentSpec, SessionRoot } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { bindSessionCatalog } from "@/tool-catalog";
import { workerToolAllowed } from "@/tool-runtime";

import { KernelToolCatalog } from "../../../toolkit/tool-table.js";
import { inheritedToolGrant } from "../agent-runtime.js";

function childOf(caller: SessionRoot, catalog: KernelToolCatalog): SessionRoot {
  const grant = inheritedToolGrant(caller, catalog, { inheritCallerTools: true });
  const child = new SessionRoot({ sessionId: "child", path: "/tmp" });
  child.agent.spec = new AskAgentSpec({ name: "", ...grant });
  return child;
}

describe("inheritCallerTools", () => {
  it("gives a restricted worker's child that worker's wires, not the session's full set", () => {
    const catalog = new KernelToolCatalog();
    const caller = new SessionRoot({ sessionId: "caller", path: "/tmp" });
    caller.agent.spec = new AskAgentSpec({ name: "analyze", tools: ["read_file"], toolsOnly: true });
    bindSessionCatalog(caller, catalog);
    const child = childOf(caller, catalog);
    expect({
      read: workerToolAllowed(catalog, "", "read_file", child),
      write: workerToolAllowed(catalog, "", "write_file", child),
      shell: workerToolAllowed(catalog, "", "shell", child),
    }).toEqual({ read: true, write: false, shell: false });
  });

  it("passes the live catalog on for an unrestricted caller", () => {
    const catalog = new KernelToolCatalog();
    const caller = new SessionRoot({ sessionId: "main", path: "/tmp" });
    bindSessionCatalog(caller, catalog);
    const child = childOf(caller, catalog);
    expect({
      inherit: child.agent.spec instanceof AskAgentSpec && child.agent.spec.inheritCallerTools,
      write: workerToolAllowed(catalog, "", "write_file", child),
    }).toEqual({ inherit: true, write: true });
  });
});
