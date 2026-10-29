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
        'Create a task with pending status and return its taskId. The harness manages status; completion requires task__validate, not a completed argument. The validationProgram is saved at creation and cannot be replaced. It must inspect current project state through files, tests, or a :readonly agent/ask using the task requirements, then call (tasks/write-completion-verdict ok comments). Returning #t or (list #t "…") is not a stamp. ;; use one-shot for schema-constrained responses',
      args: [
        { name: "subject", type: "string", required: true, description: "Short task title." },
        { name: "description", type: "string", required: true, description: "Task requirements and scope." },
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
            'Scheme validation program saved at creation and run later by task__validate; it cannot be replaced. Inspect current project state through files, tests, or a :readonly agent/ask using the task requirements, then call (tasks/write-completion-verdict ok comments). Returning #t or (list #t "…") is not a stamp. ;; use one-shot for schema-constrained responses',
        },
      ],
    },
    {
      name: "task__start",
      description:
        "Start a task and return its subject and activationBrief. Only one task can be active; any previously active task returns to pending. Starting an already-active task changes nothing.",
      args: [{ name: "taskId", type: "string", required: true, description: "Task ID returned by task__create." }],
    },
    {
      name: "task__drop",
      description:
        "Drop a task and save the reason. Completed tasks cannot be dropped. Dropping an already-dropped task changes nothing. Returns no value.",
      args: [
        { name: "taskId", type: "string", required: true, description: "Task ID returned by task__create." },
        {
          name: "reason",
          type: "string",
          required: true,
          description: "Reason for dropping this task. Saved with the task.",
        },
      ],
    },
    {
      name: "task__after",
      description:
        "Add a prerequisite: taskId waits until after is completed. Does not start either task. Returns no value.",
      args: [
        {
          name: "taskId",
          type: "string",
          required: true,
          description: "Task ID returned by task__create. This task waits for the prerequisite.",
        },
        {
          name: "after",
          type: "string",
          required: true,
          description: "Prerequisite task ID. The dependent task waits until this task is completed.",
        },
      ],
    },
    {
      name: "task__validate",
      description:
        "Validate the active task using the validationProgram saved at creation; no replacement program is accepted. That program must call (tasks/write-completion-verdict ok comments) after checking current project state. The tool returns that pair, or delivers it later as a notification when background is true.",
      args: [
        {
          name: "taskId",
          type: "string",
          required: true,
          description: "Task ID returned by task__create. This task must be active.",
        },
        {
          name: "background",
          type: "boolean",
          required: false,
          description:
            "If true, return without waiting and deliver the (boolean, string) validation result later as a notification. Defaults to false: wait and return the result directly.",
        },
      ],
    },
  ],
};
