import type { CalibratedServer } from "./types.js";

/** Dist toolkit — same names/args as harness-server dist-tools + shell. */
export const TOOLKIT: CalibratedServer = {
  id: "harness-toolkit",
  displayName: "Harness dist toolkit",
  source: "toolkit",
  description: "Always-available filesystem tools plus shell, web_search, web_extract, scheme_repl, and task tools.",
  tools: [
    {
      name: "read_file",
      description: "Read a UTF-8 text file under the project root.",
      args: [
        { name: "path", type: "string", required: true, description: "File path, relative to the project root." },
        { name: "offset", type: "integer", required: false, description: "First line to return, 1-based." },
        { name: "limit", type: "integer", required: false, description: "How many lines to return from offset." },
      ],
    },
    {
      name: "list_dir",
      description: "List the entries of a directory under the project root. Directories end with '/'.",
      args: [
        {
          name: "path",
          type: "string",
          required: true,
          description: "Directory path, relative to the project root. Use '.' for the root.",
        },
        { name: "depth", type: "integer", required: false, description: "How many levels to descend. Defaults to 1." },
      ],
    },
    {
      name: "grep",
      description:
        "Search file contents under the project root (indexed). mode is plain (literal, default), regex, or fuzzy.",
      args: [
        {
          name: "pattern",
          type: "string",
          required: true,
          description: "Text, regex, or fuzzy query depending on mode.",
        },
        {
          name: "path",
          type: "string",
          required: false,
          description: "Directory or file to search. Defaults to the project root.",
        },
        { name: "glob", type: "string", required: false, description: "Only search paths matching this glob." },
      ],
    },
    {
      name: "glob",
      description: "Find files under the project root whose paths match a glob pattern.",
      args: [
        { name: "pattern", type: "string", required: true, description: "Glob, e.g. '**/*.ts'." },
        {
          name: "cwd",
          type: "string",
          required: false,
          description: "Directory to search, relative to the project root. Defaults to the project root.",
        },
      ],
    },
    {
      name: "fff_search",
      description: "Fuzzy file search under the project root (typo-resistant, frecency-ranked).",
      args: [
        { name: "query", type: "string", required: true, description: "Filename or path fragments." },
        {
          name: "cwd",
          type: "string",
          required: false,
          description: "Directory to search, relative to the project root. Defaults to the project root.",
        },
      ],
    },
    {
      name: "write_file",
      description:
        "Create a file under the project root, or replace one entirely. Replacing an existing file requires overwriteExisting. Requires the user's confirmation.",
      args: [
        { name: "path", type: "string", required: true, description: "File path, relative to the project root." },
        { name: "content", type: "string", required: true, description: "The file's complete new contents." },
        {
          name: "overwriteExisting",
          type: "boolean",
          required: false,
          description: "Set true to replace an existing file.",
        },
        {
          name: "description",
          type: "string",
          required: false,
          description: "Optional one-line summary of what this write does.",
        },
      ],
    },
    {
      name: "edit_file",
      description: "Replace an exact stretch of text in an existing file. Requires the user's confirmation.",
      args: [
        { name: "path", type: "string", required: true, description: "File path, relative to the project root." },
        { name: "old_string", type: "string", required: true, description: "The exact text to replace." },
        { name: "new_string", type: "string", required: true, description: "The replacement text." },
        { name: "replace_all", type: "boolean", required: false, description: "Replace every occurrence." },
        {
          name: "description",
          type: "string",
          required: false,
          description: "Optional one-line summary of what this edit does.",
        },
      ],
    },
    {
      name: "shell",
      description:
        "Run a command in the project workspace through /bin/sh. Requires confirmation, separately from file writes.",
      args: [
        { name: "command", type: "string", required: true, description: "The shell command to run." },
        {
          name: "cwd",
          type: "string",
          required: false,
          description: "Working directory, relative to the project root.",
        },
        {
          name: "timeoutMs",
          type: "integer",
          required: false,
          description: "Optional per-call timeout in milliseconds.",
        },
        {
          name: "description",
          type: "string",
          required: false,
          description: "Optional one-line summary of what this command does.",
        },
      ],
    },
    {
      name: "scheme_repl",
      description: "Evaluate a Scheme expression. Inner tool calls use the normal tool execution and approval flow.",
      args: [
        { name: "expr", type: "string", required: true, description: "Scheme expression." },
        {
          name: "period",
          type: "string",
          required: false,
          description:
            'Repeat interval: "N minutes", "N hours", or "N days". Omit to run once. expr must call (meta-reactivity/done-condition pred [result]) on a reachable path. Each iteration has no inner-call or time limit unless maxInternalCalls or timeoutMs is set; idle time between iterations does not count.',
        },
        {
          name: "background",
          type: "boolean",
          required: false,
          description:
            "If true, return without waiting for the program to finish; deliver its result later as a notification.",
        },
        {
          name: "timeoutMs",
          type: "integer",
          required: false,
          description: "Optional per-tick timeout in milliseconds. Omit for no time limit.",
        },
        {
          name: "maxInternalCalls",
          type: "integer",
          required: false,
          description: "Optional inner tool-call budget. Omit for no limit.",
        },
        {
          name: "description",
          type: "string",
          required: false,
          description: "Optional one-line summary of what this expression does.",
        },
      ],
    },
    {
      name: "web_search",
      description: "Search the public web. Returns ranked titles, URLs, and snippets.",
      args: [
        { name: "query", type: "string", required: true, description: "Search query." },
        {
          name: "numResults",
          type: "integer",
          required: false,
          description: "How many hits to return. Defaults to 5.",
        },
      ],
    },
    {
      name: "web_extract",
      description: "Fetch a public URL and return readable markdown. Use after web_search when you have a URL.",
      args: [
        { name: "url", type: "string", required: true, description: "HTTP or HTTPS URL to read." },
        {
          name: "charLimit",
          type: "integer",
          required: false,
          description: "Maximum markdown characters to return. Defaults to 15000.",
        },
      ],
    },
    {
      name: "task__create",
      description:
        "Create a pending task with a saved Scheme validation program. Choose a unique taskId; the tool returns that ID. Creation captures the program without running its checks. When the work is ready, call task__start and then task__validate with that ID. The saved program cannot be replaced; drop the task and create a new ID if its checks need correction.",
      args: [
        {
          name: "subject",
          type: "string",
          required: true,
          description: "Short task title.",
        },
        {
          name: "description",
          type: "string",
          required: true,
          description: "Task requirements and scope; the validation program must check these requirements.",
        },
        {
          name: "activeForm",
          type: "string",
          required: false,
          description: "Progress label displayed while this task is active.",
        },
        {
          name: "activationBrief",
          type: "string",
          required: false,
          description: "Instructions to follow when this task becomes active.",
        },
        {
          name: "validationProgram",
          type: "string",
          required: true,
          description:
            'Scheme source text, saved now and evaluated later by task__validate in a fresh scope. Use Scheme calls such as (read_file "path") for file text, (equal? actual expected) for comparison, and (tasks/write-completion-verdict ok "evidence") for the final verdict. Available project ports: read_file, list_dir, grep, glob, fff_search, shell. Paths resolve from the project root. Adapt this example to the task\'s actual requirements: (tasks/write-completion-verdict (equal? (read_file "status.txt") "ready") "status.txt must contain exactly ready"). The outer argument is a JSON string; its contents use Scheme syntax. Returning #t alone does not record a verdict.',
        },
        {
          name: "taskId",
          type: "string",
          required: true,
          description:
            "A nonempty unique ID you choose, such as remove-picker. Reuse this ID with task__start, task__validate, task__after, and task__drop.",
        },
      ],
    },
    {
      name: "task__start",
      description:
        "Make a pending task active before working on it or calling task__validate. Returns its subject and activationBrief. Only one task is active at a time; starting another returns the previous task to pending. Starting the active task changes nothing.",
      args: [
        {
          name: "taskId",
          type: "string",
          required: true,
          description: "ID of an existing pending or active task.",
        },
      ],
    },
    {
      name: "task__drop",
      description:
        "Abandon an unfinished task and save the reason. Use this when its scope or saved Scheme validation program needs replacement, then task__create with a new ID. Completed tasks cannot be dropped; dropping an already-dropped task changes nothing. Returns false as an acknowledgement on success.",
      args: [
        {
          name: "taskId",
          type: "string",
          required: true,
          description: "ID of the unfinished task to drop.",
        },
        {
          name: "reason",
          type: "string",
          required: true,
          description: "Why this task is being abandoned or replaced; saved with the task.",
        },
      ],
    },
    {
      name: "task__after",
      description:
        "Record that taskId depends on the task named by after. Both tasks must already exist. This records the prerequisite for planning; it does not start tasks or block task__start. Returns false as an acknowledgement on success.",
      args: [
        {
          name: "taskId",
          type: "string",
          required: true,
          description: "ID of the dependent task.",
        },
        {
          name: "after",
          type: "string",
          required: true,
          description: "ID of its prerequisite task.",
        },
      ],
    },
    {
      name: "task__validate",
      description:
        "Run the active task's saved Scheme validation program against current project state. Call task__start first. The program must finish with (tasks/write-completion-verdict ok comments); the tool returns that boolean/string pair. A true verdict completes the task; a false verdict returns it to pending so you can fix the work, start it, and validate again. To correct the saved program itself, drop the task and create a new ID.",
      args: [
        {
          name: "taskId",
          type: "string",
          required: true,
          description: "ID of the active task whose saved Scheme program should run.",
        },
      ],
    },
  ],
};
