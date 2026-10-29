/**
 * Chip reading of a tool verb. A slash wire verb splits into words, with a
 * known acronym in capitals. A label with no slash is already the chip text.
 */

const ACRONYMS: ReadonlySet<string> = new Set(["mcp"]);

export function verbLabel(label: string): string {
  if (!label.includes("/")) return label;
  return label
    .split("/")
    .filter((part) => part !== "")
    .map((part) => (ACRONYMS.has(part.toLowerCase()) ? part.toUpperCase() : part.toLowerCase()))
    .join(" ");
}
