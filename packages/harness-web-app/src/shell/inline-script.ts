export type InlineScript = {
  readonly lang: "python" | "javascript";
  readonly label: "Python script" | "NodeJS script";
  readonly source: string;
};

/** A shell invocation that *is* an inline Python or Node program, or null. */
export function detectInlineScript(command: string): InlineScript | null {
  const stripped = stripPrefix(command.trim());
  if (stripped === "") return null;
  const newline = stripped.indexOf("\n");
  const header = newline === -1 ? stripped : stripped.slice(0, newline);
  const rest = newline === -1 ? "" : stripped.slice(newline + 1);
  const heredoc = heredocScript(header, rest);
  if (heredoc !== undefined) return heredoc;
  return evalScript(stripped);
}

function pythonScript(source: string): InlineScript {
  return { lang: "python", label: "Python script", source };
}

function nodeScript(source: string): InlineScript {
  return { lang: "javascript", label: "NodeJS script", source };
}

function stripPrefix(command: string): string {
  let rest = command;
  const cd = /^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/.exec(rest);
  if (cd !== null) rest = rest.slice(cd[0].length);
  for (;;) {
    rest = rest.replace(/^[ \t]+/, "");
    const assign = /^[A-Z_]\w*=(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s+/i.exec(rest);
    if (assign !== null) {
      rest = rest.slice(assign[0].length);
      continue;
    }
    const wrap = /^(?:env|sudo|command|exec)\s+/.exec(rest);
    if (wrap !== null) {
      rest = rest.slice(wrap[0].length);
      continue;
    }
    return rest;
  }
}

function isPythonBin(base: string): boolean {
  if (base === "py") return true;
  if (!base.startsWith("python")) return false;
  const rest = base.slice("python".length);
  if (rest === "") return true;
  return rest.split(".").every((part) => part.length > 0 && [...part].every((ch) => ch >= "0" && ch <= "9"));
}

function kindOf(argv0: string): "python" | "javascript" | null {
  const base = argv0.split("/").pop() ?? argv0;
  if (isPythonBin(base)) return "python";
  if (base === "node" || base === "nodejs") return "javascript";
  return null;
}

function heredocScript(header: string, rest: string): InlineScript | null | undefined {
  const open = /<<(-)?\s*\\?(['"]?)([A-Z_]\w*)\2/i.exec(header);
  if (open === null) return undefined;
  const lead = header.slice(0, open.index).trim();
  const words = lead.split(/\s+/).filter((word) => word !== "");
  const kind = kindOf(words[0] ?? "");
  if (kind === null) return null;
  for (const flag of words.slice(1)) {
    if (!flag.startsWith("-") || flag.startsWith("-m")) return null;
  }
  const tail = header.slice(open.index + open[0].length).replaceAll("||", "");
  if (tail.includes("|")) return null;
  const source = heredocBody(rest, open[3], open[1] === "-");
  return kind === "python" ? pythonScript(source) : nodeScript(source);
}

function heredocBody(rest: string, delimiter: string, stripTabs: boolean): string {
  if (rest === "") return "";
  const lines = rest.endsWith("\n") ? rest.slice(0, -1).split("\n") : rest.split("\n");
  const body: string[] = [];
  for (const line of lines) {
    const bare = (stripTabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "");
    if (bare.trimEnd() === delimiter) break;
    body.push(bare);
  }
  return body.join("\n");
}

function evalScript(command: string): InlineScript | null {
  let index = 0;
  const argv0 = readWord(command, index);
  if (argv0 === null) return null;
  const kind = kindOf(argv0.value);
  if (kind === null) return null;
  index = argv0.end;
  while (index < command.length) {
    index = skipSpace(command, index);
    if (index >= command.length) return null;
    if (isBoundary(command, index)) return null;
    const word = readWord(command, index);
    if (word === null) return null;
    const text = word.value;
    if (text === "-m" || text.startsWith("-m")) return null;
    const code = evalCode(kind, text, command, word.end);
    if (code !== undefined) {
      if (code.includes("$(") || code.includes("`")) return null;
      return kind === "python" ? pythonScript(code) : nodeScript(code);
    }
    if (!text.startsWith("-")) return null;
    index = word.end;
  }
  return null;
}

function evalCode(kind: "python" | "javascript", text: string, command: string, end: number): string | undefined {
  if (kind === "python") {
    if (text === "-c") return readWord(command, skipSpace(command, end))?.value;
    if (text.startsWith("-c")) return text.slice(2);
    return undefined;
  }
  if (text === "-e" || text === "--eval") return readWord(command, skipSpace(command, end))?.value;
  if (text.startsWith("--eval=")) return text.slice("--eval=".length);
  if (text.startsWith("-e")) return text.slice(2);
  return undefined;
}

function readWord(text: string, start: number): { readonly value: string; readonly end: number } | null {
  let index = start;
  if (index >= text.length || isBoundary(text, index)) return null;
  let value = "";
  while (index < text.length && !isBoundary(text, index)) {
    const quote = text[index];
    if (quote === "'" || quote === '"') {
      const close = scanQuoted(text, index + 1, quote);
      if (close === undefined) {
        value += text.slice(index + 1);
        return { value, end: text.length };
      }
      const inner = text.slice(index + 1, close);
      value += quote === "'" ? inner : inner.replaceAll(/\\(["\\])/g, "$1");
      index = close + 1;
      continue;
    }
    value += text[index];
    index += 1;
  }
  return value === "" ? null : { value, end: index };
}

function scanQuoted(text: string, from: number, quote: string): number | undefined {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return undefined;
}

function skipSpace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t" || text[cursor] === "\n")) cursor += 1;
  return cursor;
}

function isBoundary(text: string, index: number): boolean {
  const ch = text[index];
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === ";" ||
    ch === "|" ||
    ch === "&" ||
    ch === "<" ||
    ch === ">" ||
    text.startsWith("<<", index)
  );
}
