import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  ConversationStage,
  SessionSidebar,
  WorkspaceBar,
  WorkspaceShell,
  needsOnboarding,
} from "@inhuman.tools/harness-ui";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { glyph } from "@inhuman.tools/harness-ui/primitives/glyph";
import { Link } from "@inhuman.tools/harness-ui/primitives/navigation";
import { IconSettings } from "@tabler/icons-react";
import { Outlet, useRouter } from "@tanstack/react-router";
import { observer } from "mobx-react-lite";

import { Composer } from "./composer.js";
import { readEmbed } from "./embed.js";
import { FilePreviewPane, FilePreviewProvider } from "./file-sidebar.js";
import { LinkNotice } from "./link-notice.js";
import { focusStage } from "./new-session.js";
import { projectHref } from "./path.js";
import { botIdsOf, ProjectTabs, railPane } from "./project-tabs.js";
import { SessionRail } from "./rail-sessions.js";
import { SettingsDialog } from "./settings.js";
import { Splash } from "./splash.js";
import { useDial } from "../client/context.js";
import { appLocation } from "../client/location.js";

const remote = appLocation(globalThis.location).remote;

/** Reference operator workspace frame assembled from white-label Lego compositions. */
export const Frame = observer(function Shell() {
  const dial = useDial();
  const router = useRouter();
  const [railOpen, setRailOpen] = useState(false);
  const [browsingBots, setBrowsingBots] = useState(false);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const routed = dial.requestedTarget;
  const committed = dial.target;
  const targetPath =
    committed.kind === "project" || committed.kind === "project-session"
      ? committed.path
      : (dial.project?.root.path ?? null);
  const sessionId = routed.kind === "session" || routed.kind === "project-session" ? routed.sessionId : null;
  const attached = sessionId != null && dial.session?.root.sessionId === sessionId ? dial.session.root : null;
  const scrollport = useRef<HTMLElement>(null);
  const [projectSessions, setProjectSessions] = useState<ReadonlyMap<string, string>>(() => new Map());
  useLayoutEffect(() => {
    // Remember only successful attachments, never a pending or failed selection.
    if (committed.kind !== "project-session") return;
    if (dial.kernel != null && botIdsOf(dial.kernel, dial.projects).has(committed.sessionId)) return;
    setProjectSessions((previous) => {
      if (previous.get(committed.path) === committed.sessionId) return previous;
      return new Map(previous).set(committed.path, committed.sessionId);
    });
  }, [committed, dial]);
  const positions = useRef(new Map<string, { top: number; tail: boolean }>());
  // Keep the old view's identity during a pending/failed attachment.
  const scrollKey =
    committed.kind === "project-session" || committed.kind === "session"
      ? JSON.stringify(["path" in committed ? committed.path : null, committed.sessionId])
      : null;
  const saveScroll = (): void => {
    const port = scrollport.current;
    if (scrollKey == null || port == null) return;
    positions.current.set(scrollKey, {
      top: port.scrollTop,
      tail: port.scrollHeight - port.clientHeight - port.scrollTop <= 2,
    });
  };
  useLayoutEffect(() => {
    // Native anchoring owns streaming updates after this initial restoration.
    const port = scrollport.current;
    if (scrollKey == null || port == null) return;
    const saved = positions.current.get(scrollKey);
    port.scrollTop = saved == null || saved.tail ? port.scrollHeight : saved.top;
  }, [scrollKey]);
  const routeKey = `${routed.kind}:${"path" in routed ? routed.path : ""}:${"sessionId" in routed ? routed.sessionId : ""}`;
  useEffect(() => {
    setBrowsingBots(false);
  }, [routeKey]);
  const go = (href: string): void => {
    setRailOpen(false);
    setBrowsingBots(false);
    void router.navigate({ href });
  };
  const openStage = (path: string): void => {
    focusStage();
    go(projectHref(path));
  };
  const isRemote = Boolean((dial as { readonly where?: { readonly remote?: boolean } }).where?.remote) || remote;
  const addProject = (): void => {
    const rpc = dial.kernelRpc;
    if (isRemote || rpc == null || adding) return;
    setAdding(true);
    void rpc
      .request("project/pick", {})
      .then((raw) => {
        const result = raw as { readonly ok?: boolean; readonly path?: string } | null;
        if (result?.ok === true && typeof result.path === "string" && result.path !== "") {
          openStage(result.path);
        }
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        setAdding(false);
      });
  };

  const embed = readEmbed(typeof window === "undefined" ? "" : window.location.search);
  if (embed.active) {
    const inset = {
      "--embed-safe-top": `${embed.safeTop}px`,
      "--embed-safe-bottom": `${embed.safeBottom}px`,
    } as CSSProperties;
    return (
      <FilePreviewProvider resetKey={sessionId}>
        <WorkspaceShell
          embed
          style={inset}
          stage={
            <ConversationStage scrollRef={scrollport} onScroll={saveScroll}>
              {sessionId != null && attached == null ? (
                <div className="transcript">
                  <section className="transcript-empty transcript-column">
                    <LinkNotice />
                  </section>
                </div>
              ) : (
                <Outlet />
              )}
            </ConversationStage>
          }
          inspector={<FilePreviewPane projectPath={attached?.path ?? targetPath ?? ""} />}
        />
      </FilePreviewProvider>
    );
  }

  if (dial.kernel != null && needsOnboarding(dial.kernel.root.connections)) return <Splash />;

  const bots = dial.kernel == null ? new Set<string>() : botIdsOf(dial.kernel, dial.projects);
  const pane = railPane(routed, bots, browsingBots);

  return (
    <FilePreviewProvider resetKey={sessionId}>
      <WorkspaceShell
        picking={adding}
        sidebar={
          <SessionSidebar
            open={railOpen}
            ariaLabel="Projects and sessions"
            brand="Inhuman"
            headerAction={
              isRemote ? (
                <Link className="rail-machines" href="/">
                  All machines
                </Link>
              ) : null
            }
          >
            <SessionRail go={go} pane={pane} selectedSessionId={sessionId} onMint={openStage} />
          </SessionSidebar>
        }
        stage={
          <ConversationStage scrollRef={scrollport} onScroll={saveScroll} composer={<Composer />}>
            <Outlet />
          </ConversationStage>
        }
        inspector={<FilePreviewPane projectPath={attached?.path ?? targetPath ?? ""} />}
        workspaceBar={
          <WorkspaceBar
            leadingAction={
              <Button
                variant="content"
                type="button"
                className="project-corner touch-target"
                onClick={() => setSettingsOpen(true)}
              >
                <IconSettings {...glyph} aria-hidden />
                Settings
              </Button>
            }
            mobileNavToggle={{
              open: railOpen,
              openAriaLabel: "Open navigation",
              closeAriaLabel: "Close navigation",
              onToggle: () => setRailOpen((open) => !open),
            }}
          >
            <ProjectTabs
              projectSessions={projectSessions}
              go={go}
              pane={pane}
              onBrowseBots={() => {
                setBrowsingBots(true);
                setRailOpen(true);
              }}
              onAdd={isRemote ? undefined : addProject}
              adding={adding}
              onMint={openStage}
            />
          </WorkspaceBar>
        }
        overlay={settingsOpen ? <SettingsDialog onDismiss={() => setSettingsOpen(false)} /> : null}
      />
    </FilePreviewProvider>
  );
});
