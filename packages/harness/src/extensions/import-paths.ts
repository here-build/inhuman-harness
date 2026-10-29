export function isPackageFormSpecifier(specifier: string): boolean {
  if (specifier.length === 0) return false;
  if (specifier.includes("\0") || specifier.includes("\\")) return false;
  if (specifier.startsWith("/") || specifier.startsWith("\\")) return false;
  if (/^[a-z]:[\\/]/i.test(specifier)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return false;
  if (specifier === ".." || specifier.startsWith("../") || specifier.includes("/../") || specifier.endsWith("/..")) {
    return false;
  }
  return true;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageNameOfSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}
