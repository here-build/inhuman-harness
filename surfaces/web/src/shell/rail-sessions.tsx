import { useEffect, useState } from "react";
import { isConversationOverview, type SessionOverview, type SessionRoot } from "@inhuman.tools/harness-model";
import type { ProjectDocument } from "@inhuman.tools/harness-peer";
import { NEW_CONVERSATION, rowTitle } from "@inhuman.tools/harness-transcript/tape-read";
import {
  SessionRailBlock,
  type RowLight,
  type SessionRailBotGroup,
  type SessionRailItem,
} from "@inhuman.tools/harness-ui";
import { observer } from "mobx-react-lite";

import { rowLight } from "./light.js";
import { LinkNotice } from "./link-notice.js";
import { looseSessionHref, projectNames, sessionHref } from "./path.js";
import { orderSessions, overviewList, shortAge } from "./session-order.js";
import { useDial } from "../client/context.js";

/** Thin MobX adapter projecting overview, project, and bot session lists into SessionRailBlock. */
export const SessionRail = observer(function SessionRailView({
  go,
  pane,
  selectedSessionId,
  onMint,
}: {
  readonly go: (href: string) => void;
  readonly pane:
    { readonly kind: "overview" } | { readonly kind: "project"; readonly path: string } | { readonly kind: "bots" };
  readonly selectedSessionId: string | null;
  readonly onMint: (path: string) => void;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  if (kernel == null) {
    const opening =
      dial.attaching && (dial.requestedTarget.kind === "session" || dial.requestedTarget.kind === "project-session");
    return (
      <SessionRailBlock
        mode="connecting"
        navLabel="All projects"
        busy
        busyMessage={opening ? "Opening this session…" : null}
        onNavigate={go}
      />
    );
  }
  if (pane.kind === "bots") return <BotList go={go} selectedSessionId={selectedSessionId} />;
  if (pane.kind === "overview") return <OverviewSessions go={go} selectedSessionId={selectedSessionId} />;
  return <ProjectSessions path={pane.path} go={go} selectedSessionId={selectedSessionId} onMint={onMint} />;
});

const OverviewSessions = observer(function OverviewSessionsView({
  go,
  selectedSessionId,
}: {
  readonly go: (href: string) => void;
  readonly selectedSessionId: string | null;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  const [query, setQuery] = useState("");
  if (kernel == null) return null;
  const paths = Object.keys(kernel.root.projects);
  const names = projectNames(paths);
  const heldOf = (path: string) => dial.projects.get(path) ?? (dial.project?.root.path === path ? dial.project : null);
  const rows: { sessionId: string; path: string; project: string }[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const held = heldOf(path);
    if (held == null) continue;
    const project = names.get(path) ?? path;
    for (const sessionId of Object.keys(held.root.sessions)) {
      if (seen.has(sessionId)) continue;
      if (!listedConversation(kernel.root.sessions[sessionId], sessionId === selectedSessionId)) continue;
      seen.add(sessionId);
      rows.push({ sessionId, path, project });
    }
  }
  const byId = new Map(rows.map((row) => [row.sessionId, row]));
  const lights = new Map(rows.map((row) => [row.sessionId, lightOf(dial, kernel, row.sessionId)]));
  const ordered = overviewList(
    rows.map((row) => row.sessionId),
    (id) => lights.get(id) ?? "idle",
    (id) => lastMessageAt(kernel.root.sessions[id]),
  );
  const needsAttention = ordered.some((id) => {
    const light = lights.get(id);
    return light === "waiting-for-you" || light === "running";
  });
  const needle = query.trim().toLowerCase();
  const shown =
    needle === ""
      ? ordered
      : ordered.filter((id) => {
          const row = byId.get(id);
          return (
            labelOf(dial, kernel, id).toLowerCase().includes(needle) ||
            (row?.project.toLowerCase().includes(needle) ?? false)
          );
        });
  const heldAny = paths.some((path) => heldOf(path) != null);
  const now = Date.now();
  const items: SessionRailItem[] = [];
  for (const sessionId of shown) {
    const row = byId.get(sessionId);
    if (row == null) continue;
    const attached = dial.session?.root.sessionId === sessionId ? dial.session.root : null;
    const overview = kernel.root.sessions[sessionId];
    items.push(
      toRailItem({
        sessionId,
        selected: selectedSessionId === sessionId,
        href: sessionHref(row.path, sessionId),
        attached,
        overview,
        now,
        project: row.project,
      }),
    );
  }
  return (
    <SessionRailBlock
      mode="overview"
      navLabel="All projects"
      heading={ordered.length === 0 ? "" : needsAttention ? "Needs attention" : "Recent"}
      showSearch={ordered.length > 8}
      searchQuery={query}
      onSearchChange={setQuery}
      emptyMessage={
        ordered.length === 0
          ? paths.length === 0
            ? "No projects yet."
            : heldAny
              ? "No sessions yet."
              : "Attaching…"
          : "No sessions match."
      }
      items={items}
      onNavigate={go}
    />
  );
});

const ProjectSessions = observer(function ProjectSessionsView({
  path,
  go,
  selectedSessionId,
  onMint,
}: {
  readonly path: string;
  readonly go: (href: string) => void;
  readonly selectedSessionId: string | null;
  readonly onMint: (path: string) => void;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  if (kernel == null) return null;
  const known = Object.keys(kernel.root.projects);
  const name = projectNames(known.includes(path) ? known : [...known, path]).get(path) ?? path;
  const held = dial.projects.get(path) ?? (dial.project?.root.path === path ? dial.project : null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    setQuery("");
  }, [path]);
  const sessions = held == null ? [] : listedSessions(kernel.root.sessions, held, selectedSessionId);
  const lights = new Map(sessions.map((id) => [id, lightOf(dial, kernel, id)]));
  const ordered = orderSessions(
    sessions,
    (id) => lights.get(id) ?? "idle",
    (id) => lastMessageAt(kernel.root.sessions[id]),
  );
  const needle = query.trim().toLowerCase();
  const shown =
    needle === "" ? ordered : ordered.filter((id) => labelOf(dial, kernel, id).toLowerCase().includes(needle));
  const now = Date.now();
  const items = shown.map((sessionId) =>
    toRailItem({
      sessionId,
      selected: selectedSessionId === sessionId,
      href: sessionHref(path, sessionId),
      attached: dial.session?.root.sessionId === sessionId ? dial.session.root : null,
      overview: kernel.root.sessions[sessionId],
      now,
    }),
  );
  const attachingMessage =
    held != null
      ? null
      : dial.requestedTarget.kind === "session" || dial.requestedTarget.kind === "project-session"
        ? "Opening this session…"
        : "Attaching…";
  return (
    <SessionRailBlock
      mode="project"
      navLabel="All projects"
      heading={name}
      headingTitle={path}
      onMint={() => onMint(path)}
      mintLabel={`New session in ${name}`}
      mintDisabled={held == null}
      notice={dial.session == null && dial.link != null ? <LinkNotice /> : null}
      attachingMessage={attachingMessage}
      showSearch={sessions.length > 8}
      searchQuery={query}
      onSearchChange={setQuery}
      emptyMessage={sessions.length === 0 ? "No sessions yet." : "No sessions match."}
      items={items}
      onNavigate={go}
    />
  );
});

const BotList = observer(function BotListView({
  go,
  selectedSessionId,
}: {
  readonly go: (href: string) => void;
  readonly selectedSessionId: string | null;
}) {
  const dial = useDial();
  const kernel = dial.kernel;
  if (kernel == null) return null;
  const projects = Object.keys(kernel.root.projects);
  const names = projectNames(projects);
  const held = (path: string) => dial.projects.get(path) ?? (dial.project?.root.path === path ? dial.project : null);
  const groups: SessionRailBotGroup[] = [
    { key: "", name: "Global", bots: Object.entries(kernel.root.botsRoster), href: looseSessionHref },
    ...projects.map((path) => ({
      key: path,
      name: names.get(path) ?? path,
      bots: Object.entries(held(path)?.root.botsRoster ?? {}),
      href: (sessionId: string) => sessionHref(path, sessionId),
    })),
  ]
    .filter((group) => group.bots.length > 0)
    .map((group) => ({
      key: group.key,
      name: group.name,
      rows: group.bots.map(([name, sessionId]) => ({
        key: name,
        href: group.href(sessionId),
        label: name,
        light: lightOf(dial, kernel, sessionId),
        selected: selectedSessionId === sessionId,
      })),
    }));
  return (
    <SessionRailBlock
      mode="bots"
      navLabel="All projects"
      heading="Bots"
      emptyMessage="No bots."
      botGroups={groups}
      onNavigate={go}
    />
  );
});

function toRailItem({
  sessionId,
  selected,
  href,
  attached,
  overview,
  now,
  project,
}: {
  readonly sessionId: string;
  readonly selected: boolean;
  readonly href: string;
  readonly attached: SessionRoot | null;
  readonly overview: SessionOverview | undefined;
  readonly now: number;
  readonly project?: string;
}): SessionRailItem {
  const label = rowTitle({
    live: attached?.title ?? "",
    title: overview?.title ?? "",
    lastPrompt: overview?.lastPrompt ?? "",
  });
  return {
    key: sessionId,
    href,
    label,
    light: rowLight(attached, overview),
    selected,
    title: label === NEW_CONVERSATION ? sessionId : label,
    age: shortAge(overview?.lastMessageAt, now),
    detail: project,
  };
}

function listedConversation(overview: SessionOverview | undefined, force: boolean): boolean {
  if (force) return true;
  if (overview == null || !isConversationOverview(overview)) return false;
  return (
    rowText(overview.title).trim() !== "" ||
    rowText(overview.status).trim() !== "" ||
    rowText(overview.lastPrompt).trim() !== ""
  );
}

function listedSessions(
  glances: { readonly [id: string]: SessionOverview | undefined },
  held: ProjectDocument,
  selectedSessionId: string | null,
): string[] {
  return Object.keys(held.root.sessions).filter((sessionId) =>
    listedConversation(glances[sessionId], sessionId === selectedSessionId),
  );
}

function lightOf(
  dial: ReturnType<typeof useDial>,
  kernel: NonNullable<ReturnType<typeof useDial>["kernel"]>,
  sessionId: string,
): RowLight {
  return rowLight(
    dial.session?.root.sessionId === sessionId ? dial.session.root : null,
    kernel.root.sessions[sessionId],
  );
}

function labelOf(
  dial: ReturnType<typeof useDial>,
  kernel: NonNullable<ReturnType<typeof useDial>["kernel"]> | null,
  sessionId: string,
): string {
  const overview = kernel?.root.sessions[sessionId];
  const attached = dial.session?.root.sessionId === sessionId ? dial.session.root : null;
  return rowTitle({
    live: attached?.title ?? "",
    title: overview?.title ?? "",
    lastPrompt: overview?.lastPrompt ?? "",
  });
}

function rowText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** No message yet means just minted: newest of its band. */
function lastMessageAt(overview: SessionOverview | undefined): number {
  return overview?.lastMessageAt ?? Number.POSITIVE_INFINITY;
}
