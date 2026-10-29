import { SystemToolJob } from "@inhuman.tools/harness-model/session";
import { parseVtLines, stripVt, type VtRun } from "@inhuman.tools/harness-model/vt-text";
import { expect, test } from "vitest";

const ESC = "\u001b";

function texts(lines: readonly (readonly VtRun[])[]): string {
  return lines.map((line) => line.map((run) => run.text).join("")).join("\n");
}

function styles(lines: readonly (readonly VtRun[])[]): unknown {
  return lines.map((line) =>
    line.map((run) => ({
      text: run.text,
      fg: run.style.fg,
      bold: run.style.bold ?? false,
    })),
  );
}

test("VT replay strips controls for the model and keeps SGR identity for paint", () => {
  const red = `${ESC}[31mred${ESC}[0m`;
  const charset = `ok${ESC}(Bplain`;
  const osc = `click${ESC}]8;;https://evil${ESC}\\here`;
  const progress = `  1%${ESC}[K\r100%`;
  const cube = `${ESC}[38;5;196mhot${ESC}[m`;
  const rgb = `${ESC}[38;2;249;117;131mpink${ESC}[0m`;
  const bold = `${ESC}[1;32mgo${ESC}[0m`;
  const c1 = `\u009b32mgreen\u009bm`;
  const read = new SystemToolJob({
    name: "read_file",
    outcomeJson: JSON.stringify({ ok: true, text: red }),
  });
  const shell = new SystemToolJob({
    name: "shell",
    outcomeJson: JSON.stringify({
      ok: true,
      value: { exitCode: 0, stdout: `${red}\n${progress}`, stderr: `${ESC}[31merr${ESC}[0m` },
    }),
  });
  const door = new SystemToolJob({
    name: "shell",
    outcomeJson: JSON.stringify({ ok: false, text: `${ESC}[31mfail${ESC}[0m` }),
  });
  expect({
    strip: {
      red: stripVt(red),
      charset: stripVt(charset),
      osc: stripVt(osc),
      progress: stripVt(progress),
      cube: stripVt(cube),
      leftover: stripVt(red).includes("[") || stripVt(charset).includes("B"),
    },
    paint: {
      red: styles(parseVtLines(red)),
      bold: styles(parseVtLines(bold)),
      cube: styles(parseVtLines(cube)),
      rgb: styles(parseVtLines(rgb)),
      c1: texts(parseVtLines(c1)),
    },
    model: {
      stored: (shell.outcomeSnap?.value as { stdout: string }).stdout.includes(ESC),
      stdout: (shell.observationPayload() as { stdout: string; stderr: string }).stdout,
      stderr: (shell.observationPayload() as { stdout: string; stderr: string }).stderr,
      door: door.observationPayload(),
      file: read.observationPayload(),
    },
  }).toEqual({
    strip: {
      red: "red",
      charset: "okplain",
      osc: "clickhere",
      progress: "100%",
      cube: "hot",
      leftover: false,
    },
    paint: {
      red: [[{ text: "red", fg: { type: "index", n: 1 }, bold: false }]],
      bold: [[{ text: "go", fg: { type: "index", n: 2 }, bold: true }]],
      cube: [[{ text: "hot", fg: { type: "index", n: 196 }, bold: false }]],
      rgb: [[{ text: "pink", fg: { type: "rgb", r: 249, g: 117, b: 131 }, bold: false }]],
      c1: "green",
    },
    model: {
      stored: true,
      stdout: "red\n100%",
      stderr: "err",
      door: "fail",
      file: red,
    },
  });
});
