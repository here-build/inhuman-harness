import { expect, test } from "vitest";

import { createPaintLocal } from "../../runtime/index.js";
import { createCatalogController, createCatalogStore } from "../catalog-source.js";
import { CATALOG } from "../catalog.js";

function keys(...events: Array<{ key: string }>) {
  return { kind: "input_events" as const, events };
}

test("catalog source: j/k, filter, activate", () => {
  const store = createCatalogStore();
  const catalog = createCatalogController(store);
  const quit: string[] = [];
  const opts = { onQuit: () => quit.push("q") };

  catalog.handle(keys({ key: "j" }), opts);
  expect(store.selected).toBe(1);
  catalog.handle(keys({ key: "k" }), opts);
  expect(store.selected).toBe(0);

  catalog.handle(keys({ key: "/" }), opts);
  expect(store.filtering).toBe(true);
  catalog.handle(keys({ key: "w" }, { key: "-" }), opts);
  expect(store.filterBuf).toBe("w-");
  catalog.handle(keys({ key: "Enter" }), opts);
  expect({
    filter: store.filter,
    filtering: store.filtering,
    selected: store.selected,
  }).toEqual({ filter: "w-", filtering: false, selected: 0 });

  const first = CATALOG.find((s) => s.id.startsWith("w-"));
  expect(first).toBeDefined();
  catalog.handle({ kind: "activate", key: `s-${first!.id}` }, opts);
  expect(store.selected).toBe(0);

  catalog.handle(keys({ key: "q" }), opts);
  expect(quit).toEqual(["q"]);
});

test("catalog prepare() returns the shell as the frame", () => {
  const catalog = createCatalogController();
  const local = createPaintLocal(80, 24);
  catalog.bind({ requestPaint() {} }, local);
  const prepared = catalog.snapshot ?? catalog.prepare();
  expect(prepared.root).not.toBeNull();
  expect(prepared.contentIdentity).toContain("80|24");
  expect(prepared.picker).toBeNull();
  expect(prepared.composer.interactive).toBe(false);
});

test("catalog snapshot keeps identity until a fact changes", () => {
  const catalog = createCatalogController();
  const local = createPaintLocal(80, 24);
  catalog.bind({ requestPaint() {} }, local);
  const first = catalog.snapshot ?? catalog.prepare();
  const second = catalog.snapshot ?? catalog.prepare();
  expect(second).toBe(first);
  catalog.handle({ kind: "input_events", events: [{ key: "j" }] }, { onQuit() {} });
  const third = catalog.snapshot ?? catalog.prepare();
  expect(third).not.toBe(first);
  expect(third.contentIdentity).not.toBe(first.contentIdentity);
});
