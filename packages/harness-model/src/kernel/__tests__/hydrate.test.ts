import { expect, test } from "vitest";
import * as Y from "yjs";

import { ReActLoopIntentDetectedTrigger } from "../../shared/ReActLoopIntentDetectedTrigger.js";
import { InstalledPlugin } from "../InstalledPlugin.js";
import { KERNEL_DOC_GUID, KernelPlexus } from "../KernelPlexus.js";
import { SessionGlance } from "../SessionOverview.js";

test("connect hydrates leftover reActLoopIntentDetectedTrigger omitted from the kernel image", () => {
  const source = KernelPlexus.bootstrap();
  source.root.reActLoopIntentDetectedTrigger = null as unknown as ReActLoopIntentDetectedTrigger;
  const doc = new Y.Doc({ guid: KERNEL_DOC_GUID });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc));
  source.destroy();
  const plexus = KernelPlexus.connect(doc);
  expect({
    present: plexus.root.reActLoopIntentDetectedTrigger != null,
    enabled: plexus.root.reActLoopIntentDetectedTrigger.enabled,
  }).toEqual({ present: true, enabled: true });
  plexus.destroy();
});

test("connect reads a session-glance row and copies the old field names once", () => {
  const source = KernelPlexus.bootstrap();
  const glance = new SessionGlance({ title: "kept" });
  glance.scope = "project";
  glance.daemon = true;
  glance.blocked = true;
  source.root.sessions.kept = glance;
  const doc = new Y.Doc({ guid: KERNEL_DOC_GUID });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc));
  source.destroy();
  const plexus = KernelPlexus.connect(doc);
  const row = plexus.root.sessions.kept;
  expect({
    title: row?.title ?? "",
    recipeScope: row?.recipeScope ?? "",
    resident: row?.resident ?? false,
    asking: row?.asking ?? false,
    glance: row instanceof SessionGlance,
    scope: row instanceof SessionGlance ? row.scope : "",
    daemon: row instanceof SessionGlance ? row.daemon : false,
    blocked: row instanceof SessionGlance ? row.blocked : false,
  }).toEqual({
    title: "kept",
    recipeScope: "project",
    resident: true,
    asking: true,
    glance: true,
    scope: "",
    daemon: false,
    blocked: false,
  });
  plexus.destroy();
});

test("connect leaves leftover plugin.problem omitted from the kernel image as null", () => {
  const source = KernelPlexus.bootstrap();
  const plugin = new InstalledPlugin({ pluginName: "demo" });
  source.root.plugins.demo = plugin;
  plugin.problem = null;
  const doc = new Y.Doc({ guid: KERNEL_DOC_GUID });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc));
  source.destroy();
  const plexus = KernelPlexus.connect(doc);
  expect(plexus.root.plugins.demo?.problem).toBeNull();
  plexus.destroy();
});
