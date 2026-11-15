import { ProjectTabMenu, ProjectTabsBlock, glyph, type ProjectTabItem } from "@inhuman.tools/harness-ui";
import { IconFolder, IconLayoutGrid, IconRobot } from "@tabler/icons-react";
import { observer } from "mobx-react-lite";

import { projectPulse, rowLight } from "./light.js";
import { projectHref, projectNames, sessionHref, type RouteTarget } from "./path.js";
import { useDial } from "../client/context.js";

export type RailPane =
  { readonly kind: "overview" } | { readonly kind: "project"; readonly path: string } | { readonly kind: "bots" };

export function railPane(target: RouteTarget, botIds: ReadonlySet<string>, browsingBots: boolean): RailPane {
  if (browsingBots || target.kind === "session") return { kind: "bots" };
  if (target.kind === "project") return { kind: "project", path: target.path };
  if (target.kind === "project-session") {
    if (botIds.has(target.sessionId)) return { kind: "bots" };
    return { kind: "project", path: target.path };
  }
  return { kind: "overview" };
}

export function botIdsOf(
  kernel: {
    readonly root: {
      readonly botsRoster: Record<string, string>;
      readonly projects: Record<string, string>;
    };
  },
  projects: ReadonlyMap<string, { readonly root: { readonly botsRoster: Record<string, string> } }>,
): Set<string> {
  const ids = new Set<string>(Object.values(kernel.root.botsRoster));
  for (const path of Object.keys(kernel.root.projects)) {
    const roster = projects.get(path)?.root.botsRoster;
    if (roster == null) continue;
    for (const id of Object.values(roster)) ids.add(id);
  }
  return ids;
}

/** Thin MobX adapter projecting open projects and live status pulses into ProjectTabsBlock. */
export const ProjectTabs = observer(function ProjectTabsView({
  projectSessions,
  go,
  pane,
  onBrowseBots,
  onAdd,
  adding,
  onMint,
}: {
  readonly projectSessions?: ReadonlyMap<string, string>;
  readonly go: (href: string) => void;
  readonly pane: RailPane;
  readonly onBrowseBots: () => void;
  readonly onAdd?: () => void;
  readonly adding?: boolean;
  readonly onMint: (path: string) => void;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  const known = Object.keys(kernel?.root.projects ?? {});
  const paths = pane.kind === "project" && !known.includes(pane.path) ? [...known, pane.path] : known;
  const names = projectNames(paths);
  const activeKey = pane.kind === "project" ? pane.path : pane.kind;
  const showBots =
    pane.kind === "bots" ||
    Object.keys(kernel?.root.botsRoster ?? {}).length > 0 ||
    paths.some((path) => Object.keys(dial.projects.get(path)?.root.botsRoster ?? {}).length > 0);

  const projectTabs: ProjectTabItem[] = paths.map((path) => {
    const name = names.get(path) ?? path;
    const active = pane.kind === "project" && pane.path === path;
    const sessionId = projectSessions?.get(path);
    const held = dial.projects.get(path) ?? (dial.project?.root.path === path ? dial.project : null);
    const ids = held == null || kernel == null ? [] : Object.keys(held.root.sessions);
    const pulse = projectPulse(
      ids.map((id) =>
        rowLight(dial.session?.root.sessionId === id ? dial.session.root : null, kernel?.root.sessions[id]),
      ),
    );
    const waiting = ids.filter(
      (id) =>
        rowLight(dial.session?.root.sessionId === id ? dial.session.root : null, kernel?.root.sessions[id]) ===
        "waiting-for-you",
    ).length;

    return {
      key: path,
      kind: "project",
      active,
      href:
        sessionId != null && held?.root.sessions[sessionId] != null ? sessionHref(path, sessionId) : projectHref(path),
      icon: <IconFolder {...glyph} aria-hidden />,
      label: name,
      title: path,
      status:
        waiting > 0 ? (
          <span className="tabular-nums text-warning">{waiting}</span>
        ) : pulse === "running" ? (
          <span role="img" aria-label="running" className="inline-block size-2 shrink-0 rounded-xs bg-success" />
        ) : null,
      menu: active ? (
        <ProjectTabMenu path={path} name={name} newSessionLabel="New session" onMint={() => onMint(path)} />
      ) : null,
    };
  });

  const tabs: ProjectTabItem[] = [
    {
      key: "overview",
      kind: "overview",
      active: pane.kind === "overview",
      href: "/",
      icon: <IconLayoutGrid {...glyph} aria-hidden />,
      label: "Overview",
    },
    ...projectTabs,
    ...(showBots
      ? [
          {
            key: "bots",
            kind: "bots" as const,
            active: pane.kind === "bots",
            icon: <IconRobot {...glyph} aria-hidden />,
            label: "Bots",
            onSelect: onBrowseBots,
          },
        ]
      : []),
  ];

  return (
    <ProjectTabsBlock
      activeKey={activeKey}
      tabs={tabs}
      onNavigate={go}
      onAdd={onAdd}
      addLabel="Add"
      adding={adding}
      listLabel="Projects"
    />
  );
});
