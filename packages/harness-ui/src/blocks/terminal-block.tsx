import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { IconChevronRight } from "@tabler/icons-react";

import { CodeBlock } from "./code-block.js";
import { detectInlineScript } from "./inline-script.js";
import { TranscriptDisclosurePanel } from "./transcript-disclosure.js";
import { cn } from "../lib/cn.js";
import { glyph } from "../primitives/glyph.js";
import { Disclosure, FieldButton } from "../primitives/navigation.js";

const CUBE = [0, 95, 135, 175, 215, 255] as const;

/** Structural ANSI/VT color descriptor compatible with terminal parser outputs. */
export type VtColor =
  | { readonly type: "index"; readonly n: number }
  | { readonly type: "rgb"; readonly r: number; readonly g: number; readonly b: number };

/** Structural VT text styling flags for a single run. */
export interface VtStyle {
  readonly fg?: VtColor;
  readonly bg?: VtColor;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
}

/** Single styled text run inside a parsed terminal output line. */
export interface VtRun {
  readonly text: string;
  readonly style: VtStyle;
}

/** Lifecycle status of a shell invocation block. */
export type TerminalOutcome = "live" | "ok" | "failed";

export interface TerminalBlockProps {
  readonly command: string;
  readonly directory?: string;
  readonly output: string;
  readonly exitCode?: number;
  readonly outcome?: TerminalOutcome;
  /** Keep inline Python/Node scripts expanded when approval is pending. */
  readonly expanded?: boolean;
  /** Optional parser turning raw VT output into styled runs; defaults to plain line splitting. */
  readonly parseOutput?: (text: string) => Iterable<readonly VtRun[]>;
  /** Optional pre-parsed VT lines taking precedence over {@link parseOutput}. */
  readonly lines?: readonly (readonly VtRun[])[];
  readonly className?: string;
}

function defaultParseLines(text: string): readonly (readonly VtRun[])[] {
  return text.split("\n").map((line) => [{ text: line, style: {} }]);
}

/** Collapsible terminal command and VT output disclosure block. */
export function TerminalBlock({
  command,
  directory,
  output,
  exitCode,
  outcome = "ok",
  expanded = false,
  parseOutput,
  lines: explicitLines,
  className,
}: TerminalBlockProps) {
  const script = detectInlineScript(command);
  const exit = exitCode !== undefined && exitCode !== 0 ? exitCode : undefined;
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
    <Disclosure
      className={cn("shell-term", className)}
      data-outcome={failed ? "failed" : outcome}
      isExpanded={open}
      onExpandedChange={(value) => {
        pinned.current = true;
        setOpen(value);
      }}
    >
      <FieldButton slot="trigger" className="shell-disclosure-trigger">
        <span className="shell-chevron" aria-hidden>
          <IconChevronRight {...glyph} />
        </span>
        <div className="shell-identity">
          {directory === undefined ? null : <p className="shell-cwd">{directory}</p>}
          {script === null ? (
            <div className="shell-cmd">
              <span className="shell-sigil">$</span>
              {command === "" ? null : <CodeBlock lang="bash" plain text={command} />}
            </div>
          ) : (
            <div className="shell-cmd shell-script-name">
              <span className="text-subtle">{script.label}</span>
            </div>
          )}
        </div>
        {exit === undefined ? null : <p className="shell-exit">exit code {exit}</p>}
      </FieldButton>
      <TranscriptDisclosurePanel className="shell-disclosure-panel">
        {script === null || script.source === "" ? null : (
          <div className="shell-script">
            <CodeBlock lang={script.lang} plain text={script.source} />
          </div>
        )}
        {output === "" && explicitLines === undefined ? null : (
          <TerminalOutput live={live} lines={explicitLines} parseOutput={parseOutput} text={output} />
        )}
      </TranscriptDisclosurePanel>
    </Disclosure>
  );
}

function TerminalOutput({
  text,
  live,
  parseOutput,
  lines: explicitLines,
}: {
  readonly text: string;
  readonly live: boolean;
  readonly parseOutput?: (text: string) => Iterable<readonly VtRun[]>;
  readonly lines?: readonly (readonly VtRun[])[];
}) {
  const lines = useMemo(
    () => (explicitLines !== undefined ? [...explicitLines] : outputLines(text, parseOutput)),
    [explicitLines, parseOutput, text],
  );
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

function outputLines(
  text: string,
  parseOutput?: (text: string) => Iterable<readonly VtRun[]>,
): readonly (readonly VtRun[])[] {
  const lines = [...(parseOutput ? parseOutput(text) : defaultParseLines(text))];
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
