export function asAdoptString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
