import { describe, expect, it } from "vitest";
import { z as z } from "zod";

import { InhumanTool } from "../index.js";

const echo = new InhumanTool({
  name: "echo",
  class: "read",
  input: z.object({ msg: z.string() }),
  output: z.object({ msg: z.string() }),
  run: (input) => input,
});

const net = new InhumanTool({
  name: "ping",
  class: "effect",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  run: () => ({ ok: true }),
});

describe("InhumanTool", () => {
  it("round-trips valid input", async () => {
    const out = await echo.execute({ msg: "hi" }, { root: "/tmp" });
    expect(out).toEqual({ msg: "hi" });
  });

  it("rejects bad input", async () => {
    await expect(echo.execute({ msg: 1 }, { root: "/tmp" })).rejects.toThrow();
  });

  it("requires ctx.root for read and write", async () => {
    await expect(echo.execute({ msg: "x" }, {})).rejects.toThrow(/ctx.root/);
    const write = new InhumanTool({
      name: "put",
      class: "write",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    });
    await expect(write.execute({}, {})).rejects.toThrow(/ctx.root/);
  });

  it("allows effect without root", async () => {
    expect(await net.execute({}, {})).toEqual({ ok: true });
  });

  it("defaults missing class to effect (no root required)", async () => {
    const bare = new InhumanTool({
      name: "bare",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    });
    expect(await bare.execute({}, {})).toEqual({ ok: true });
  });

  it("defaults triggersReactLoop true, isSideChannel false, and tapeHidden false", () => {
    expect({ loop: echo.triggersReactLoop, side: echo.isSideChannel, hidden: echo.tapeHidden }).toEqual({
      loop: true,
      side: false,
      hidden: false,
    });
  });

  it("keeps an explicit side channel through the normalized record", () => {
    const note = new InhumanTool({
      name: "note",
      isSideChannel: true,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    });
    expect({ flag: note.isSideChannel, roundTrip: note.toToolDefinition().isSideChannel }).toEqual({
      flag: true,
      roundTrip: true,
    });
  });

  it("defaults function tools to symbols and bot-calls to tools", () => {
    const memory = new InhumanTool({
      name: "memory_save",
      type: "bot-call",
      target: "notes",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    });
    const both = new InhumanTool({
      name: "shell",
      representation: "both",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    });
    expect({
      fn: echo.representation,
      bot: memory.representation,
      both: both.representation,
      roundTrip: both.toToolDefinition().representation,
    }).toEqual({ fn: "symbol", bot: "tool", both: "both", roundTrip: "both" });
  });

  it("keeps tape face templates", () => {
    const note = new InhumanTool({
      name: "note",
      question: "Will {{subject}}",
      effect: "Did {{subject}}",
      caption: "{{hint}}",
      input: z.object({ subject: z.string() }),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    });
    expect(note.toToolDefinition()).toMatchObject({
      question: "Will {{subject}}",
      effect: "Did {{subject}}",
      caption: "{{hint}}",
    });
    const bare = new InhumanTool({
      name: "bare",
      question: null,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    });
    expect(bare.toToolDefinition()).toMatchObject({ question: null, effect: null, caption: null });
    expect(
      () =>
        new InhumanTool({
          name: "blank",
          question: "",
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          run: () => ({ ok: true }),
        }),
    ).toThrow(/non-empty/);
    const padded = new InhumanTool({
      name: "padded",
      question: "  Will {{subject}}  ",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    });
    expect(padded.question).toBe("Will {{subject}}");
  });

  it("admits exam tools without run", () => {
    const exam = new InhumanTool({
      name: "exam",
      class: "meta",
      triggersReactLoop: false,
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      exam: {
        program: () => "(look)",
        admit: (_state, input) => ({ type: "limbo", id: input.id }),
        settle: (_state, input, result) => ({ type: "verdict", id: input.id, ok: result.ok }),
      },
    });
    expect(exam.exam?.program({}, { id: "a" })).toBe("(look)");
    expect(exam.exam?.settle?.({}, { id: "a" }, { ok: true, comments: "" })).toEqual({
      type: "verdict",
      id: "a",
      ok: true,
    });
    expect(exam.triggersReactLoop).toBe(false);
  });

  it("rejects empty name", () => {
    expect(
      () =>
        new InhumanTool({
          name: "",
          input: z.string(),
          output: z.string(),
          run: (s) => s,
        }),
    ).toThrow(/name/);
  });
});
