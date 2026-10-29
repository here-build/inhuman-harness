/**
 * Dialect.step() name-certainty + close (2b-1).
 */
import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins, getDialect } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import type { MarkupStepState } from "../dialects/step-common.js";

describe("Dialect.step() P0", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("hermes: no start until JSON name certain", () => {
    const d = getDialect("hermes")!;
    const s = d.createStreamState!() as MarkupStepState;
    let r = d.step!(s, "<tool_call>\n{", {});
    expect(r.events.filter((e) => e.type === "tool_call_start")).toHaveLength(0);
    expect(r.holding).toBe(true);

    r = d.step!(s, '<tool_call>\n{"name":"get_weather"', {});
    const starts = r.events.filter((e) => e.type === "tool_call_start");
    expect(starts).toHaveLength(1);
    expect((starts[0] as { name: string }).name).toBe("get_weather");
    expect(r.holding).toBe(true);
  });

  it("hermes: close consumes full span", () => {
    const d = getDialect("hermes")!;
    const s = d.createStreamState!() as MarkupStepState;
    const full = '<tool_call>\n{"name":"get_weather","arguments":{"city":"SF"}}\n</tool_call>';
    const r = d.step!(s, full, {});
    expect(r.holding).toBe(false);
    expect(r.consumed).toBe(full.length);
    expect(r.events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(r.events.some((e) => e.type === "tool_call_end")).toBe(true);
  });

  it("qwen bare: name certain at <function=NAME>", () => {
    const d = getDialect("qwen_xml")!;
    const s = d.createStreamState!() as MarkupStepState;
    const r = d.step!(s, "<function=read_file>\n<parameter=path>a", {});
    const starts = r.events.filter((e) => e.type === "tool_call_start");
    expect(starts).toHaveLength(1);
    expect((starts[0] as { name: string }).name).toBe("read_file");
    expect(r.holding).toBe(true);
  });

  it("longcat tagged: name after name line + newline", () => {
    const d = getDialect("longcat")!;
    const s = d.createStreamState!() as MarkupStepState;
    let r = d.step!(s, "<longcattoolcall>\nwritefile", {});
    expect(r.events.filter((e) => e.type === "tool_call_start")).toHaveLength(0);
    r = d.step!(s, "<longcattoolcall>\nwritefile\n<longcatargkey>path</longcatargkey>", {});
    const starts = r.events.filter((e) => e.type === "tool_call_start");
    expect(starts).toHaveLength(1);
    expect((starts[0] as { name: string }).name).toBe("writefile");
  });
});
