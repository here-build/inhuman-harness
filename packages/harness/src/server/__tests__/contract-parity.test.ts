import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listProcedures,
  REASONING_EFFORTS as CONTRACT_EFFORTS,
  type HarnessHost,
} from "@inhuman.tools/harness-contract";
import { REASONING_EFFORTS } from "@inhuman.tools/plugin-sdk";
import { mkdtemp } from "fs-extra";
import { describe, expect, it } from "vitest";

import type { DaemonRpcMethod } from "../contract.js";
import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";

function contractMethods(host: HarnessHost) {
  return listProcedures().filter((entry) => entry.meta.host === host);
}

function expectParity(host: HarnessHost, table: readonly DaemonRpcMethod[]) {
  const names = table.map((row) => row.name);
  expect(new Set(names).size, `duplicate implementation in the ${host} table`).toBe(names.length);
  expect([...names].sort()).toEqual(
    contractMethods(host)
      .map((entry) => entry.meta.method)
      .sort(),
  );
  for (const entry of contractMethods(host)) {
    const row = table.find((candidate) => candidate.name === entry.meta.method);
    const def = entry.procedure["~orpc"];
    expect(row?.input, `${entry.meta.method} input`).toBe(def.inputSchema);
    expect(row?.output, `${entry.meta.method} output`).toBe(def.outputSchema);
  }
}

describe("harness-contract parity", () => {
  it("every contract procedure has exactly one implementation per host, and vice versa", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-parity-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-parity-p-"));
    using kernel = new KernelDaemon(system);
    await kernel.ready;
    using project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("s1");

    expectParity("kernel", kernel.rpcMethods);
    expectParity("session", session.rpcMethods);
    expect(project.rpcMethods).toEqual([]);
    // `ui/resolve` is built into RequestHost.handleRequest, not a table row.
    expect(contractMethods("any").map((entry) => entry.meta.method)).toEqual(["ui/resolve"]);
  });

  it("wire names are unique per host", () => {
    for (const host of ["session", "kernel", "any"] as const) {
      const names = contractMethods(host).map((entry) => entry.meta.method);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("the contract's reasoning-effort list matches the plugin SDK's", () => {
    expect([...CONTRACT_EFFORTS]).toEqual([...REASONING_EFFORTS]);
  });
});
