/** Wire function-tool row. Vendor wrapping stays here, not in catalog. */
export interface OpenAiTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** Every alias target is a real catalog property (reverse mapping broke tools). */
export const ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "*": {
    file_path: "path",
    filePath: "path",
    target_file: "path",
    filepath: "path",
    file: "path",
    filename: "path",
    dir: "path",
    directory: "path",
  },
  grep: {
    query: "pattern",
    regex: "pattern",
    search: "pattern",
    pattern_string: "pattern",
    include: "glob",
  },
  glob: {
    query: "pattern",
    include: "pattern",
    glob: "pattern",
    path: "cwd",
    dir: "cwd",
    directory: "cwd",
  },
  fff_search: {
    pattern: "query",
    q: "query",
    search: "query",
    path: "cwd",
    dir: "cwd",
    directory: "cwd",
  },
  read_file: {
    start_line: "offset",
    line_offset: "offset",
    num_lines: "limit",
    line_limit: "limit",
  },
  list_dir: {
    max_depth: "depth",
    recursive_depth: "depth",
  },
  write_file: {
    contents: "content",
    text: "content",
    body: "content",
    new_content: "content",
    file_text: "content",
    overwrite_existing: "overwriteExisting",
    overwrite: "overwriteExisting",
  },
  web_search: {
    q: "query",
    search: "query",
    limit: "numResults",
    num_results: "numResults",
    count: "numResults",
  },
  web_extract: {
    uri: "url",
    href: "url",
    link: "url",
    maxChars: "charLimit",
    max_chars: "charLimit",
    char_limit: "charLimit",
  },
  edit_file: {
    old_str: "old_string",
    new_str: "new_string",
    oldText: "old_string",
    newText: "new_string",
    old: "old_string",
    new: "new_string",
    search: "old_string",
    replace: "new_string",
    all: "replace_all",
  },
};
