import { useEffect, useState, type CSSProperties } from "react";

import { highlightLines, type HighlightLine, type TokenRun } from "./highlight.js";
import { guessLang } from "./lang.js";
import { useScheme } from "./scheme.js";

export function CodeView({
  text,
  lang,
  guess = false,
  plain = false,
}: {
  readonly text: string;
  readonly lang: string;
  readonly guess?: boolean;
  /** No code card. The shell prompt paints the command on the terminal surface. */
  readonly plain?: boolean;
}) {
  const scheme = useScheme();
  const resolved = guess && (lang === "" || lang === "text") ? (guessLang(text) ?? "text") : lang;
  const [paint, setPaint] = useState<{
    text: string;
    lang: string;
    scheme: typeof scheme;
    lines: HighlightLine[];
  } | null>(null);
  useEffect(() => {
    let live = true;
    void highlightLines(text, resolved, scheme).then(
      (lines) => {
        if (live && lines !== null) setPaint({ text, lang: resolved, scheme, lines });
        return undefined;
      },
      () => {
        if (live) setPaint(null);
      },
    );
    return () => {
      live = false;
    };
  }, [resolved, scheme, text]);
  const current = paint?.text === text && paint.lang === resolved && paint.scheme === scheme ? paint.lines : null;
  const code = (
    <pre className="mono">
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
  return <div className="code-scroll">{code}</div>;
}

function runStyle(run: TokenRun): CSSProperties | undefined {
  if (run.color === undefined && run.bold !== true && run.italic !== true) return undefined;
  const style: CSSProperties = {};
  if (run.color !== undefined) style.color = run.color;
  if (run.bold === true) style.fontWeight = 700;
  if (run.italic === true) style.fontStyle = "italic";
  return style;
}
