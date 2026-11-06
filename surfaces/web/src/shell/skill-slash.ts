/** Only supplied skills are candidates. This is not a slash-command registry. */
export type SkillSlashRow = {
  readonly name: string;
  readonly invoke?: string;
  readonly description?: string;
  readonly location?: string;
};

export const skillInvoke = (row: SkillSlashRow): string => row.invoke || row.name;

export function skillSlashToken(value: string, start: number, end = start): string | null {
  if (start !== end || start < 1) return null;
  const token = /^\/(\S*)/.exec(value);
  if (token == null || start > token[0].length) return null;
  // Once arguments exist, Enter is the ordinary send action, even if the caret moved back.
  if (value.slice(token[0].length).trim() !== "") return null;
  return token[1] ?? "";
}

export function matchingSkills(rows: readonly SkillSlashRow[], token: string): SkillSlashRow[] {
  const query = token.toLowerCase();
  const seen = new Set<string>();
  return rows.filter((row) => {
    const invoke = skillInvoke(row);
    if (invoke === "" || seen.has(invoke)) return false;
    seen.add(invoke);
    return invoke.toLowerCase().startsWith(query) || row.name.toLowerCase().startsWith(query);
  });
}

export function completeSkillSlash(value: string, row: SkillSlashRow): { value: string; caret: number } {
  const token = /^\/\S*/.exec(value)?.[0] ?? "";
  const remainder = value.slice(token.length);
  const prefix = `/${skillInvoke(row)} `;
  return { value: prefix + (remainder.startsWith(" ") ? remainder.slice(1) : remainder), caret: prefix.length };
}
