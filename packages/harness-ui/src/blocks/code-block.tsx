import { useEffect, useState, type CSSProperties } from "react";

import { resolveLang } from "./lang.js";
import { MAX_HIGHLIGHT_CHARS, useScheme, useSyntaxHighlighter, type HighlightLine, type TokenRun } from "./syntax.js";
import { cn } from "../lib/cn.js";

export interface CodeBlockProps {
  readonly text: string;
  readonly lang: string;
  readonly guess?: boolean;
  /** When true, skips the scrollable code card wrapper (used inside terminal commands). */
  readonly plain?: boolean;
  readonly className?: string;
}

/** Displays source code with optional async syntax highlighting from {@link SyntaxHighlightProvider}. */
export function CodeBlock({ text, lang, guess = false, plain = false, className }: CodeBlockProps) {
  const scheme = useScheme();
  const highlighter = useSyntaxHighlighter();
  const [paint, setPaint] = useState<{
    text: string;
    lang: string;
    guess: boolean;
    scheme: typeof scheme;
    lines: HighlightLine[];
  } | null>(null);

  useEffect(() => {
    const resolved = resolveLang(lang);
    if ((!guess && resolved === "text") || text.length === 0 || text.length > MAX_HIGHLIGHT_CHARS) {
      setPaint(null);
      return;
    }
    let live = true;
    void highlighter.highlightLines(text, resolved, scheme, guess).then(
      (lines) => {
        if (live && lines !== null) setPaint({ text, lang, guess, scheme, lines });
        return undefined;
      },
      () => {
        if (live) setPaint(null);
      },
    );
    return () => {
      live = false;
    };
  }, [guess, highlighter, lang, scheme, text]);

  const current =
    paint?.text === text && paint.lang === lang && paint.guess === guess && paint.scheme === scheme
      ? paint.lines
      : null;

  const code = (
    <pre className={plain ? cn("mono", className) : "mono"}>
      <code>
        {current === null
          ? text
          : current.map((line, index) => (
              <span className="code-line" key={index}>
                {line.map((run, runIndex) => (
                  <span key={runIndex} style={runStyle(run)}>
                    {run.text}
                  </span>
                ))}
              </span>
            ))}
      </code>
    </pre>
  );

  if (plain) return code;
  return <div className={cn("code-scroll", className)}>{code}</div>;
}

/** Alias kept for reference shell compatibility. */
export const CodeView = CodeBlock;

function runStyle(run: TokenRun): CSSProperties | undefined {
  if (run.color === undefined && run.bold !== true && run.italic !== true) return undefined;
  const style: CSSProperties = {};
  if (run.color !== undefined) style.color = run.color;
  if (run.bold === true) style.fontWeight = 700;
  if (run.italic === true) style.fontStyle = "italic";
  return style;
}
