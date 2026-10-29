// Shell embed detection stays in quickdraw so the web paint and the JS tape share one scanner.
/* eslint-disable import-x/no-relative-packages */
export {
  detectShellEmbeds,
  guessLang,
  spliceEmbeds,
} from "../../../quickdraw/src/widgets/internals/embedded-syntax.js";
/* eslint-enable import-x/no-relative-packages */

const ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  tsx: "tsx",
  scheme: "scm",
  arrival: "scm",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  htm: "html",
  plaintext: "text",
  txt: "text",
  text: "text",
};

const EXT: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  scm: "scm",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ex: "elixir",
  exs: "elixir",
  xml: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  lua: "lua",
  zig: "zig",
  swift: "swift",
  scala: "scala",
  r: "r",
  pl: "perl",
  ps1: "powershell",
  proto: "proto",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  tf: "hcl",
  hcl: "hcl",
  nix: "nix",
  dart: "dart",
  hs: "haskell",
  erl: "erlang",
  clj: "clojure",
  jl: "julia",
};

/** Shiki language id. `text` means leave the source uncolored. */
export function resolveLang(lang: string): string {
  const name = lang.trim().toLowerCase();
  if (name === "") return "text";
  return ALIASES[name] ?? name;
}

/** Grammar for a file path. Extension wins. `dockerfile` / `makefile` have no extension. */
export function langFromPath(path: string): string | undefined {
  const base = path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "docker";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXT[base.slice(dot + 1)];
}
