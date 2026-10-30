/** `ALLOWED_EMAILS` is comma-separated and case-insensitive. Empty means nobody. */
export function isAllowedEmail(email: string | undefined, allowed: string): boolean {
  if (!email) return false;
  const want = email.trim().toLowerCase();
  return allowed
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .some((e) => e !== "" && e === want);
}
