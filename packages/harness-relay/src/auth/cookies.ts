export function getCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

// Secure everywhere except plain-http localhost, where Safari would drop it.
function secure(url: URL): boolean {
  return !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
}

export function setCookie(
  url: URL,
  name: string,
  value: string,
  opts: { path?: string; maxAge?: number } = {},
): string {
  return [
    `${name}=${value}`,
    `Path=${opts.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
    secure(url) ? "Secure" : "",
    `Max-Age=${opts.maxAge ?? 60 * 60 * 24 * 30}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCookie(url: URL, name: string, path = "/"): string {
  return setCookie(url, name, "", { path, maxAge: 0 });
}
