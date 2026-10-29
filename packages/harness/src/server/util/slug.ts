export function slug(name: string, fallback: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return s.length > 0 ? s : fallback;
}
