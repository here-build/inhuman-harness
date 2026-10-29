const ESCAPES = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/** Shell output without VT sequences; a carriage return keeps only what was written last on that line. */
export function plainTerminal(text: string): string {
  return text
    .replaceAll(ESCAPES, "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => (line.includes("\r") ? (line.split("\r").findLast((part) => part !== "") ?? "") : line))
    .join("\n");
}
