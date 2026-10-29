import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { parseVtLines, type VtColor, type VtRun, type VtStyle } from "@inhuman.tools/harness-model/vt-text";
import { IconChevronRight } from "@tabler/icons-react";

import { CodeView } from "./code-view.js";
import { detectInlineScript } from "./inline-script.js";
import type { ToolBody, ToolOutcome } from "./tool-receipt.js";
import { glyph } from "../components/ui/glyph.js";

const CUBE = [0, 95, 135, 175, 215, 255] as const;

export function ShellTerm({
  body,
  outcome = "ok",
  expanded = false,
}: {
  readonly body: Extract<ToolBody, { kind: "shell" }>;
  readonly outcome?: ToolOutcome;
  /** Ask cover: keep an inline script open so the program is visible before Allow. */
  readonly expanded?: boolean;
}) {
  const script = detectInlineScript(body.command);
  const exit = body.exitCode !== undefined && body.exitCode !== 0 ? body.exitCode : undefined;
  const live = outcome === "live";
  const failed = outcome === "failed" || exit !== undefined;
  const reveal = expanded && script !== null;
  const [open, setOpen] = useState(live || failed || reveal);
  const pinned = useRef(false);
  useEffect(() => {
    if (pinned.current) return;
    setOpen(live || failed || reveal);
  }, [failed, live, reveal]);
  return (
    <details className="shell-term" open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          pinned.current = true;
          setOpen((value) => !value);
        }}
      >
        <span className="shell-chevron" aria-hidden>
          <IconChevronRight {...glyph} />
        </span>
        <div className="shell-identity">
          {body.directory === undefined ? null : <p className="shell-cwd">{body.directory}</p>}
          {script === null ? (
            <div className="shell-cmd">
              <span className="shell-sigil">$</span>
              {body.command === "" ? null : <CodeView lang="bash" plain text={body.command} />}
            </div>
          ) : (
            <div className="shell-cmd shell-script-name">
              <span className="text-subtle">{script.label}</span>
            </div>
          )}
        </div>
        {exit === undefined ? null : <p className="shell-exit">exit code {exit}</p>}
      </summary>
      {script === null || script.source === "" ? null : (
        <div className="shell-script">
          <CodeView lang={script.lang} plain text={script.source} />
        </div>
      )}
      {body.output === "" ? null : <ShellOutput live={live} text={body.output} />}
    </details>
  );
}

function ShellOutput({ text, live }: { readonly text: string; readonly live: boolean }) {
  const lines = outputLines(text);
  const scroller = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!live || node == null) return;
    node.scrollTop = node.scrollHeight;
  }, [live, text]);
  return (
    <pre className={live ? "shell-out shell-out-live" : "shell-out"} ref={scroller}>
      <code>
        {lines.map((line, index) => (
          <span className="shell-out-line" key={index}>
            {line.map((run, runIndex) => {
              const style = runStyle(run.style);
              return style === undefined ? (
                run.text
              ) : (
                <span key={runIndex} style={style}>
                  {run.text}
                </span>
              );
            })}
          </span>
        ))}
      </code>
      <span className="shell-out-anchor" />
    </pre>
  );
}

/** A closing newline is a row terminator, not a blank line under the output. */
function outputLines(text: string): readonly (readonly VtRun[])[] {
  const lines = [...parseVtLines(text)];
  const last = lines.at(-1);
  if (lines.length > 1 && last?.every((run) => run.text === "") === true) lines.pop();
  return lines;
}

function runStyle(style: VtStyle): CSSProperties | undefined {
  const color = vtCss(style.fg);
  const background = vtCss(style.bg);
  if (
    color === undefined &&
    background === undefined &&
    style.bold !== true &&
    style.italic !== true &&
    style.underline !== true &&
    style.strike !== true
  ) {
    return undefined;
  }
  const out: CSSProperties = {};
  if (color !== undefined) out.color = color;
  if (background !== undefined) out.backgroundColor = background;
  // A palette badge (` FAIL `, ` RUN `) inks its gray text in the page canvas, which reads on the cell in either scheme.
  const gray = style.fg === undefined || [0, 7, 8, 15].includes(paletteIndex(style.fg) ?? -1);
  if (paletteIndex(style.bg) !== undefined && gray) {
    out.color = "var(--canvas)";
  }
  if (style.bold === true) out.fontWeight = 620;
  if (style.italic === true) out.fontStyle = "italic";
  if (style.underline === true || style.strike === true) {
    out.textDecoration =
      style.underline === true && style.strike === true
        ? "underline line-through"
        : style.underline === true
          ? "underline"
          : "line-through";
  }
  return out;
}

function paletteIndex(color: VtColor | undefined): number | undefined {
  return color === undefined || color.type === "rgb" || color.n >= 16 ? undefined : color.n;
}

function vtCss(color: VtColor | undefined): string | undefined {
  if (color === undefined) return undefined;
  if (color.type === "rgb") return `rgb(${color.r} ${color.g} ${color.b})`;
  if (color.n < 16) return `var(--vt-${color.n})`;
  if (color.n >= 232) {
    const level = 8 + (color.n - 232) * 10;
    return `rgb(${level} ${level} ${level})`;
  }
  const index = color.n - 16;
  const red = CUBE[Math.floor(index / 36)] ?? 0;
  const green = CUBE[Math.floor(index / 6) % 6] ?? 0;
  const blue = CUBE[index % 6] ?? 0;
  return `rgb(${red} ${green} ${blue})`;
}
