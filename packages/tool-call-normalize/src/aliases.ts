/** Longcat-scoped name map — applied only when dialect is longcat (or caller passes). */
export const LONGCAT_NAME_ALIASES: Record<string, string> = {
  writefile: "write_file",
  write_file: "write_file",
  writeFile: "write_file",
  "write-file": "write_file",
  readfile: "read_file",
  read_file: "read_file",
  readFile: "read_file",
  "read-file": "read_file",
  editfile: "edit_file",
  edit_file: "edit_file",
  editFile: "edit_file",
  "edit-file": "edit_file",
  runterminal: "run_terminal",
  run_terminal: "run_terminal",
  runTerminal: "run_terminal",
  "run-terminal": "run_terminal",
  bash: "run_terminal",
  shell: "run_terminal",
  exec: "run_terminal",
};

export const LONGCAT_ARG_ALIASES: Record<string, Record<string, string>> = {
  "*": {
    file_path: "path",
    text: "content",
    cmd: "command",
  },
};
