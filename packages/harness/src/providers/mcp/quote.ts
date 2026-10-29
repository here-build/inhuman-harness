/** Scheme string literal for parked UI. Same quoting as the connection adopt host. */
export function schemeQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;
}

export function asAdoptString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
