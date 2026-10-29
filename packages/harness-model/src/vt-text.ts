/**
 * VT stream → text runs. Shell pipes are not a PTY: SGR identity is kept,
 * cursor/OSC/charset/C0 are consumed so they cannot leak as glyphs.
 *
 * `\r` / `\b` / EL replay the current line (progress bars). The model sees
 * {@link stripVt}; paint sees {@link parseVtLines}. Same walk — the two
 * projections cannot drift.
 */
export type VtColor =
  | { readonly type: "index"; readonly n: number }
  | { readonly type: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export type VtStyle = {
  readonly fg?: VtColor;
  readonly bg?: VtColor;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
};

export type VtRun = {
  readonly text: string;
  readonly style: VtStyle;
};

type StyleState = {
  fg: VtColor | undefined;
  bg: VtColor | undefined;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
};

type Cell = { ch: string; style: VtStyle };

const TAB = 8;
const EMPTY: VtStyle = {};

function resetStyle(s: StyleState): void {
  s.fg = undefined;
  s.bg = undefined;
  s.bold = false;
  s.italic = false;
  s.underline = false;
  s.strike = false;
}

function snapshot(s: StyleState): VtStyle {
  return {
    ...(s.fg === undefined ? {} : { fg: s.fg }),
    ...(s.bg === undefined ? {} : { bg: s.bg }),
    ...(s.bold ? { bold: true } : {}),
    ...(s.italic ? { italic: true } : {}),
    ...(s.underline ? { underline: true } : {}),
    ...(s.strike ? { strike: true } : {}),
  };
}

function sameColor(a: VtColor | undefined, b: VtColor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.type === "index" && b.type === "index") return a.n === b.n;
  if (a.type === "rgb" && b.type === "rgb") return a.r === b.r && a.g === b.g && a.b === b.b;
  return false;
}

function sameStyle(a: VtStyle, b: VtStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    sameColor(a.fg, b.fg) &&
    sameColor(a.bg, b.bg)
  );
}

function styled(style: VtStyle): boolean {
  return (
    style.fg !== undefined ||
    style.bg !== undefined ||
    style.bold === true ||
    style.italic === true ||
    style.underline === true ||
    style.strike === true
  );
}

function runsOf(line: readonly Cell[]): VtRun[] {
  if (line.length === 0) return [{ text: "", style: EMPTY }];
  const runs: VtRun[] = [];
  let text = line[0]!.ch;
  let style = line[0]!.style;
  for (let i = 1; i < line.length; i++) {
    const cell = line[i]!;
    if (sameStyle(style, cell.style)) {
      text += cell.ch;
      continue;
    }
    runs.push({ text, style });
    text = cell.ch;
    style = cell.style;
  }
  runs.push({ text, style });
  return runs;
}

function applySgr(raw: string, s: StyleState): void {
  const parts = raw.length === 0 ? [""] : raw.split(/[;:]/);
  const nums = parts.map((part) => {
    if (part === "") return 0;
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : Number.NaN;
  });
  let i = 0;
  if (nums.length === 0) {
    resetStyle(s);
    return;
  }
  while (i < nums.length) {
    const n = nums[i]!;
    i += 1;
    if (!Number.isFinite(n)) continue;
    if (n === 0) {
      resetStyle(s);
      continue;
    }
    if (n === 1) {
      s.bold = true;
      continue;
    }
    if (n === 3) {
      s.italic = true;
      continue;
    }
    if (n === 4) {
      s.underline = true;
      continue;
    }
    if (n === 9) {
      s.strike = true;
      continue;
    }
    if (n === 22) {
      s.bold = false;
      continue;
    }
    if (n === 23) {
      s.italic = false;
      continue;
    }
    if (n === 24) {
      s.underline = false;
      continue;
    }
    if (n === 29) {
      s.strike = false;
      continue;
    }
    if (n === 39) {
      s.fg = undefined;
      continue;
    }
    if (n === 49) {
      s.bg = undefined;
      continue;
    }
    if (n === 38 || n === 48) {
      const color = readColor(nums, i);
      i = color.next;
      if (n === 38) s.fg = color.value;
      else s.bg = color.value;
      continue;
    }
    if (n >= 30 && n <= 37) s.fg = { type: "index", n: n - 30 };
    else if (n >= 40 && n <= 47) s.bg = { type: "index", n: n - 40 };
    else if (n >= 90 && n <= 97) s.fg = { type: "index", n: n - 90 + 8 };
    else if (n >= 100 && n <= 107) s.bg = { type: "index", n: n - 100 + 8 };
  }
}

function unitAt(s: string, i: number): number {
  return s.codePointAt(i) ?? Number.NaN;
}

function readColor(nums: readonly number[], start: number): { value: VtColor | undefined; next: number } {
  const mode = nums[start];
  if (mode === 5) {
    const n = nums[start + 1] ?? Number.NaN;
    if (!Number.isFinite(n)) return { value: undefined, next: start + 1 };
    return { value: { type: "index", n: Math.max(0, Math.min(255, n)) }, next: start + 2 };
  }
  if (mode === 2) {
    let i = start + 1;
    // ITU T.416 optional color space: 38:2::r:g:b leaves an empty/NaN slot.
    if (i < nums.length && !Number.isFinite(nums[i]!)) i += 1;
    const r = nums[i] ?? Number.NaN;
    const g = nums[i + 1] ?? Number.NaN;
    const b = nums[i + 2] ?? Number.NaN;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      return { value: undefined, next: i + 3 };
    }
    return {
      value: {
        type: "rgb",
        r: clampByte(r),
        g: clampByte(g),
        b: clampByte(b),
      },
      next: i + 3,
    };
  }
  return { value: undefined, next: start + 1 };
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function isFinalCsi(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function consumeSt(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = unitAt(s, i);
    if (c === 0x07 || c === 0x9c) return i + 1;
    if (c === 0x1b && unitAt(s, i + 1) === 0x5c) return i + 2;
  }
  return s.length;
}

function consumeCsi(s: string, from: number): { spec: string; final: string; next: number } {
  let i = from;
  while (i < s.length && !isFinalCsi(unitAt(s, i))) i += 1;
  if (i >= s.length) return { spec: s.slice(from), final: "", next: s.length };
  return { spec: s.slice(from, i), final: s[i]!, next: i + 1 };
}

function padTo(line: Cell[], col: number): void {
  while (line.length < col) line.push({ ch: " ", style: EMPTY });
}

function writeChar(line: Cell[], col: number, ch: string, style: VtStyle): number {
  padTo(line, col);
  if (col < line.length) line[col] = { ch, style };
  else line.push({ ch, style });
  return col + 1;
}

function eraseLine(line: Cell[], col: number, kind: number): void {
  if (kind === 2) {
    line.length = 0;
    return;
  }
  if (kind === 1) {
    const n = Math.min(col, line.length);
    for (let i = 0; i < n; i++) line[i] = { ch: " ", style: EMPTY };
    return;
  }
  if (col < line.length) line.length = col;
}

/**
 * Replay a VT stream into styled rows. Control sequences never appear in
 * `text`. A run with empty style is default ink.
 */
export function parseVtLines(text: string): readonly (readonly VtRun[])[] {
  const style: StyleState = {
    fg: undefined,
    bg: undefined,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
  };
  const rows: Cell[][] = [[]];
  let line = rows[0]!;
  let col = 0;

  const commit = (): void => {
    rows.push([]);
    line = rows.at(-1)!;
    col = 0;
  };

  for (let i = 0; i < text.length;) {
    const code = unitAt(text, i);
    if (code === 0x1b || code === 0x9b) {
      if (code === 0x9b) {
        const csi = consumeCsi(text, i + 1);
        if (csi.final === "m") applySgr(csi.spec.replace(/^[?-]/, ""), style);
        else if (csi.final === "K") eraseLine(line, col, Number.parseInt(csi.spec, 10) || 0);
        i = csi.next;
        continue;
      }
      const next = unitAt(text, i + 1);
      if (next === 0x5b) {
        const csi = consumeCsi(text, i + 2);
        if (csi.final === "m") applySgr(csi.spec.replace(/^[?-]/, ""), style);
        else if (csi.final === "K") eraseLine(line, col, Number.parseInt(csi.spec, 10) || 0);
        i = csi.next;
        continue;
      }
      if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        i = consumeSt(text, i + 2);
        continue;
      }
      if (next === 0x28 || next === 0x29 || next === 0x2a || next === 0x2b || next === 0x25) {
        i += 3;
        continue;
      }
      if (next === 0x63) resetStyle(style);
      i += i + 1 >= text.length ? 1 : 2;
      continue;
    }
    if (code === 0x0a) {
      commit();
      i += 1;
      continue;
    }
    if (code === 0x0d) {
      col = 0;
      i += 1;
      continue;
    }
    if (code === 0x08) {
      col = Math.max(0, col - 1);
      i += 1;
      continue;
    }
    if (code === 0x09) {
      const target = col + (TAB - (col % TAB));
      const ink = snapshot(style);
      while (col < target) col = writeChar(line, col, " ", ink);
      i += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      i += 1;
      continue;
    }
    const cp = text.codePointAt(i)!;
    col = writeChar(line, col, String.fromCodePoint(cp), snapshot(style));
    i += cp > 0xff_ff ? 2 : 1;
  }

  return rows.map(runsOf);
}

export function stripVt(text: string): string {
  return parseVtLines(text)
    .map((line) => line.map((run) => run.text).join(""))
    .join("\n");
}

export function vtRunStyled(run: VtRun): boolean {
  return styled(run.style);
}

/** Shell observation: keep the dict, strip VT from stdout/stderr (and door text). */
export function stripShellObservation(payload: unknown): unknown {
  if (typeof payload === "string") return stripVt(payload);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const rec = payload as Record<string, unknown>;
  const stdout = rec.stdout;
  const stderr = rec.stderr;
  if (typeof stdout !== "string" && typeof stderr !== "string") return payload;
  return {
    ...rec,
    ...(typeof stdout === "string" ? { stdout: stripVt(stdout) } : {}),
    ...(typeof stderr === "string" ? { stderr: stripVt(stderr) } : {}),
  };
}
