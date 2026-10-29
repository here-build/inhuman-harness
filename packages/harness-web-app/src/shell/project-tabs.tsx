import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { IconChevronDown, IconCopy, IconFolder, IconLayoutGrid, IconPlus, IconRobot } from "@tabler/icons-react";
import { observer } from "mobx-react-lite";

import { projectPulse, rowLight } from "./light.js";
import { projectHref, projectNames, type RouteTarget } from "./path.js";
import { useDial } from "../client/context.js";
import { Button } from "../components/ui/button.js";
import { glyph } from "../components/ui/glyph.js";

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

export const ProjectTabs = observer(function ProjectTabsView({
  go,
  pane,
  onBrowseBots,
  onAdd,
  onMint,
}: {
  readonly go: (href: string) => void;
  readonly pane: RailPane;
  readonly onBrowseBots: () => void;
  readonly onAdd: () => void;
  readonly onMint: (path: string) => void;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  const paths = Object.keys(kernel?.root.projects ?? {});
  const names = projectNames(paths);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const activeKey = pane.kind === "project" ? pane.path : pane.kind;
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeKey]);
  const showBots =
    pane.kind === "bots" ||
    Object.keys(kernel?.root.botsRoster ?? {}).length > 0 ||
    paths.some((path) => Object.keys(dial.projects.get(path)?.root.botsRoster ?? {}).length > 0);
  return (
    <div className="flex min-w-0 flex-1">
      <div ref={listRef} className="project-tablist" role="tablist" aria-label="Projects">
        <Tab
          kind="overview"
          active={pane.kind === "overview"}
          href="/"
          go={go}
          icon={<IconLayoutGrid {...glyph} aria-hidden />}
          label="Overview"
          tabRef={pane.kind === "overview" ? activeRef : undefined}
        />
        {paths.map((path) => (
          <ProjectTab
            key={path}
            path={path}
            name={names.get(path) ?? path}
            active={pane.kind === "project" && pane.path === path}
            go={go}
            onMint={onMint}
            tabRef={pane.kind === "project" && pane.path === path ? activeRef : undefined}
          />
        ))}
        {showBots ? (
          <Tab
            kind="bots"
            active={pane.kind === "bots"}
            icon={<IconRobot {...glyph} aria-hidden />}
            label="Bots"
            onSelect={onBrowseBots}
            tabRef={pane.kind === "bots" ? activeRef : undefined}
          />
        ) : null}
      </div>
      <div className="project-add">
        <Button variant="secondary" onClick={onAdd}>
          <IconPlus {...glyph} aria-hidden />
          Add
        </Button>
      </div>
    </div>
  );
});

const ProjectTab = observer(function ProjectTabView({
  path,
  name,
  active,
  go,
  onMint,
  tabRef,
}: {
  readonly path: string;
  readonly name: string;
  readonly active: boolean;
  readonly go: (href: string) => void;
  readonly onMint: (path: string) => void;
  readonly tabRef?: Ref<HTMLDivElement>;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
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
  return (
    <Tab
      kind="project"
      active={active}
      href={projectHref(path)}
      go={go}
      icon={<IconFolder {...glyph} aria-hidden />}
      label={name}
      title={path}
      tabRef={tabRef}
      status={
        waiting > 0 ? (
          <span className="tabular-nums text-warning">{waiting}</span>
        ) : pulse === "running" ? (
          <span role="img" aria-label="running" className="inline-block size-2 shrink-0 rounded-xs bg-success" />
        ) : null
      }
      menu={active ? <ProjectMenu path={path} name={name} onMint={() => onMint(path)} /> : null}
    />
  );
});

function Tab({
  kind,
  active,
  href,
  go,
  icon,
  label,
  title,
  status,
  menu,
  onSelect,
  tabRef,
}: {
  readonly kind: "overview" | "project" | "bots";
  readonly active: boolean;
  readonly href?: string;
  readonly go?: (href: string) => void;
  readonly icon: ReactNode;
  readonly label: string;
  readonly title?: string;
  readonly status?: ReactNode;
  readonly menu?: ReactNode;
  readonly onSelect?: () => void;
  readonly tabRef?: Ref<HTMLDivElement>;
}) {
  const select = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (href != null && go != null) go(href);
  };
  return (
    <div
      ref={tabRef}
      role="tab"
      aria-selected={active}
      className="project-tab touch-target"
      data-tab={kind}
      data-active={active ? "" : undefined}
    >
      {href == null ? (
        <button type="button" className="project-tab-main" aria-label={label} title={title ?? label} onClick={onSelect}>
          {icon}
          <span className="project-tab-label truncate">{label}</span>
          {status}
        </button>
      ) : (
        <a className="project-tab-main" href={href} aria-label={label} title={title ?? label} onClick={select}>
          {icon}
          <span className="project-tab-label truncate">{label}</span>
          {status}
        </a>
      )}
      {menu}
    </div>
  );
}

/**
 * The open project's menu. Anchored popover: the tab strip is a scrollport and
 * the tape paints above it, so an absolute menu was covered and only its shadow showed.
 */
function ProjectMenu({
  path,
  name,
  onMint,
}: {
  readonly path: string;
  readonly name: string;
  readonly onMint: () => void;
}) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const close = (): void => {
    clearTimeout(copiedTimer.current);
    // hidePopover throws when the popover is already closed.
    if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
  };
  const copy = (): void => {
    void navigator.clipboard.writeText(path).then(
      () => {
        setCopied(true);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(close, 600);
        return undefined;
      },
      () => undefined,
    );
  };
  return (
    <div className="project-tab-menu">
      <button type="button" className="project-tab-chevron" popoverTarget={menuId} aria-label={`${name} menu`}>
        <IconChevronDown {...glyph} aria-hidden />
      </button>
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        role="menu"
        className="project-menu"
        aria-label={name}
        onToggle={(event) => {
          if (event.newState !== "closed") return;
          clearTimeout(copiedTimer.current);
          setCopied(false);
        }}
      >
        <button type="button" role="menuitem" className="project-menu-item" onClick={copy}>
          <IconCopy {...glyph} aria-hidden />
          {copied ? "Copied" : "Copy path"}
        </button>
        <button
          type="button"
          role="menuitem"
          className="project-menu-item"
          onClick={() => {
            close();
            onMint();
          }}
        >
          <IconPlus {...glyph} aria-hidden />
          New session
        </button>
      </div>
    </div>
  );
}
