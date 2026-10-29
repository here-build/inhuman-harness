import { Readable, Writable } from "node:stream";

import { expect, test } from "vitest";

import { startRender } from "../../render.js";
import { holdStderr } from "../stderr_hold.js";

type TtyWritable = Writable & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
};

function capturing(isTTY: boolean, events: string[] = [], tag?: string): { stream: TtyWritable; events: string[] } {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      events.push(tag === undefined ? String(chunk) : `${tag}:${String(chunk)}`);
      cb();
    },
  }) as TtyWritable;
  stream.isTTY = isTTY;
  stream.columns = 80;
  stream.rows = 24;
  return { stream, events };
}

test("held stderr is silent until release, then flushed once", () => {
  const { stream, events } = capturing(true);
  const hold = holdStderr(stream);
  stream.write("during\n");
  expect(events).toEqual([]);
  hold.release();
  hold.release();
  stream.write("after\n");
  expect(events).toEqual(["during\n", "after\n"]);
});

test("startRender feeds held stderr after leave-alt, not into the layout", async () => {
  const events: string[] = [];
  const stdout = capturing(true, events, "out");
  const stderr = capturing(true, events, "err");
  const stdin = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
  stdin.isTTY = false;

  const session = await startRender({
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    timeoutMs: 1,
    env: { QD_SYNC: "0" },
    input: { onData() {}, setRawMode() {} },
    output: { write() {}, cols: 80, rows: 24, onResize() {} },
    port: { post() {}, onBatch() {} },
  });

  try {
    stderr.stream.write("sdk client start\n");
    expect({
      leaked: events.some((e) => e.includes("sdk client")),
      entered: events.some((e) => e.includes("\x1b[?1049h")),
    }).toEqual({ leaked: false, entered: true });

    session.stop();
    session.restore();
    session.restore();

    const leave = events.findIndex((e) => e.includes("\x1b[?1049l"));
    const fed = events.findIndex((e) => e.includes("sdk client"));
    expect({ leave, fed, once: events.filter((e) => e.includes("sdk client")) }).toEqual({
      leave: expect.any(Number),
      fed: expect.any(Number),
      once: ["err:sdk client start\n"],
    });
    expect(leave).toBeGreaterThan(-1);
    expect(fed).toBeGreaterThan(leave);
  } finally {
    session.stop();
    session.restore();
  }
});

test("piped stderr is live during occupy", async () => {
  const stdout = capturing(true);
  const stderr = capturing(false);
  const stdin = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
  stdin.isTTY = false;

  const session = await startRender({
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    timeoutMs: 1,
    env: { QD_SYNC: "0" },
    input: { onData() {}, setRawMode() {} },
    output: { write() {}, cols: 80, rows: 24, onResize() {} },
    port: { post() {}, onBatch() {} },
  });

  try {
    stderr.stream.write("live\n");
    expect(stderr.events).toEqual(["live\n"]);
  } finally {
    session.stop();
    session.restore();
  }
});
