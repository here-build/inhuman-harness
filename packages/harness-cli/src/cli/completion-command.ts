/**
 * Shell completion for `--resume` / `--session`. Live kernel only — never `ensure()`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { occupiedSessionIds } from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { Command, Option } from "clipanion";
import { makeValidator } from "typanion";

import { KernelCommand, type ShellContext } from "./context.js";
import { formatResumeCompletion, listResumeCompletions } from "./resume-complete.js";

/** Tab-complete must not wait sdk defaults or hang the shell. */
const COMPLETE_SYNC_MS = 400;
const COMPLETE_AWARENESS_MS = 200;

const isShell = makeValidator({
  test: (value, state): value is "zsh" | "bash" | "fish" => {
    if (value === "zsh" || value === "bash" || value === "fish") return true;
    state?.errors?.push(`Expected one of "zsh", "bash", or "fish" (got ${JSON.stringify(value)})`);
    return false;
  },
});

export class CompletionCommand extends Command<ShellContext> {
  static paths = [["completion"]];
  static usage = Command.Usage({
    description: "print a shell completion script",
    details:
      'Eval from the shell rc: `eval "$(harness completion zsh)"`. Completing `--resume` does not start the daemon.',
    examples: [
      ["zsh", 'eval "$(harness completion zsh)"'],
      ["bash", 'eval "$(harness completion bash)"'],
      ["fish", "harness completion fish | source"],
    ],
  });

  shell = Option.String({ required: true, validator: isShell, name: "shell" });

  async execute(): Promise<number> {
    this.context.stdout.write(scriptFor(this.shell));
    return 0;
  }
}

export class CompleteCommand extends KernelCommand {
  static paths = [["complete"]];
  static usage = Command.Usage({
    description: "print --resume candidates (id<TAB>title · used|orphaned)",
  });

  query = Option.String({ required: false, name: "query" });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("harness complete");
    if (blocked !== undefined) return blocked;
    const kernel = this.kernelPath();
    const socket = join(kernel, "daemon.sock");
    if (!existsSync(socket)) return 0;
    try {
      await using handle = await Client.kernel(kernel, {
        reconnect: false,
        syncTimeoutMs: COMPLETE_SYNC_MS,
        awarenessWaitMs: COMPLETE_AWARENESS_MS,
      });
      const sessions: Record<string, { title: string; lastMessageAt: number }> = {};
      for (const [id, glance] of Object.entries(handle.plexus.root.sessions)) {
        if (glance == null) continue;
        sessions[id] = { title: glance.title, lastMessageAt: glance.lastMessageAt ?? 0 };
      }
      const rows = listResumeCompletions({
        sessions,
        occupied: occupiedSessionIds(handle.plexus.awareness),
        prefix: this.query,
      });
      for (const row of rows) this.context.stdout.write(`${formatResumeCompletion(row)}\n`);
      return 0;
    } catch {
      return 0;
    }
  }
}

function scriptFor(shell: "zsh" | "bash" | "fish"): string {
  if (shell === "zsh") {
    return `#compdef harness
_harness_sessions() {
  local -a sessions
  local id desc
  while IFS=$'\\t' read -r id desc; do
    [[ -n $id ]] || continue
    sessions+=("\${id}:\${desc}")
  done < <(harness complete -- "\${words[CURRENT]}" 2>/dev/null)
  _describe -t sessions 'session' sessions
}
_harness() {
  if [[ \${words[CURRENT-1]} == --resume || \${words[CURRENT-1]} == --session ]]; then
    _harness_sessions
    return
  fi
  _arguments \\
    '--kernel[system folder]:path:_directories' \\
    '--resume[session id]:session:_harness_sessions' \\
    '--session[session id]:session:_harness_sessions' \\
    '--connection[completion connection id]:connection:' \\
    '--model[model id]:model:' \\
    '(--continue -c)'{--continue,-c}'[restore this tab last session]' \\
    '--restart-daemon[stop a live daemon before attach]' \\
    '1:command:(mcp daemon eval completion complete help)'
}
compdef _harness harness
`;
  }
  if (shell === "bash") {
    return `_harness() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ $prev == --resume || $prev == --session ]]; then
    local ids
    ids=$(harness complete -- "$cur" 2>/dev/null | cut -f1)
    COMPREPLY=($(compgen -W "$ids" -- "$cur"))
    return
  fi
  COMPREPLY=($(compgen -W "mcp daemon eval completion complete help --resume --session --continue --connection --model --kernel --restart-daemon" -- "$cur"))
}
complete -F _harness harness
`;
  }
  return `complete -c harness -l resume -r -f -a '(harness complete -- (commandline -ct) 2>/dev/null)'
complete -c harness -l session -r -f -a '(harness complete -- (commandline -ct) 2>/dev/null)'
complete -c harness -l continue -s c
complete -c harness -l connection -r
complete -c harness -l model -r
complete -c harness -l kernel -r
complete -c harness -l restart-daemon
complete -c harness -n '__fish_use_subcommand' -a 'mcp daemon eval completion complete help'
`;
}
