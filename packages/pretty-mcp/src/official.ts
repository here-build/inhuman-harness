import type { CalibratedServer, CalibratedTool, ToolArg } from "./types.js";

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function playwrightBlock(text: string, name: string): string {
  const header = `- **${name}**`;
  const start = text.indexOf(header);
  if (start === -1) return "";
  const rest = text.slice(start + header.length);
  const next = rest.search(/^- \*\*browser_[a-z0-9_]+\*\*/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function parsePlaywrightArgs(block: string): ToolArg[] {
  if (/Parameters: None\s*$/m.test(block)) return [];
  const list = block.match(/- Parameters:\n((?: {4}- .+\n)*)/);
  const args: ToolArg[] = [];
  for (const line of (list?.[1] ?? "").split("\n")) {
    const pm = line.match(/^ {4}- `([^`]+)` \(([^)]+)\): (.+)/);
    if (pm === null) continue;
    const typRaw = pm[2];
    args.push({
      name: pm[1],
      type: typRaw.replaceAll(", optional", "").trim(),
      required: !typRaw.includes("optional"),
      description: pm[3],
    });
  }
  return args;
}

export function parsePlaywrightReadme(text: string): CalibratedServer | undefined {
  const names = [...text.matchAll(/^- \*\*(browser_[a-z0-9_]+)\*\*/gm)].map((m) => m[1]!);
  if (names.length === 0) return undefined;
  const tools: CalibratedTool[] = names.map((name) => {
    const block = playwrightBlock(text, name);
    const descMatch = block.match(/- Description: (.+)/);
    return { name, description: descMatch?.[1]?.trim() ?? "", args: parsePlaywrightArgs(block) };
  });
  return {
    id: "playwright",
    displayName: "Playwright Browser Automation",
    source: "official-docs",
    description: "microsoft/playwright-mcp README tool list.",
    tools,
  };
}

export function parseChromeToolReference(text: string): CalibratedServer | undefined {
  const names = [...text.matchAll(/^ {2}- \[`([a-z0-9_]+)`\]/gm)].map((m) => m[1]!);
  if (names.length === 0) return undefined;
  const tools: CalibratedTool[] = names.map((name) => {
    const desc = text.match(
      // eslint-disable-next-line security/detect-non-literal-regexp -- name escaped
      new RegExp(String.raw`^### \`${escapeRegExp(name)}\`\n\n\*\*Description:\*\* (.+)`, "m"),
    );
    return { name, description: desc?.[1]?.trim() ?? "", args: [] };
  });
  return {
    id: "chrome-devtools",
    displayName: "Chrome DevTools",
    source: "official-docs",
    description: "ChromeDevTools/chrome-devtools-mcp tool-reference.md.",
    tools,
  };
}
