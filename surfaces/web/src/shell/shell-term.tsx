import { parseVtLines } from "@inhuman.tools/harness-model/vt-text";
import type { ToolBody, ToolOutcome } from "@inhuman.tools/harness-transcript/tool-receipt";
import { TerminalBlock } from "@inhuman.tools/harness-ui/blocks/terminal-block";

/** Domain shell adapter binding VT ANSI parsing from harness-model to {@link TerminalBlock}. */
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
  return (
    <TerminalBlock
      command={body.command}
      {...(body.directory === undefined ? {} : { directory: body.directory })}
      output={body.output}
      {...(body.exitCode === undefined ? {} : { exitCode: body.exitCode })}
      outcome={outcome}
      expanded={expanded}
      parseOutput={parseVtLines}
    />
  );
}
