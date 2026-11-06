import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { IconChevronDown, IconCopy, IconFolder, IconLayoutGrid, IconPlus, IconRobot } from "@tabler/icons-react";
import { observer } from "mobx-react-lite";

import { projectPulse, rowLight } from "./light.js";
import { projectHref, projectNames, sessionHref, type RouteTarget } from "./path.js";
import { useDial } from "../client/context.js";
import { Menu, MenuItem, MenuTrigger, NativePopover } from "../components/ui/anchored.js";
import { Button } from "../components/ui/button.js";
import { glyph } from "../components/ui/glyph.js";
import { FieldButton, Link } from "../components/ui/navigation.js";

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
  projectSessions,
  go,
  pane,
  onBrowseBots,
  onAdd,
  onMint,
}: {
  readonly projectSessions?: ReadonlyMap<string, string>;
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
      <nav ref={listRef} className="project-tablist" aria-label="Projects">
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
            sessionId={projectSessions?.get(path)}
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
      </nav>
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
  sessionId,
  name,
  active,
  go,
  onMint,
  tabRef,
}: {
  readonly path: string;
  readonly sessionId?: string;
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
      href={
        sessionId != null && held?.root.sessions[sessionId] != null ? sessionHref(path, sessionId) : projectHref(path)
      }
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
  const select: NonNullable<React.ComponentProps<typeof Link>["onClick"]> = (event): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (href != null && go != null) go(href);
  };
  return (
    <div ref={tabRef} className="project-tab touch-target" data-tab={kind} data-active={active ? "" : undefined}>
      {href == null ? (
        <Button
          variant="ghost"
          aria-current={active ? "page" : undefined}
          className="project-tab-main"
          aria-label={label}
          title={title ?? label}
          onClick={onSelect}
        >
          {icon}
          <span className="project-tab-label truncate">{label}</span>
          {status}
        </Button>
      ) : (
        <Link
          isCommand
          aria-current={active ? "page" : undefined}
          className="project-tab-main no-underline"
          href={href}
          aria-label={label}
          title={title ?? label}
          onClick={select}
        >
          {icon}
          <span className="project-tab-label truncate">{label}</span>
          {status}
        </Link>
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
  const errorId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "pending" | "copied" | "error">("idle");
  const copyAttempt = useRef<object>(undefined);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
      copyAttempt.current = undefined;
    },
    [],
  );
  const changeOpen = (open: boolean): void => {
    clearTimeout(copiedTimer.current);
    copyAttempt.current = undefined;
    setCopyStatus("idle");
    setIsOpen(open);
  };
  const copy = async (): Promise<void> => {
    if (copyAttempt.current) return;
    const attempt = {};
    copyAttempt.current = attempt;
    setCopyStatus("pending");
    try {
      await navigator.clipboard.writeText(path);
      // A dismissed menu must not update (or close) a later opening.
      if (copyAttempt.current !== attempt) return;
      setCopyStatus("copied");
      copiedTimer.current = setTimeout(() => changeOpen(false), 600);
    } catch {
      if (copyAttempt.current !== attempt) return;
      copyAttempt.current = undefined;
      setCopyStatus("error");
    }
  };
  return (
    <div className={`project-tab-menu${isOpen ? " [.project-tab:not(:has(.project-tab-main:hover))_&]:bg-hover" : ""}`}>
      <MenuTrigger isOpen={isOpen} onOpenChange={changeOpen}>
        <FieldButton className="project-tab-chevron border-0 p-0" aria-label={`${name} menu`}>
          <IconChevronDown {...glyph} aria-hidden />
        </FieldButton>
        <NativePopover>
          <Menu aria-label={name}>
            <MenuItem
              id="copy"
              textValue="Copy path"
              className="project-menu-item"
              shouldCloseOnSelect={false}
              isDisabled={copyStatus === "pending" || copyStatus === "copied"}
              aria-describedby={copyStatus === "error" ? errorId : undefined}
              onAction={() => void copy()}
            >
              <IconCopy {...glyph} aria-hidden />
              {copyStatus === "copied" ? "Copied" : "Copy path"}
            </MenuItem>
            <MenuItem
              id="new-session"
              textValue="New session"
              className="project-menu-item"
              onAction={() => {
                changeOpen(false);
                onMint();
              }}
            >
              <IconPlus {...glyph} aria-hidden />
              New session
            </MenuItem>
          </Menu>
          {copyStatus === "error" ? (
            <p id={errorId} role="alert" className="px-2 py-1 text-sm text-danger">
              Could not copy path. Try again or copy it manually: {path}
            </p>
          ) : null}
        </NativePopover>
      </MenuTrigger>
    </div>
  );
}
