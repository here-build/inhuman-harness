import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { KernelStateStore } from "../state-store.js";
import { hostPropose, StateDirectory } from "../state.js";
import { Dict, toJS, type ReducerDecl } from "../value.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REDUCER = {} as ReducerDecl;

test("project and global logs outlive the directory; private ones do not", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-state-"));
  temps.push(root);
  const store = () =>
    new KernelStateStore(
      () => root,
      () => undefined,
    );
  const first = new StateDirectory(store());
  const project = first.ownerId("memo", "project", "/work", "state");
  const pocket = first.ownerId("memo", "private", "s1", "pocket");
  hostPropose(first, first.open(project, "project", "abi", REDUCER, new Map()), new Dict({ type: "put", n: 1 }));
  hostPropose(first, first.open(pocket, "private", "abi", REDUCER, new Map()), new Dict({ type: "put" }));

  const second = new StateDirectory(store());
  expect({
    files: readdirSync(join(root, "plugin-state")).length,
    project: second.open(project, "project", "abi", REDUCER, new Map()).log.map((action) => toJS(action)),
    pocket: second.open(pocket, "private", "abi", REDUCER, new Map()).log,
  }).toEqual({ files: 1, project: [{ type: "put", n: 1 }], pocket: [] });
});
