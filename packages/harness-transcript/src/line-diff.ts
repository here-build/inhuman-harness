export type DiffRow =
  | {
      readonly kind: "ctx" | "add" | "del";
      readonly oldNo: number | null;
      readonly newNo: number | null;
      readonly text: string;
    }
  | { readonly kind: "gap"; readonly hidden: number };

const CONTEXT = 3;
/** Past this many cell comparisons the diff is the whole old text removed and the whole new text added. */
const BUDGET = 4_000_000;

type Op = { readonly kind: "ctx" | "add" | "del"; readonly text: string };

function ops(before: readonly string[], after: readonly string[]): Op[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const out: Op[] = before.slice(0, head).map((text) => ({ kind: "ctx", text }));
  if (a.length * b.length > BUDGET) {
    for (const text of a) out.push({ kind: "del", text });
    for (const text of b) out.push({ kind: "add", text });
  } else {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        out.push({ kind: "ctx", text: a[i] });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        out.push({ kind: "del", text: a[i] });
        i += 1;
      } else {
        out.push({ kind: "add", text: b[j] });
        j += 1;
      }
    }
    for (; i < a.length; i += 1) out.push({ kind: "del", text: a[i] });
    for (; j < b.length; j += 1) out.push({ kind: "add", text: b[j] });
  }
  for (const text of before.slice(before.length - tail)) out.push({ kind: "ctx", text });
  return out;
}

function lines(text: string): string[] {
  if (text === "") return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}

/**
 * Line diff with three lines of context, hunks separated by a gap row.
 * `lineStart` is the line of the first old line in its file (1 when omitted).
 */
export function lineDiff(oldText: string, newText: string, lineStart = 1): readonly DiffRow[] {
  const first = Number.isFinite(lineStart) && lineStart > 1 ? Math.floor(lineStart) : 1;
  let oldNo = first;
  let newNo = first;
  const all: DiffRow[] = ops(lines(oldText), lines(newText)).map((op) => {
    if (op.kind === "ctx") return { kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: op.text };
    if (op.kind === "del") return { kind: "del", oldNo: oldNo++, newNo: null, text: op.text };
    return { kind: "add", oldNo: null, newNo: newNo++, text: op.text };
  });
  const keep = Array.from({ length: all.length }).fill(false);
  for (const [index, row] of all.entries()) {
    if (row.kind === "ctx") continue;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(all.length - 1, index + CONTEXT); k += 1) keep[k] = true;
  }
  const rows: DiffRow[] = [];
  let hidden = 0;
  for (const [index, row] of all.entries()) {
    if (keep[index]) {
      if (hidden > 0 && rows.length > 0) rows.push({ kind: "gap", hidden });
      hidden = 0;
      rows.push(row);
    } else {
      hidden += 1;
    }
  }
  return rows;
}
