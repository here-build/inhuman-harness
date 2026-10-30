/**
 * Glance `scope !== ""` and `oneShot` are not conversation resume targets —
 * listing them attaches workers.
 */
export type ResumeOverview = {
  readonly title?: string;
  readonly lastMessageAt?: number;
  readonly recipeScope?: string;
  readonly oneShot?: boolean;
};

export type ResumeCompletion = {
  readonly id: string;
  readonly title: string;
  readonly lastMessageAt: number;
  readonly occupied: boolean;
};

export function listResumeCompletions(args: {
  readonly sessions: Record<string, ResumeOverview | undefined>;
  readonly occupied: ReadonlySet<string>;
  readonly prefix?: string;
}): ResumeCompletion[] {
  const needle = (args.prefix ?? "").trim().toLowerCase();
  const rows: ResumeCompletion[] = [];
  for (const [id, glance] of Object.entries(args.sessions)) {
    if (glance == null || id.trim() === "") continue;
    if ((glance.recipeScope ?? "") !== "" || glance.oneShot === true) continue;
    const title = glance.title?.trim() ?? "";
    if (needle !== "" && !id.toLowerCase().includes(needle) && !title.toLowerCase().includes(needle)) {
      continue;
    }
    rows.push({
      id,
      title,
      lastMessageAt: glance.lastMessageAt ?? 0,
      occupied: args.occupied.has(id),
    });
  }
  rows.sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.id.localeCompare(b.id));
  return rows;
}

/** `id<TAB>title · used|orphaned`. Description has no tab/colon (zsh `_describe`). */
export function formatResumeCompletion(row: ResumeCompletion): string {
  const label = sanitize(row.title === "" ? row.id : row.title);
  const scent = row.occupied ? "used" : "orphaned";
  return `${row.id}\t${label} · ${scent}`;
}

function sanitize(text: string): string {
  return text
    .replaceAll(/[\t\n\r]/g, " ")
    .replaceAll(":", " ")
    .trim();
}
