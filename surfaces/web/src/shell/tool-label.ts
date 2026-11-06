/**
 * The name a tool row shows. The wire name stays on the row's title.
 *
 * `mcp__github__issue_read` is "GitHub · issue read". `scheme_repl` is
 * "Scheme". `task__create` is "Task · create". `read_file` is "read file".
 */
function brand(token: string): string {
  switch (token.toLowerCase()) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "linear":
      return "Linear";
    case "slack":
      return "Slack";
    case "notion":
      return "Notion";
    default:
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  }
}

function words(token: string): string {
  return token.replaceAll("_", " ").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function joined(lead: string, rest: string): string {
  if (lead === "") return rest;
  if (rest === "") return lead;
  return `${lead} · ${rest}`;
}

export function toolLabel(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "";
  if (trimmed.toLowerCase() === "scheme_repl") return "Scheme";
  const parts = trimmed.split("__");
  if (parts.length >= 3 && parts[0].toLowerCase() === "mcp") {
    return joined(brand(parts[1] ?? ""), words(parts.slice(2).join("_")));
  }
  if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") {
    return joined(brand(parts[0]), words(parts[1]));
  }
  return words(trimmed);
}
