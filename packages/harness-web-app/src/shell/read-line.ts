import { workspacePath } from "@inhuman.tools/harness-model/session";

/**
 * In-project paths stay relative. Anything `workspacePath` leaves absolute
 * (it starts with `/` or climbs with `..`) is shown absolute.
 */
export function displayPath(projectPath: string, raw: string): string {
  const shown = workspacePath(projectPath, raw);
  if (shown.startsWith("/") || shown.split("/").includes("..")) return shown;
  return shown;
}

export type ReadPart =
  { readonly kind: "path"; readonly label: string } | { readonly kind: "text"; readonly text: string };

/** Locale list parts. One path is just that path; conjunctions stay literal text. */
export function readListParts(labels: readonly string[], locales: readonly string[] | undefined): readonly ReadPart[] {
  if (labels.length === 0) return [];
  const format = new Intl.ListFormat(locales, { type: "conjunction", style: "long" });
  const parts = format.formatToParts(labels.map((label) => label));
  return parts.map((part) =>
    part.type === "element" ? { kind: "path", label: part.value } : { kind: "text", text: part.value },
  );
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const BINARY_EXT = new Set([
  "7z",
  "a",
  "aac",
  "bin",
  "bz2",
  "class",
  "dat",
  "db",
  "dll",
  "dylib",
  "eot",
  "exe",
  "flac",
  "gz",
  "jar",
  "m4a",
  "m4v",
  "mov",
  "mp3",
  "mp4",
  "node",
  "npy",
  "o",
  "ogg",
  "ogv",
  "opus",
  "otf",
  "parquet",
  "pkl",
  "pyc",
  "pyo",
  "rar",
  "so",
  "sqlite",
  "tar",
  "tgz",
  "ttf",
  "war",
  "wasm",
  "wav",
  "webm",
  "woff",
  "woff2",
  "xz",
  "zip",
]);

export type FileFace = "text" | "image" | "pdf" | "binary";

export function fileFace(path: string): FileFace {
  const ext = extensionOf(path);
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  if (BINARY_EXT.has(ext)) return "binary";
  return "text";
}

/** NUL in the first 8KiB. UTF-8 source never has one; archives and images do. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function extensionOf(path: string): string {
  const base = path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
}
