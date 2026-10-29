import { prompt } from "@inhuman.tools/harness-commons";
import { reaction } from "mobx";
import { expect, test } from "vitest";

import { BotSpec } from "../BotSpec.js";

function behaviorCell(spec: BotSpec): unknown {
  return Reflect.get(spec, "behaviorJson");
}

test("behavior is the frozen face of behaviorJson", () => {
  const spec = new BotSpec({
    name: "scout",
    instructions: prompt.system`Look.`,
    behaviorJson: JSON.stringify({ plugin: "tasks", bot: "scout" }),
  });
  const stop = reaction(
    () => spec.behavior,
    () => {},
  );
  const face = spec.behavior;
  expect(face).toEqual({ plugin: "tasks", bot: "scout" });
  expect(Object.isFrozen(face)).toBe(true);
  expect(spec.behavior).toBe(face);

  spec.behavior = { plugin: "tasks" };
  expect(spec.behavior).toEqual({ plugin: "tasks" });
  expect(spec.behavior).not.toBe(face);
  expect(behaviorCell(spec)).toBe(JSON.stringify({ plugin: "tasks" }));

  spec.behavior = null;
  expect(spec.behavior).toBeNull();
  expect(behaviorCell(spec)).toBeNull();
  stop();
});

test("behavior reads blank, the string null, junk, and a list as null", () => {
  const blank = new BotSpec({ name: "blank", instructions: prompt.system`x`, behaviorJson: "" });
  const word = new BotSpec({ name: "word", instructions: prompt.system`x`, behaviorJson: "null" });
  const junk = new BotSpec({ name: "junk", instructions: prompt.system`x`, behaviorJson: "not-json" });
  const list = new BotSpec({ name: "list", instructions: prompt.system`x`, behaviorJson: "[]" });
  const missing = new BotSpec({ name: "missing", instructions: prompt.system`x` });
  expect({
    blank: blank.behavior,
    word: word.behavior,
    junk: junk.behavior,
    list: list.behavior,
    missing: missing.behavior,
  }).toEqual({ blank: null, word: null, junk: null, list: null, missing: null });
  expect(behaviorCell(junk)).toBe("not-json");
});

test("a behavior read tracks the cell", () => {
  const spec = new BotSpec({ name: "scout", instructions: prompt.system`x` });
  const seen: unknown[] = [];
  const stop = reaction(
    () => spec.behavior,
    (value) => {
      seen.push(value);
    },
    { fireImmediately: true },
  );
  spec.behavior = { plugin: "tasks" };
  stop();
  expect(seen).toEqual([null, { plugin: "tasks" }]);
});
