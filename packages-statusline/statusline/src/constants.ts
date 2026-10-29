/** `config.json` `statusline`: this built-in git view, "" for cwd-only, or a shell command. */
export const DEFAULT_STATUSLINE = "git";
/**
 * Splits a built-in statusline left slot into the branch and the quiet
 * clause. Absent from shell commands. U+001F cannot appear in a ref name.
 */
export const STATUSLINE_NOTE_SEP = "\u001f";

/** Swaps the note separator for a printable one, for hosts that paint one plain string. */
export function formatPlain(line: string, sep = " · "): string {
  return line.split(STATUSLINE_NOTE_SEP).join(sep);
}

/** The quiet clause alone, for hosts that already paint the branch. "" on a clean, level branch. */
export function statusNote(line: string): string {
  const cut = line.indexOf(STATUSLINE_NOTE_SEP);
  return cut === -1 ? "" : line.slice(cut + STATUSLINE_NOTE_SEP.length);
}
