// attestation-flows — the branded-attestation flow cases
// (the core-walk suite lives in arrival's src/__tests__/attestation.test.ts).
// The flow algebra under test (§2): literals/computed values are FRESH boxes and rejected
// at a tool boundary in "required" mode; `s/*`-wrapped values, tool results, and plucks
// from either are attested and pass; reference-passing (`let`, lambda args, `if` selects)
// preserves the verdict; computation drops it — the model re-attests deliberately.

import { exec } from "@here.build/arrival";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type AttestationMode, buildManifoldEnv, type ManifoldEnv } from "../bind.js";

const run = (world: Pick<ManifoldEnv, "capabilities" | "config" | "runCtx" | "scope">, expr: string) =>
  exec(expr, { capabilities: world.capabilities, config: world.config, runCtx: world.runCtx, scope: world.scope });
// Every `invoke` mock below is asserted with a trailing AbortSignal — bind.ts's rosettaDef
// forwards the calling eval's abort signal as `tool.invoke(args, this.abortSignal)` (see
// bind.ts's `RemoteTool.invoke` doc); `run` here passes no `signal`, so it is the run's own.

const REQUIRES = "requires an explicit type assertion";

async function makeWorld(mode?: AttestationMode) {
  const pay = vi.fn(async (args: Record<string, unknown>) => ({ ok: true, paid: args.amount }));
  const say = vi.fn(async (args: Record<string, unknown>) => args);
  const manifoldEnv = await buildManifoldEnv(
    [
      {
        slug: "t",
        tools: [
          {
            name: "get",
            description: "fixture source",
            inputSchema: { type: "object", properties: {} },
            // A FRESH record per invoke — the membrane freezes returned sources, and a
            // shared fixture would leak state (frozen-ness) across worlds.
            invoke: async () => ({ price: 7, name: "Ada", flag: true, nested: { b: 2 }, tags: [10, 20] }),
          },
          {
            name: "inner",
            description: "returns a number",
            inputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
            invoke: async (args) => (args.a as number) + 41,
          },
          {
            name: "pay",
            inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
            invoke: pay,
          },
          {
            name: "say",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" },
                flag: { type: "boolean" },
                meta: { type: "object" },
                items: { type: "array" },
              },
              required: ["text"],
            },
            invoke: say,
          },
        ],
      },
    ],
    mode === undefined ? {} : { attestation: mode },
  );
  return { env: manifoldEnv, pay, say };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attestation flows (required mode)", () => {
  it("1. literal-rejected — names the arg, suggests the schema-derived s/<kind>, echoes the value", async () => {
    const { env, pay } = await makeWorld("required");
    await expect(run(env, "(t/pay :amount 37)")).rejects.toThrow(
      "tool argument :amount requires an explicit type assertion — wrap it: (s/number 37)",
    );
    expect(pay).not.toHaveBeenCalled();
    // string param → s/string suggestion, value echoed as the wrap argument
    const { env: env2, say } = await makeWorld("required");
    await expect(run(env2, '(t/say :text "Berlin")')).rejects.toThrow(
      'tool argument :text requires an explicit type assertion — wrap it: (s/string "Berlin")',
    );
    expect(say).not.toHaveBeenCalled();
  });

  it("2. s-wrap-passes — the invoke receives the plain decoded value", async () => {
    const { env, pay } = await makeWorld("required");
    await run(env, "(t/pay :amount (s/number 37))");
    expect(pay).toHaveBeenCalledWith({ amount: 37 }, expect.any(AbortSignal));
  });

  it("3. tool-result-passes — nested composition stays free (auto-attested returns)", async () => {
    const { env, pay } = await makeWorld("required");
    await run(env, "(t/pay :amount (t/inner :a (s/number 1)))");
    expect(pay).toHaveBeenCalledWith({ amount: 42 }, expect.any(AbortSignal));
  });

  it("4. pluck-inherits — every read off a tool result is attested (fields, nesting, elements)", async () => {
    const { env, pay } = await makeWorld("required");
    await run(
      env,
      `(define r (t/get))
       (t/pay :amount (:price r))
       (t/pay :amount (@ r :price))
       (t/pay :amount (@ r "price"))
       (t/pay :amount (:b (:nested r)))
       (t/pay :amount (vector-ref (:tags r) 0))
       (t/pay :amount (car (:tags r)))`,
    );
    expect(pay).toHaveBeenCalledTimes(6);
    expect(pay).toHaveBeenNthCalledWith(1, { amount: 7 }, expect.any(AbortSignal));
    expect(pay).toHaveBeenNthCalledWith(4, { amount: 2 }, expect.any(AbortSignal));
    expect(pay).toHaveBeenNthCalledWith(5, { amount: 10 }, expect.any(AbortSignal));
    expect(pay).toHaveBeenNthCalledWith(6, { amount: 10 }, expect.any(AbortSignal));
  });

  it("5. computed-relaundered — computation drops attestation; s/* re-attests deliberately", async () => {
    const { env, pay, say } = await makeWorld("required");
    await run(env, "(define r (t/get))");
    await expect(run(env, "(t/pay :amount (+ (:price r) 1))")).rejects.toThrow(REQUIRES);
    await run(env, "(t/pay :amount (s/number (+ (:price r) 1)))");
    expect(pay).toHaveBeenCalledWith({ amount: 8 }, expect.any(AbortSignal));
    await expect(run(env, '(t/say :text (string-append (:name r) "!"))')).rejects.toThrow(REQUIRES);
    expect(say).not.toHaveBeenCalled();
  });

  it("6. binding-preserves — let, lambda args, and if-selects pass the attested box by reference", async () => {
    const { env, pay } = await makeWorld("required");
    await run(
      env,
      `(let ((x (s/number 5))) (t/pay :amount x))
       ((lambda (x) (t/pay :amount x)) (s/number 6))
       (t/pay :amount (if #t (s/number 1) (s/number 2)))`,
    );
    expect(pay).toHaveBeenNthCalledWith(1, { amount: 5 }, expect.any(AbortSignal));
    expect(pay).toHaveBeenNthCalledWith(2, { amount: 6 }, expect.any(AbortSignal));
    expect(pay).toHaveBeenNthCalledWith(3, { amount: 1 }, expect.any(AbortSignal));
  });

  it("7. singleton edges — (s/boolean #t) passes; bare #t, missing-key nil, #void never attest", async () => {
    const { env, say } = await makeWorld("required");
    await run(env, '(t/say :text (s/string "hi") :flag (s/boolean #t))');
    expect(say).toHaveBeenCalledWith({ text: "hi", flag: true }, expect.any(AbortSignal));
    // no program-wide leak: an unrelated bare #t in the SAME world is still rejected
    await expect(run(env, '(t/say :text (s/string "x") :flag #t)')).rejects.toThrow(
      "tool argument :flag requires an explicit type assertion — wrap it: (s/boolean true)",
    );
    // a missing key plucks the shared nil — "absent" is never an attested value
    await expect(run(env, "(define r (t/get)) (t/pay :amount (:missing r))")).rejects.toThrow(REQUIRES);
    // #void is exempt too
    await expect(run(env, "(t/pay :amount (if #f #f))")).rejects.toThrow(REQUIRES);
    // a SECOND world sees nothing from the first (identity-keyed registry, fresh boxes)
    const second = await makeWorld("required");
    await expect(run(second.env, '(t/say :text (s/string "a") :flag #t)')).rejects.toThrow(REQUIRES);
  });

  it("8. shallow s/object — attested dict passes whole; its plucked field passes; fresh dicts don't", async () => {
    const { env, pay, say } = await makeWorld("required");
    // a model-authored dict is a fresh container — rejected until wrapped, even when its
    // parts are attested (building a dict is computing)
    await expect(run(env, '(t/say :text (s/string "k") :meta {:x 1})')).rejects.toThrow(
      "tool argument :meta requires an explicit type assertion — wrap it: (s/object",
    );
    await expect(run(env, '(t/say :text (s/string "k") :meta {:x (s/number 1)})')).rejects.toThrow(REQUIRES);
    // one s/object decision covers the aggregate…
    await run(env, '(t/say :text (s/string "k") :meta (s/object {:x 1}))');
    expect(say).toHaveBeenCalledTimes(1);
    // …and its plucked fields (site-2 inheritance from the attested container)
    await run(env, "(define d (s/object {:x 5})) (t/pay :amount (:x d))");
    expect(pay).toHaveBeenCalledWith({ amount: 5 }, expect.any(AbortSignal));
    // s/array: same shallow contract for the vector container
    await expect(run(env, '(t/say :text (s/string "k") :items [1 2])')).rejects.toThrow(
      "tool argument :items requires an explicit type assertion — wrap it: (s/array",
    );
    await run(env, '(t/say :text (s/string "k") :items (s/array [1 2]))');
    expect(say).toHaveBeenCalledTimes(2);
  });

  it("s/object and s/array validate shallowly and door on the wrong container kind", async () => {
    const { env } = await makeWorld("required");
    await expect(run(env, "(s/object [1 2])")).rejects.toThrow("s/object: expected an object, got array: [1,2]");
    await expect(run(env, "(s/array {:a 1})")).rejects.toThrow("s/array: expected an array, got object:");
    await expect(run(env, "(s/object 5)")).rejects.toThrow("s/object: expected an object, got number: 5");
  });
});

describe("attestation knob (case 9)", () => {
  it('"off" — the s/* family is unbound and the boundary never checks or counts', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, pay } = await makeWorld("off");
    await run(env, "(t/pay :amount 37)");
    expect(pay).toHaveBeenCalledWith({ amount: 37 }, expect.any(AbortSignal));
    expect(warn).not.toHaveBeenCalled();
    await expect(run(env, "(s/number 1)")).rejects.toThrow("Unbound variable `s/number'");
  });

  it('"available" (the default) — passes but REPORTS unattested args', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, pay } = await makeWorld();
    await run(env, "(t/pay :amount 37)");
    expect(pay).toHaveBeenCalledWith({ amount: 37 }, expect.any(AbortSignal));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(":amount");
    expect(warn.mock.calls[0]?.[0]).toContain("unattested");
    // a fully-attested call reports nothing
    warn.mockClear();
    await run(env, "(t/pay :amount (s/number 37))");
    expect(warn).not.toHaveBeenCalled();
  });

  it('"required" — omitted OPTIONAL args are never checked', async () => {
    const { env, say } = await makeWorld("required");
    await run(env, '(t/say :text (s/string "hi"))');
    expect(say).toHaveBeenCalledWith({ text: "hi" }, expect.any(AbortSignal));
  });

  it("a param with NO declared schema type suggests s/string (the safest default)", async () => {
    const invoke = vi.fn(async (args: Record<string, unknown>) => args);
    const manifoldEnv = await buildManifoldEnv(
      [{ slug: "t", tools: [{ name: "raw", inputSchema: { type: "object", properties: { blob: {} } }, invoke }] }],
      { attestation: "required" },
    );
    await expect(run(manifoldEnv, '(t/raw :blob "x")')).rejects.toThrow('wrap it: (s/string "x")');
  });
});
