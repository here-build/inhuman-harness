import { beforeAll, expect, test } from "vitest";

import { detectShellEmbeds, guessLang, spliceEmbeds } from "../internals/embedded-syntax.js";
import { highlightCodeSync, warmHighlighter, type HighlightLine } from "../internals/syntax.js";

beforeAll(async () => {
  await warmHighlighter();
}, 60_000);

/** Concatenate a highlight back into source text — colors must not change text. */
function textOf(lines: HighlightLine[]): string {
  return lines.map((line) => line.map((run) => run.text).join("")).join("\n");
}

const cases: Array<{ name: string; command: string; covers: string; lang: string }> = [
  { name: "inline python -c", command: 'python -c "print(1)"', covers: "print(1)", lang: "python" },
  {
    name: "inline node -e single quotes",
    command: "node -e 'console.log(1)'",
    covers: "console.log(1)",
    lang: "javascript",
  },
  { name: "node --eval", command: 'node --eval "const x = 1"', covers: "const x = 1", lang: "javascript" },
  { name: "python3 -c", command: "python3 -c 'import os'", covers: "import os", lang: "python" },
  {
    name: "heredoc into py file",
    command: "cat > app.py << 'EOF'\nx = 1\nprint(x)\nEOF",
    covers: "x = 1\nprint(x)",
    lang: "python",
  },
  {
    name: "heredoc into js file unquoted delimiter",
    command: "cat > app.js << EOF\nconsole.log(1)\nEOF",
    covers: "console.log(1)",
    lang: "javascript",
  },
  {
    name: "heredoc into mts file",
    command: "cat > app.mts << EOF\nexport const x: number = 1\nEOF",
    covers: "export const x: number = 1",
    lang: "typescript",
  },
  {
    name: "heredoc into cjs file",
    command: "cat > app.cjs << EOF\nmodule.exports = 1\nEOF",
    covers: "module.exports = 1",
    lang: "javascript",
  },
  {
    name: "heredoc into scm file",
    command: "cat > hook.scm << EOF\n{:key 1}\nEOF",
    covers: "{:key 1}",
    lang: "scm",
  },
  {
    name: "interpreter stdin heredoc",
    command: 'python - << "EOF"\nprint("hi")\nEOF',
    covers: 'print("hi")',
    lang: "python",
  },
  {
    name: "heredoc append",
    command: "cat >> conf.yaml << EOF\nname: app\nEOF",
    covers: "name: app",
    lang: "yaml",
  },
  { name: "after && operator", command: 'echo hi && python -c "print(2)"', covers: "print(2)", lang: "python" },
  { name: "absolute interpreter path", command: '/usr/bin/python -c "print(3)"', covers: "print(3)", lang: "python" },
];

test.each(cases)("detectShellEmbeds $name", ({ command, covers, lang }) => {
  const regions = detectShellEmbeds(command);
  expect(regions).toHaveLength(1);
  expect(command.slice(regions[0]!.start, regions[0]!.end)).toBe(covers);
  expect(regions[0]!.lang).toBe(lang);
});

test.each(["ls -la", "git status --short", "echo hello world", "cat file.txt", "npm run build && npm test"])(
  "detectShellEmbeds leaves plain commands alone: $0",
  (command) => {
    expect(detectShellEmbeds(command)).toEqual([]);
  },
);

test.each([
  { name: "unterminated heredoc", command: "cat > app.py << 'EOF'\nx = 1\n" },
  { name: "heredoc with trailing command", command: "cat > app.py << EOF; ls\nx = 1\nEOF" },
  { name: "unbalanced inline quote", command: 'python -c "print(1)' },
  { name: "unknown interpreter", command: 'frobnicate -c "print(1)"' },
  { name: "unknown file extension", command: "cat > app.xyzzy << EOF\nnothing special\nEOF" },
])("detectShellEmbeds skips $name", ({ command }) => {
  expect(detectShellEmbeds(command)).toEqual([]);
});

test("detectShellEmbeds collapses overlapping regions", () => {
  // A python -c whose string contains a heredoc-shaped line: first region wins.
  const command = 'python -c "cat > x << EOF\nbody\nEOF"\n';
  const regions = detectShellEmbeds(command);
  for (const a of regions) {
    for (const b of regions) {
      if (a === b) continue;
      expect(a.start >= b.end || a.end <= b.start).toBe(true);
    }
  }
  expect(regions[0]?.lang).toBe("python");
});

test("guessLang still infers for untagged content", () => {
  expect(guessLang("def greet(name):\n    return name")).toBe("python");
  expect(guessLang('{"a": 1, "b": [2, 3]}')).toBe("json");
  expect(guessLang("some plain prose without code at all")).toBeUndefined();
});

test("spliceEmbeds preserves source text exactly", () => {
  for (const { command } of cases) {
    const baseline = highlightCodeSync(command, { lang: "bash" });
    const regions = detectShellEmbeds(command);
    const spliced = spliceEmbeds(baseline, command, regions, (code, lang) => highlightCodeSync(code, { lang }));
    expect(textOf(spliced)).toBe(command);
    expect(spliced.length).toBe(baseline.length);
  }
});
test("spliceEmbeds colors embedded code with its own language", () => {
  const command = "cat > app.py << 'EOF'\nx = 1\nprint(x)\nEOF";
  const baseline = highlightCodeSync(command, { lang: "bash" });
  const spliced = spliceEmbeds(baseline, command, detectShellEmbeds(command), (code, lang) =>
    highlightCodeSync(code, { lang }),
  );
  // Heredoc body was one flat bash string color; python paints it with its
  // own palette, so the body carries a color bash never used.
  const bodyColors = new Set(
    spliced
      .slice(1, 3)
      .flat()
      .filter((r) => r.color)
      .map((r) => r.color),
  );
  const bashColors = new Set(baseline[0]!.filter((r) => r.color).map((r) => r.color));
  expect([...bodyColors].some((c) => !bashColors.has(c))).toBe(true);
  // The bash parts (cat, <<, EOF) keep their bash coloring.
  expect(spliced[0]!.some((run) => run.color !== undefined)).toBe(true);
  expect(spliced[3]![0]!.text).toBe("EOF");
});

test("spliceEmbeds is byte-identical when a language is not warm", () => {
  // 'sql' is not in WARM_LANGS: the region is dropped, baseline returned as-is.
  const command = "sqlite3 db << 'EOF'\nSELECT 1;\nEOF";
  const baseline = highlightCodeSync(command, { lang: "bash" });
  const spliced = spliceEmbeds(baseline, command, detectShellEmbeds(command), (code, lang) =>
    highlightCodeSync(code, { lang }),
  );
  expect(spliced).toBe(baseline);
});

test("highlightCodeSync integrates embeds end to end", () => {
  const command = 'python -c "print(1)"';
  const lines = highlightCodeSync(command, { lang: "bash" });
  expect(textOf(lines)).toBe(command);
  // Baseline colors the whole argument as one bash string run; the embedded
  // python tokenizer splits the span into one run per token.
  const open = command.indexOf('"') + 1;
  const close = command.lastIndexOf('"');
  let pos = 0;
  const inside = lines[0]!.filter((run) => {
    const from = pos;
    pos += run.text.length;
    return from >= open && pos <= close;
  });
  expect(inside.length).toBeGreaterThan(1);
  expect(inside.every((run) => run.color !== undefined)).toBe(true);
});

test("highlightCodeSync leaves non-shell languages untouched", () => {
  const code = "const x: number = 1;";
  const ts = highlightCodeSync(code, { lang: "typescript" });
  // No embed detection outside bash/shell — typescript is not a shell command.
  expect(textOf(ts)).toBe(code);
  expect(ts[0]!.map((run) => run.text).join("")).toBe(code);
});

test("arrival scm highlights polyglot literals without rewriting source", () => {
  const code = '{:key "hi" :n 1}\n(define x #null)\n[a b]';
  const lines = highlightCodeSync(code, { lang: "scm" });
  const colors = new Set(
    lines
      .flat()
      .filter((run) => run.color !== undefined)
      .map((run) => run.color),
  );
  expect({ text: textOf(lines), colors: colors.size >= 3 }).toEqual({ text: code, colors: true });
});
