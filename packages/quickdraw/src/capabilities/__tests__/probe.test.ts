import { PassThrough } from "node:stream";

import { expect, test } from "vitest";

import {
  detectCapabilities,
  extractOsc11FromBuffer,
  guessColorDepth,
  hasDa1Reply,
  osc52Set,
  parseDecrqm2026,
  parseOsc11Payload,
  PROBE_BATCH,
  stripProbeReplies,
} from "../index.js";

type TtyStream = PassThrough & { isTTY?: boolean };

function mockTty(): { stdin: TtyStream; stdout: TtyStream } {
  const stdin = new PassThrough() as TtyStream;
  const stdout = new PassThrough() as TtyStream;
  stdin.isTTY = true;
  stdout.isTTY = true;
  return { stdin, stdout };
}

test("probe leftover keys (C7) fused with OSC11/DA1 parse + env depth", async () => {
  expect({
    rgb0000: parseOsc11Payload("rgb:0000/0000/0000"),
    rgbffff: parseOsc11Payload("rgb:ffff/ffff/ffff"),
    hex: parseOsc11Payload("#1e1e1e"),
    garbage: parseOsc11Payload("nope"),
    bel: extractOsc11FromBuffer("noise\x1b]11;rgb:1111/2222/3333\x07more"),
    st: extractOsc11FromBuffer("\x1b]11;rgb:aa/bb/cc\x1b\\"),
    unterminated: extractOsc11FromBuffer("\x1b]11;rgb:1"),
    unterminatedFull: extractOsc11FromBuffer("\x1b]11;rgb:1234/0/0"),
    extractEmpty: extractOsc11FromBuffer(""),
    extractGarbage: extractOsc11FromBuffer("garbage no osc"),
    decrqmSet: parseDecrqm2026("\x1b[?2026;1$y"),
    decrqmReset: parseDecrqm2026("\x1b[?2026;2$y"),
    decrqmMissing: parseDecrqm2026("nothing"),
    da1: hasDa1Reply("\x1b[?62;c"),
    da1Plain: hasDa1Reply("plain"),
    stripEmpty: stripProbeReplies("\x1b]11;rgb:8080/8080/8080\x07" + "\x1b[?2026;1$y" + "\x1b[?62;c"),
    stripInterleaved: stripProbeReplies(
      "h" + "\x1b]11;rgb:ff/ff/ff\x07" + "e" + "\x1b[?2026;2$y" + "ll" + "\x1b[?62;1;2;c" + "o",
    ),
    stripSt: stripProbeReplies("ab\x1b]11;rgb:0/0/0\x1b\\cd"),
    stripIncomplete: stripProbeReplies("\x1b]11;rgb:1"),
    stripKeys: stripProbeReplies("q\x03"),
  }).toEqual({
    rgb0000: { r: 0, g: 0, b: 0 },
    rgbffff: { r: 255, g: 255, b: 255 },
    hex: { r: 30, g: 30, b: 30 },
    garbage: null,
    bel: "rgb:1111/2222/3333",
    st: "rgb:aa/bb/cc",
    unterminated: null,
    unterminatedFull: null,
    extractEmpty: null,
    extractGarbage: null,
    decrqmSet: true,
    decrqmReset: false,
    decrqmMissing: null,
    da1: true,
    da1Plain: false,
    stripEmpty: "",
    stripInterleaved: "hello",
    stripSt: "abcd",
    stripIncomplete: "\x1b]11;rgb:1",
    stripKeys: "q\x03",
  });

  const envRows = [
    [{ COLORTERM: "truecolor" }, "truecolor"],
    [{ COLORTERM: "24bit" }, "truecolor"],
    [{ TERM: "xterm-256color" }, "ansi256"],
    [{ TERM: "vt100" }, "ansi16"],
    [{}, "ansi16"],
    [{ WT_SESSION: "1", TERM: "xterm" }, "truecolor"],
    [{ NO_COLOR: "1" }, "mono"],
    [{ NO_COLOR: "" }, "mono"],
    [{ NO_COLOR: "1", COLORTERM: "truecolor" }, "mono"],
    [{ NO_COLOR: "1", WT_SESSION: "1", TERM: "xterm" }, "mono"],
  ] as const;
  expect(envRows.map(([env]) => guessColorDepth(env))).toEqual(envRows.map(([, depth]) => depth));

  const notTtyIn = new PassThrough();
  const notTtyOut = new PassThrough();
  const notTtyWritten: string[] = [];
  notTtyOut.on("data", (c: Buffer | string) => {
    notTtyWritten.push(typeof c === "string" ? c : c.toString("utf8"));
  });
  const notTty = await detectCapabilities({
    stdin: notTtyIn,
    stdout: notTtyOut,
    env: { TERM: "xterm-256color" },
    timeoutMs: 20,
  });
  expect({
    tty: notTty.caps.tty,
    colorDepth: notTty.caps.colorDepth,
    leftover: notTty.leftover,
    written: notTtyWritten.join(""),
  }).toEqual({
    tty: false,
    colorDepth: "ansi256",
    leftover: "",
    written: "",
  });

  const batch = mockTty();
  const batchWritten: string[] = [];
  batch.stdout.on("data", (c: Buffer | string) => {
    batchWritten.push(typeof c === "string" ? c : c.toString("utf8"));
  });
  const batchP = detectCapabilities({
    stdin: batch.stdin,
    stdout: batch.stdout,
    env: { TERM: "xterm-256color" },
    timeoutMs: 300,
  });
  expect(batchWritten.join("")).toEqual(PROBE_BATCH);
  batch.stdin.write("\x1b]11;rgb:8080/8080/8080\x07");
  batch.stdin.write("\x1b[?62;c");
  const batchResult = await batchP;
  expect({
    tty: batchResult.caps.tty,
    groundRgb: batchResult.caps.groundRgb,
    leftover: batchResult.leftover,
  }).toEqual({
    tty: true,
    groundRgb: { r: 128, g: 128, b: 128 },
    leftover: "",
  });

  const interleaved = mockTty();
  const interleavedP = detectCapabilities({
    stdin: interleaved.stdin,
    stdout: interleaved.stdout,
    env: { TERM: "xterm-256color" },
    timeoutMs: 300,
  });
  interleaved.stdin.write("hi");
  interleaved.stdin.write("\x1b]11;rgb:8080/8080/8080\x07");
  interleaved.stdin.write("!");
  interleaved.stdin.write("\x1b[?62;c");
  const interleavedResult = await interleavedP;
  expect({
    groundRgb: interleavedResult.caps.groundRgb,
    leftover: interleavedResult.leftover,
  }).toEqual({
    groundRgb: { r: 128, g: 128, b: 128 },
    leftover: "hi!",
  });

  const timeoutGround = mockTty();
  const timeoutGroundP = detectCapabilities({
    stdin: timeoutGround.stdin,
    stdout: timeoutGround.stdout,
    env: {},
    timeoutMs: 40,
  });
  timeoutGround.stdin.write("\x1b]11;rgb:ff/ff/ff\x07");
  const timeoutGroundResult = await timeoutGroundP;
  expect({
    groundRgb: timeoutGroundResult.caps.groundRgb,
    leftover: timeoutGroundResult.leftover,
  }).toEqual({
    groundRgb: { r: 255, g: 255, b: 255 },
    leftover: "",
  });

  const timeoutKeys = mockTty();
  const timeoutKeysP = detectCapabilities({
    stdin: timeoutKeys.stdin,
    stdout: timeoutKeys.stdout,
    env: {},
    timeoutMs: 40,
  });
  timeoutKeys.stdin.write("xy");
  const timeoutKeysResult = await timeoutKeysP;
  expect(timeoutKeysResult.leftover).toEqual("xy");

  const partial = mockTty();
  const partialP = detectCapabilities({
    stdin: partial.stdin,
    stdout: partial.stdout,
    env: {},
    timeoutMs: 40,
  });
  partial.stdin.write("\x1b]11;rgb:1");
  const partialResult = await partialP;
  expect({
    groundRgb: partialResult.caps.groundRgb,
    leftover: partialResult.leftover,
  }).toEqual({
    groundRgb: undefined,
    leftover: "\x1b]11;rgb:1",
  });
});

test.each([
  { text: "hello", selector: "c" as const, want: "\x1b]52;c;aGVsbG8=\x07" },
  { text: "x", selector: "p" as const, want: "\x1b]52;p;eA==\x07" },
  { text: "ab", selector: "cp" as const, want: "\x1b]52;cp;YWI=\x07" },
  { text: "ab", selector: undefined, want: "\x1b]52;cp;YWI=\x07" },
  { text: "→", selector: "c" as const, want: "\x1b]52;c;4oaS\x07" },
  { text: "", selector: "c" as const, want: "\x1b]52;c;\x07" },
])("OSC 52 $text $selector", ({ text, selector, want }) => {
  expect(osc52Set(text, selector)).toEqual(want);
});
