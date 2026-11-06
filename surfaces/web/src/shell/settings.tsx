import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { observer } from "mobx-react-lite";

import {
  mcpDrafts,
  mcpHint,
  mcpOption,
  mcpPayload,
  mcpPoolCaption,
  mcpServerLine,
  mcpServerOptions,
  serverChoices,
  type McpGrantDraft,
  type McpServerOption,
} from "./bot-mcp.js";
import { parsePark, openUrlFieldType, type ParkForm } from "./connect-park.js";
import { ConnectStep, connectPort, type Request } from "./connect-step.js";
import { mcpLoginLine } from "./mcp-registry.js";
import { RegistrySearch } from "./mcp-search.js";
import { PermissionsPanel } from "./permissions-panel.js";
import { providerRows, type ConnectStart } from "./provider-list.js";
import { closeOpenSwipes, SwipeRow, type SwipeAction } from "./swipe-row.js";
import { wireAccount } from "./wire-account.js";
import { useDial } from "../client/context.js";
import { DropdownSelect } from "../components/ui/anchored.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { NativeDialog } from "../components/ui/native-dialog.js";
import { Link } from "../components/ui/navigation.js";
import { TextField } from "../components/ui/text-field.js";

const SECTIONS = [
  ["connections", "Connections"],
  ["mcp", "MCP"],
  ["plugins", "Plugins"],
  ["skills", "Skills"],
  ["bots", "Bots"],
  ["permissions", "Permissions"],
  ["runtime", "Runtime"],
] as const;

type Section = (typeof SECTIONS)[number][0];

type Conn = {
  readonly name?: string;
  readonly readyState?: string | null;
  readonly error?: string;
  readonly configuration?: { readonly [key: string]: unknown };
  readonly live?: {
    readonly identity?: unknown;
    readonly keyMask?: unknown;
    readonly account?: unknown;
    readonly tools?: unknown;
  };
  readonly driver?: { readonly name?: string; readonly abilityClaim?: readonly string[] } | null;
};

type PluginFace = {
  readonly pluginName?: string;
  readonly sourceNpm?: string;
  readonly sourceVersion?: string;
  readonly enabled?: boolean;
  readonly foreground?: boolean;
  readonly problem?: string | null;
};

type BotFace = {
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: unknown;
  readonly recipeScope?: string;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly keepAlive?: boolean;
  readonly mcpJson?: string;
  readonly error?: string | null;
};

type SkillRow = {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly invoke: string;
  readonly scope: "project" | "home";
};

type Park = { readonly pending: string; readonly body: string };

export function SettingsDialog({ onDismiss }: { readonly onDismiss: () => void }) {
  const titleId = useId();
  const [section, setSection] = useState<Section>("connections");
  const [node, setNode] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (node == null || node.open) return;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
  }, [node]);
  return (
    <NativeDialog
      ref={setNode}
      className="settings-dialog"
      aria-labelledby={titleId}
      onClose={onDismiss}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings">
          {SECTIONS.map(([id, label]) => (
            <Button
              key={id}
              variant="ghost"
              className="justify-start"
              aria-current={section === id ? "true" : undefined}
              onClick={() => setSection(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
        <div className="settings-body" onScroll={() => closeOpenSwipes()}>
          <header className="settings-head">
            <h2 id={titleId} className="text-xl leading-[26px]">
              {SECTIONS.find(([id]) => id === section)?.[1]}
            </h2>
            <form method="dialog">
              <Button variant="ghost" type="submit">
                Close
              </Button>
            </form>
          </header>
          {section === "connections" ? <Connections /> : null}
          {section === "mcp" ? <McpServers /> : null}
          {section === "plugins" ? <Plugins /> : null}
          {section === "skills" ? <Skills /> : null}
          {section === "bots" ? <Bots /> : null}
          {section === "permissions" ? <PermissionsPanel /> : null}
          {section === "runtime" ? <Runtime /> : null}
        </div>
      </div>
    </NativeDialog>
  );
}

const Connections = observer(function ConnectionsView() {
  const dial = useDial();
  const { request, notice, run } = useConnectionRun();
  const [adding, setAdding] = useState(false);
  const models = listedConnections(dial).filter(([, spec]) => !isMcp(spec));
  if (adding) return <AddModel onDone={() => setAdding(false)} />;
  return (
    <>
      <Notice message={notice} />
      <div className="settings-actions">
        <Button variant="secondary" disabled={request == null} onClick={() => setAdding(true)}>
          Add a model
        </Button>
      </div>
      <p className="text-sm text-muted">
        {models.length === 0 ? "No model is connected." : "Off keeps a model out of new sessions."}
      </p>
      <div className="settings-list">
        {models.map(([id, spec]) => (
          <ConnectionRow key={id} id={id} spec={spec} disabled={request == null} onRun={run} />
        ))}
      </div>
    </>
  );
});

const McpServers = observer(function McpView() {
  const dial = useDial();
  const noticeId = useId();
  const { request, notice, setNotice, run } = useConnectionRun();
  const [adding, setAdding] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [park, setPark] = useState<Park | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const servers = listedConnections(dial).filter(([, spec]) => isMcp(spec));
  const adopt = (body: { readonly name?: string; readonly input: string }, closeForm: boolean) => {
    if (request == null || adopting) return;
    setNotice("");
    setAdopting(true);
    void request("mcp-server/adopt", body).then(
      (result) => {
        setAdopting(false);
        const next = parkOf(result);
        if (next != null) {
          setPark(next);
          return undefined;
        }
        if (closeForm) {
          setAdding(false);
          setEndpoint("");
        }
        setNotice(failureOf(result));
        return undefined;
      },
      (error: unknown) => {
        setAdopting(false);
        return report(setNotice, error);
      },
    );
  };
  if (park != null && request != null) {
    return (
      <ParkFollow
        park={park}
        request={request}
        onPark={setPark}
        onDone={() => {
          setPark(null);
          setAdding(false);
          setEndpoint("");
        }}
        onCancel={() => setPark(null)}
      />
    );
  }
  return (
    <>
      <Notice id={noticeId} message={notice} />
      <RegistrySearch
        noticeId={notice === "" ? undefined : noticeId}
        request={request}
        rows={servers}
        disabled={request == null || adopting}
        onNotice={setNotice}
        onAdopt={(hit) => adopt({ name: hit.title, input: hit.install }, false)}
      />
      <div className="settings-actions">
        <Button variant="secondary" disabled={request == null} onClick={() => setAdding((open) => !open)}>
          Add MCP
        </Button>
      </div>
      {adding ? (
        <div className="text-sm">
          <TextField
            label="URL or command"
            value={endpoint}
            inputClassName="mono"
            aria-describedby={notice === "" ? undefined : noticeId}
            placeholder="https://… or npx @scope/server"
            spellCheck={false}
            onChange={setEndpoint}
          />
          <Button
            className="mt-2"
            variant="secondary"
            disabled={adopting || endpoint.trim() === ""}
            onClick={() => adopt({ input: endpoint.trim() }, true)}
          >
            Connect
          </Button>
        </div>
      ) : null}
      <p className="text-sm text-muted">
        {servers.length === 0 ? "No MCP server is connected." : "Off keeps a server out of new sessions."}
      </p>
      <div className="settings-list">
        {servers.map(([id, spec]) => (
          <ConnectionRow key={id} id={id} spec={spec} mcp disabled={request == null} onRun={run} />
        ))}
      </div>
    </>
  );
});

function useConnectionRun() {
  const request = kernelRequest(useDial());
  const [notice, setNotice] = useState("");
  const run = useCallback(
    (method: string, params: unknown) => {
      setNotice("");
      return ask(request, method, params).then((error) => {
        setNotice(error);
        return error;
      });
    },
    [request],
  );
  return { request, notice, setNotice, run };
}

function ConnectionRow({
  id,
  spec,
  mcp = false,
  disabled,
  onRun,
}: {
  readonly id: string;
  readonly spec: Conn;
  readonly mcp?: boolean;
  readonly disabled: boolean;
  readonly onRun: (method: string, params: unknown) => Promise<string>;
}) {
  const account = wireAccount(spec, spec.driver?.name ?? "");
  const name = shownName(spec.name, id);
  const detail = mcp ? mcpLoginLine(spec, name) : connectionDetail(account, spec.readyState);
  const enabled = useLiveToggle(spec.configuration?.enabled !== false, (next) =>
    onRun("connect/set-enabled", { id, enabled: next }),
  );
  const [busy, setBusy] = useState(false);
  const act = (method: string, params: unknown) => {
    setBusy(true);
    return onRun(method, params).then((error) => {
      setBusy(false);
      return error;
    });
  };
  const leading: SwipeAction | undefined = mcp
    ? account.failed
      ? { label: "Log in", name: `Log in to ${name}`, tone: "action", onPress: () => act("connect/login", { id }) }
      : { label: "Log out", name: `Log out of ${name}`, tone: "quiet", onPress: () => act("connect/logout", { id }) }
    : undefined;
  return (
    <SwipeRow
      label={`${name}, ${detail}`}
      title={name}
      detail={detail}
      failed={account.failed}
      checked={enabled.checked}
      disabled={disabled || busy}
      leading={leading}
      trailing={{
        label: "Delete",
        name: `Delete ${name}`,
        tone: "destructive",
        onPress: () => act("connect/drop", { id, confirm: true }),
      }}
      onToggle={enabled.toggle}
    />
  );
}

/** The switch moves immediately. The kernel value replaces it when the write lands. */
function useLiveToggle(live: boolean, apply: (next: boolean) => Promise<string>) {
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => {
    if (override !== null && override === live) setOverride(null);
  }, [live, override]);
  const checked = override ?? live;
  return {
    checked,
    toggle: () => {
      const next = !checked;
      setOverride(next);
      void apply(next).then((error) => {
        if (error !== "") setOverride(null);
        return undefined;
      });
    },
  };
}

const AddModel = observer(function AddModelView({ onDone }: { readonly onDone: () => void }) {
  const dial = useDial();
  const request = connectPort(dial);
  const [start, setStart] = useState<ConnectStart | null>(null);
  const rows = providerRows(dial.kernel?.root.drivers, dial.kernel?.root.connections);
  const drivers = rows.map((row) => row.driver).join("\0");
  useEffect(() => {
    dial.look([], drivers === "" ? [] : [...new Set(drivers.split("\0"))]);
    return () => dial.look([], []);
  }, [dial, drivers]);
  if (start != null && request != null) {
    return <ConnectStep start={start} request={request} onDone={onDone} onCancel={() => setStart(null)} />;
  }
  return (
    <div className="settings-list">
      <Button variant="ghost" onClick={onDone}>
        Back
      </Button>
      {rows.length === 0 ? <Empty>Every offered model is already connected.</Empty> : null}
      {rows.map((row) => (
        <Button
          key={row.key}
          variant="ghost"
          className="settings-row items-start text-start [font-variant-caps:normal] tracking-normal"
          disabled={row.start == null || request == null}
          onClick={() => {
            if (row.start != null) setStart(row.start);
          }}
        >
          <span className="text-sm font-strong">{row.name}</span>
          <span className="text-sm text-muted">{shownName(row.hint, row.description)}</span>
        </Button>
      ))}
    </div>
  );
});

const Plugins = observer(function PluginsView() {
  const dial = useDial();
  const request = kernelRequest(dial);
  const [notice, setNotice] = useState("");
  const plugins = Object.values(pluginsOf(dial));
  const run = (name: string, patch: { enabled?: boolean; foreground?: boolean }) => {
    setNotice("");
    void ask(request, "plugin/set", { name, ...patch }).then(setNotice);
  };
  return (
    <>
      <Notice message={notice} />
      {plugins.length === 0 ? <Empty>No plugin is installed.</Empty> : null}
      <div className="settings-list">
        {plugins.map((plugin) => {
          const name = plugin.pluginName ?? "";
          return (
            <article key={name} className="settings-row">
              <div className="settings-row-main">
                <div className="settings-grow">
                  <p className="truncate text-sm font-strong">{name}</p>
                  <p className="truncate text-sm text-muted">
                    {[plugin.sourceNpm, plugin.sourceVersion].filter((part) => part != null && part !== "").join(" ")}
                  </p>
                  {plugin.problem ? <p className="text-sm text-warning">{plugin.problem}</p> : null}
                </div>
              </div>
              <Checkbox
                isSelected={plugin.enabled !== false}
                isDisabled={request == null || name === ""}
                aria-label={`${name} enabled`}
                onChange={(enabled) => run(name, { enabled })}
              >
                Enabled
              </Checkbox>
              <Checkbox
                isSelected={plugin.foreground !== false}
                isDisabled={request == null || name === ""}
                aria-label={`${name} foreground bot`}
                onChange={(foreground) => run(name, { foreground })}
              >
                Foreground bot
              </Checkbox>
            </article>
          );
        })}
      </div>
    </>
  );
});

const Skills = observer(function SkillsView() {
  const dial = useDial();
  const request = kernelRequest(dial);
  const project = openProject(dial);
  const [rows, setRows] = useState<readonly SkillRow[]>([]);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState({ scope: "project" as "project" | "home", name: "", description: "", body: "" });
  useEffect(() => {
    const port = dial.kernelRpc;
    if (port == null) return;
    let live = true;
    void port.request("skill/list", project == null ? {} : { project }).then(
      (result) => {
        if (!live) return undefined;
        if (isSkillList(result)) setRows(result.skills);
        else setNotice(failureOf(result));
        return undefined;
      },
      (error: unknown) => report(setNotice, error),
    );
    return () => {
      live = false;
    };
  }, [dial.kernelRpc, project, revision]);
  const save = () => {
    setSaved(false);
    setNotice("");
    void ask(request, "skill/write", {
      scope: draft.scope,
      ...(draft.scope === "project" && project != null ? { project } : {}),
      name: draft.name.trim(),
      description: draft.description,
      body: draft.body,
    }).then((error) => {
      setNotice(error);
      setSaved(error === "");
      if (error === "") {
        setDraft({ scope: draft.scope, name: "", description: "", body: "" });
        setRevision((value) => value + 1);
      }
      return undefined;
    });
  };
  return (
    <>
      <Notice message={notice} />
      <p className="text-sm text-muted">
        {project == null
          ? "Home skills. Open a project to edit that project’s skills."
          : "A folder in the drawer is on. Removing it takes the skill off the next session."}
      </p>
      <div className="settings-list">
        {rows.length === 0 ? <Empty>No skills.</Empty> : null}
        {rows.map((skill) => (
          <article key={skill.location} className="settings-row">
            <div className="settings-row-main">
              <div className="settings-grow">
                <p className="truncate text-sm font-strong">
                  {skill.invoke === skill.name ? skill.name : `${skill.name} · /${skill.invoke}`}
                </p>
                <p className="truncate text-sm text-muted">{skill.description}</p>
                <p className="truncate text-sm text-subtle">
                  {skill.scope === "home" ? "Home" : "Project"} · {skill.location}
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={request == null}
                aria-label={`Remove ${skill.name}`}
                onClick={() => {
                  setSaved(false);
                  setNotice("");
                  void ask(request, "skill/remove", {
                    scope: skill.scope,
                    ...(skill.scope === "project" && project != null ? { project } : {}),
                    name: skill.name,
                  }).then((error) => {
                    setNotice(error);
                    if (error === "") setRevision((value) => value + 1);
                    return undefined;
                  });
                }}
              >
                Remove
              </Button>
            </div>
          </article>
        ))}
      </div>
      <div className="settings-grid" onChangeCapture={() => setSaved(false)}>
        <DropdownSelect
          label="Where"
          className="col-span-full"
          value={draft.scope}
          onChange={(value) => {
            setSaved(false);
            setDraft({ ...draft, scope: value === "home" ? "home" : "project" });
          }}
          options={[
            { id: "project", label: "This project" },
            { id: "home", label: "Home" },
          ]}
        />
        <TextField
          label="Name"
          className="col-span-full"
          value={draft.name}
          spellCheck={false}
          placeholder="review"
          onChange={(value) => setDraft({ ...draft, name: value })}
        />
        <TextField
          label="Description"
          className="col-span-full"
          value={draft.description}
          onChange={(value) => setDraft({ ...draft, description: value })}
        />
        <TextField
          label="Body"
          className="col-span-full"
          multiline
          rows={5}
          value={draft.body}
          onChange={(value) => setDraft({ ...draft, body: value })}
        />
      </div>
      <Button variant="secondary" disabled={request == null || draft.name.trim() === ""} onClick={save}>
        Save skill
      </Button>
      {saved ? (
        <p className="text-sm text-ink" role="status">
          Skill saved.
        </p>
      ) : null}
    </>
  );
});

const Bots = observer(function BotsView() {
  const dial = useDial();
  const request = kernelRequest(dial);
  const project = openProject(dial);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState<BotDraft | null>(null);
  const edit = (draft: BotDraft | null) => {
    setSaved(false);
    setEditing(draft);
  };
  const home = Object.entries(botsOf(dial.kernel?.root)).map(([name, bot]) => ({ name, bot, scope: "home" as const }));
  const projectBots =
    project == null
      ? []
      : Object.entries(botsOf(dial.projects.get(project)?.root ?? dial.project?.root)).map(([name, bot]) => ({
          name,
          bot,
          scope: "project" as const,
        }));
  const save = (draft: BotDraft) => {
    setSaved(false);
    setNotice("");
    void ask(request, "bot/write", {
      scope: draft.scope,
      ...(draft.scope === "project" && project != null ? { project } : {}),
      name: draft.name.trim(),
      description: draft.description,
      instructions: draft.instructions,
      recipeScope: draft.recipeScope,
      tools: splitList(draft.tools),
      skills: splitList(draft.skills),
      keepAlive: draft.keepAlive,
      mcp: mcpPayload(draft.mcp),
    }).then((error) => {
      setNotice(error);
      setSaved(error === "");
      return undefined;
    });
  };
  return (
    <>
      <Notice message={notice} />
      <BotGroup
        title="Home"
        rows={home}
        onEdit={(name, bot) => edit(draftFrom(name, bot, "home"))}
        onRemove={(name) => {
          setSaved(false);
          void ask(request, "bot/remove", { scope: "home", name }).then(setNotice);
        }}
      />
      <BotGroup
        title="This project"
        rows={projectBots}
        onEdit={(name, bot) => edit(draftFrom(name, bot, "project"))}
        onRemove={(name) => {
          if (project == null) return;
          setSaved(false);
          void ask(request, "bot/remove", { scope: "project", project, name }).then(setNotice);
        }}
      />
      {editing == null ? (
        <Button
          variant="secondary"
          disabled={request == null}
          onClick={() =>
            edit({
              scope: project == null ? "home" : "project",
              name: "",
              description: "",
              instructions: "",
              recipeScope: "session",
              tools: "",
              skills: "",
              keepAlive: false,
              mcp: [],
              fresh: true,
            })
          }
        >
          New bot
        </Button>
      ) : (
        <BotForm
          draft={editing}
          project={project}
          servers={mcpServerOptions(connectionsOf(dial), editing.recipeScope, project ?? "")}
          onChange={edit}
          onCancel={() => edit(null)}
          onSave={() => save(editing)}
        />
      )}
      {saved ? (
        <p className="text-sm text-ink" role="status">
          Bot saved.
        </p>
      ) : null}
    </>
  );
});

const Runtime = observer(function RuntimeView() {
  const dial = useDial();
  const request = kernelRequest(dial);
  const root = dial.kernel?.root;
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState(() => runtimeDraft(root));
  useEffect(() => setDraft(runtimeDraft(root)), [root]);
  return (
    <>
      <Notice message={notice} />
      <div className="settings-grid" onChangeCapture={() => setSaved(false)}>
        <Field label="Compact strategy" value={draft.compact} onChange={(compact) => setDraft({ ...draft, compact })} />
        <Field label="Hard trigger" value={draft.hard} onChange={(hard) => setDraft({ ...draft, hard })} />
        <Field label="Soft trigger" value={draft.soft} onChange={(soft) => setDraft({ ...draft, soft })} />
        <Field label="Turns to keep" value={draft.keep} onChange={(keep) => setDraft({ ...draft, keep })} />
        <Field label="Context glow" value={draft.glow} onChange={(glow) => setDraft({ ...draft, glow })} />
        <Field
          label="Auto classifier"
          value={draft.classifier}
          onChange={(classifier) => setDraft({ ...draft, classifier })}
        />
        <Field
          label="Approval pause (ms)"
          value={draft.throttle}
          onChange={(throttle) => setDraft({ ...draft, throttle })}
        />
        <Field
          label="Speculative tools"
          value={draft.speculative}
          onChange={(speculative) => setDraft({ ...draft, speculative })}
        />
        <Field label="Shell peek (bytes)" value={draft.tail} onChange={(tail) => setDraft({ ...draft, tail })} />
        <Field
          label="Status line"
          value={draft.statusline}
          onChange={(statusline) => setDraft({ ...draft, statusline })}
        />
        <Field label="Status refresh" value={draft.refresh} onChange={(refresh) => setDraft({ ...draft, refresh })} />
        <DropdownSelect
          label="Super key"
          className="col-span-full"
          value={draft.superKey}
          onChange={(value) => setDraft({ ...draft, superKey: value === "cmd" ? "cmd" : "ctrl" })}
          options={[
            { id: "ctrl", label: "Ctrl" },
            { id: "cmd", label: "Command" },
          ]}
        />
      </div>
      <Check
        label="Hide floor-allow calls on the compact tape"
        checked={draft.hideFloor}
        onChange={(hideFloor) => {
          setSaved(false);
          setDraft({ ...draft, hideFloor });
        }}
      />
      <Check
        label="Text-only continuation"
        checked={draft.textOnly}
        onChange={(textOnly) => {
          setSaved(false);
          setDraft({ ...draft, textOnly });
        }}
      />
      <Button
        variant="secondary"
        disabled={request == null}
        onClick={() => {
          setSaved(false);
          const keep = Number(draft.keep);
          const throttle = Number(draft.throttle);
          const speculative = Number(draft.speculative);
          const tail = Number(draft.tail);
          if (![keep, throttle, speculative, tail].every((value) => Number.isFinite(value))) {
            setNotice("Turns, pause, speculative tools, and shell peek need numbers.");
            return;
          }
          setNotice("");
          void ask(request, "config/set", {
            compact: draft.compact,
            compactTriggers: { hard: draft.hard, soft: draft.soft },
            compactKeepTurns: keep,
            contextGlowRemaining: draft.glow,
            autoModeClassifier: draft.classifier,
            approvalAskThrottleMs: throttle,
            speculativePolicyProcessingTools: speculative,
            shellTailBytes: tail,
            statusline: draft.statusline,
            statuslineRefresh: draft.refresh,
            superKey: draft.superKey,
            hideFloorTools: draft.hideFloor,
            textOnlyContinue: draft.textOnly,
          }).then((error) => {
            setNotice(error);
            setSaved(error === "");
            return undefined;
          });
        }}
      >
        Save
      </Button>
      {saved ? (
        <p className="text-sm text-ink" role="status">
          Runtime settings saved.
        </p>
      ) : null}
    </>
  );
});

function ParkFollow({
  park,
  request,
  onPark,
  onDone,
  onCancel,
}: {
  readonly park: Park;
  readonly request: Request;
  readonly onPark: (park: Park) => void;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const [form, setForm] = useState<ParkForm | null>(null);
  const [pasted, setPasted] = useState("");
  const noticeId = useId();
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let live = true;
    void parsePark(park.body).then((next) => {
      if (live) setForm(next);
      return undefined;
    });
    return () => {
      live = false;
    };
  }, [park.body]);
  const answer = (params: Record<string, unknown>) => {
    setNotice("");
    void request("ui/resolve", { pending: park.pending, ...params }).then(
      (result) => {
        const next = parkOf(result);
        if (next != null) {
          setPasted("");
          onPark(next);
          return undefined;
        }
        if (failureOf(result) !== "") setNotice(failureOf(result));
        else onDone();
        return undefined;
      },
      (error: unknown) => report(setNotice, error),
    );
  };
  // A follow-up park replaces this one through the parent. This step finishes the current park.
  return (
    <div className="settings-list">
      <Notice id={noticeId} message={notice} />
      {form == null ? <Empty>Reading the next step…</Empty> : null}
      {form?.kind === "unknown" ? <Empty>Finish this step in the terminal, then close Settings.</Empty> : null}
      {form?.kind === "open-url" ? (
        <>
          <Link className="text-sm underline" href={form.url} target="_blank" rel="noreferrer">
            {shownName(form.description, form.url)}
          </Link>
          {form.paste === "" ? (
            <Button variant="secondary" onClick={() => answer({ kind: "opened", url: form.url })}>
              I opened it
            </Button>
          ) : (
            <TextField
              label={form.paste}
              inputClassName="mono"
              type={openUrlFieldType(form.paste, form.input)}
              value={pasted}
              aria-describedby={notice === "" ? undefined : noticeId}
              placeholder={form.paste}
              onChange={setPasted}
            />
          )}
        </>
      ) : null}
      {form?.kind === "input" ? (
        <TextField
          label={form.name}
          type={form.secret ? "password" : "text"}
          aria-describedby={notice === "" ? undefined : noticeId}
          value={pasted}
          onChange={setPasted}
        />
      ) : null}
      {form?.kind === "confirm" ? <p className="text-sm">{form.name}</p> : null}
      <div className="settings-actions">
        {form?.kind === "input" ? (
          <Button variant="secondary" onClick={() => answer({ kind: "text", input: pasted })}>
            Continue
          </Button>
        ) : null}
        {form?.kind === "confirm" ? (
          <Button variant="secondary" onClick={() => answer({ kind: "accept" })}>
            Confirm
          </Button>
        ) : null}
        {form?.kind === "open-url" && form.paste !== "" ? (
          <Button variant="secondary" onClick={() => answer({ kind: "text", input: pasted })}>
            Continue
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={() => {
            void request("ui/resolve", { pending: park.pending, kind: "cancel" }).then(onCancel, onCancel);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xl leading-[26px]">{title}</h3>
      {children}
    </section>
  );
}

function BotGroup({
  title,
  rows,
  onEdit,
  onRemove,
}: {
  readonly title: string;
  readonly rows: readonly { readonly name: string; readonly bot: BotFace }[];
  readonly onEdit: (name: string, bot: BotFace) => void;
  readonly onRemove: (name: string) => void;
}) {
  return (
    <Group title={title}>
      {rows.length === 0 ? <Empty>None.</Empty> : null}
      {rows.map(({ name, bot }) => (
        <article key={name} className="settings-row">
          <div className="settings-row-main">
            <div className="settings-grow">
              <p className="truncate text-sm font-strong">{shownName(bot.name, name)}</p>
              <p className="truncate text-sm text-muted">
                {shownName(bot.error ?? bot.description ?? bot.recipeScope, "")}
              </p>
              {mcpServerLine(bot.mcpJson) === "" ? null : (
                <p className="truncate text-sm text-muted">{mcpServerLine(bot.mcpJson)}</p>
              )}
            </div>
            <Button variant="ghost" aria-label={`Edit ${shownName(bot.name, name)}`} onClick={() => onEdit(name, bot)}>
              Edit
            </Button>
            <Button
              variant="secondary"
              aria-label={`Remove ${shownName(bot.name, name)}`}
              onClick={() => onRemove(name)}
            >
              Remove
            </Button>
          </div>
        </article>
      ))}
    </Group>
  );
}

type BotDraft = {
  readonly scope: "home" | "project";
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly recipeScope: "session" | "project" | "global";
  readonly tools: string;
  readonly skills: string;
  readonly keepAlive: boolean;
  readonly mcp: readonly McpGrantDraft[];
  readonly fresh: boolean;
};

function BotForm({
  draft,
  project,
  servers,
  onChange,
  onCancel,
  onSave,
}: {
  readonly draft: BotDraft;
  readonly project: string | null;
  readonly servers: readonly McpServerOption[];
  readonly onChange: (draft: BotDraft) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  return (
    <div className="settings-grid">
      <DropdownSelect
        label="Where"
        className="col-span-full"
        value={draft.scope}
        isDisabled={!draft.fresh}
        onChange={(value) => onChange({ ...draft, scope: value === "home" ? "home" : "project" })}
        options={[
          { id: "home", label: "Home" },
          { id: "project", label: "This project", isDisabled: project == null },
        ]}
      />
      <TextField
        label="Name"
        className="col-span-full"
        value={draft.name}
        isDisabled={!draft.fresh}
        spellCheck={false}
        onChange={(value) => onChange({ ...draft, name: value })}
      />
      <TextField
        label="Description"
        className="col-span-full"
        value={draft.description}
        onChange={(value) => onChange({ ...draft, description: value })}
      />
      <TextField
        label="Instructions"
        className="col-span-full"
        multiline
        rows={6}
        value={draft.instructions}
        onChange={(value) => onChange({ ...draft, instructions: value })}
      />
      <DropdownSelect
        label="Scope"
        className="col-span-full"
        value={draft.recipeScope}
        onChange={(value) =>
          onChange({ ...draft, recipeScope: value === "project" || value === "global" ? value : "session" })
        }
        options={[
          { id: "session", label: "Session" },
          { id: "project", label: "Project" },
          { id: "global", label: "Global" },
        ]}
      />
      <TextField
        label="Tools"
        className="col-span-full"
        value={draft.tools}
        spellCheck={false}
        placeholder="read_file, shell"
        onChange={(value) => onChange({ ...draft, tools: value })}
      />
      <TextField
        label="Skills"
        className="col-span-full"
        value={draft.skills}
        spellCheck={false}
        onChange={(value) => onChange({ ...draft, skills: value })}
      />
      <span />
      <Check label="Keep alive" checked={draft.keepAlive} onChange={(keepAlive) => onChange({ ...draft, keepAlive })} />
      <McpGrants draft={draft} project={project} servers={servers} onChange={onChange} />
      <div className="settings-actions" style={{ gridColumn: "1 / -1" }}>
        <Button variant="secondary" disabled={draft.name.trim() === ""} onClick={onSave}>
          Save bot
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return <TextField className="col-span-full" label={label} value={value} spellCheck={false} onChange={onChange} />;
}

function Check({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox isSelected={checked} onChange={onChange}>
      {label}
    </Checkbox>
  );
}

function Notice({ id, message }: { readonly id?: string; readonly message: string }) {
  if (message === "") return null;
  return (
    <p id={id} className="text-sm text-danger" role="status">
      {message}
    </p>
  );
}

function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-subtle">{children}</p>;
}

function kernelRequest(dial: ReturnType<typeof useDial>): Request | null {
  const port = dial.kernelRpc;
  return port == null ? null : (method, params) => port.request(method, params);
}

function connectionsOf(dial: ReturnType<typeof useDial>): Record<string, Conn> {
  return (dial.kernel?.root.connections ?? {}) as Record<string, Conn>;
}

function listedConnections(dial: ReturnType<typeof useDial>): (readonly [string, Conn])[] {
  return Object.entries(connectionsOf(dial)).filter(([id]) => !id.startsWith("__"));
}

function pluginsOf(dial: ReturnType<typeof useDial>): Record<string, PluginFace> {
  return (dial.kernel?.root.plugins ?? {}) as Record<string, PluginFace>;
}

function botsOf(root: { readonly bots?: Record<string, BotFace> } | null | undefined): Record<string, BotFace> {
  return root?.bots ?? {};
}

function openProject(dial: ReturnType<typeof useDial>): string | null {
  const target = dial.requestedTarget;
  if (target.kind === "project" || target.kind === "project-session") return target.path;
  return dial.project?.root.path ?? null;
}

function isMcp(spec: Conn): boolean {
  return spec.driver?.abilityClaim?.includes("mcp") === true;
}

function connectionDetail(
  account: { readonly description: string; readonly balance: string },
  state: string | null | undefined,
): string {
  const who = account.description === "…" ? "" : account.description;
  const line = [who, account.balance].filter((part) => part !== "").join(" · ");
  return line !== "" ? line : statusLabel(state);
}

function statusLabel(state: string | null | undefined): string {
  const value = shownName(state, "idle");
  if (value === "ready") return "Ready";
  if (value === "bootstrapping" || value === "connecting") return "Connecting";
  if (value === "failed") return "Failed";
  if (value === "idle") return "Idle";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shownName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

function draftFrom(name: string, bot: BotFace, scope: "home" | "project"): BotDraft {
  const recipe = bot.recipeScope === "project" || bot.recipeScope === "global" ? bot.recipeScope : "session";
  return {
    scope,
    name: shownName(bot.name, name),
    description: asText(bot.description),
    instructions: asText(bot.instructions),
    recipeScope: recipe,
    tools: (bot.tools ?? []).join(", "),
    skills: (bot.skills ?? []).join(", "),
    keepAlive: bot.keepAlive === true,
    mcp: mcpDrafts(bot.mcpJson),
    fresh: false,
  };
}

function McpGrants({
  draft,
  project,
  servers,
  onChange,
}: {
  readonly draft: BotDraft;
  readonly project: string | null;
  readonly servers: readonly McpServerOption[];
  readonly onChange: (draft: BotDraft) => void;
}) {
  const replace = (index: number, grant: McpGrantDraft) => {
    onChange({ ...draft, mcp: draft.mcp.map((row, at) => (at === index ? grant : row)) });
  };
  return (
    <div className="settings-mcp">
      <p className="text-sm text-muted">{mcpPoolCaption(draft.recipeScope, project ?? "")}</p>
      {draft.mcp.map((grant, index) => {
        const option = mcpOption(servers, grant.server);
        const choices = serverChoices(servers, grant.server);
        return (
          <fieldset key={`${grant.server}:${index}`} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="text-sm">{grant.server === "" ? "Server" : grant.server}</legend>
            <DropdownSelect
              label="Server"
              value={grant.server}
              onChange={(value) => replace(index, { ...grant, server: String(value ?? "") })}
              options={choices.map((choice) => ({ id: choice.server, label: choice.server }))}
            />
            <TextField
              label="Server tools"
              className="col-span-full"
              value={grant.tools}
              spellCheck={false}
              placeholder={mcpHint(option, "tools")}
              onChange={(value) => replace(index, { ...grant, tools: value })}
            />
            <TextField
              label="Account"
              className="col-span-full"
              value={grant.account}
              spellCheck={false}
              placeholder={mcpHint(option, "account")}
              onChange={(value) => replace(index, { ...grant, account: value })}
            />
            <TextField
              label="Session"
              className="col-span-full"
              value={grant.session}
              spellCheck={false}
              placeholder={mcpHint(option, "session")}
              onChange={(value) => replace(index, { ...grant, session: value })}
            />
            <Button
              variant="ghost"
              onClick={() => onChange({ ...draft, mcp: draft.mcp.filter((_, at) => at !== index) })}
            >
              Remove server
            </Button>
          </fieldset>
        );
      })}
      <Button
        variant="secondary"
        disabled={servers.length === 0}
        onClick={() => {
          if (servers.length === 0) return;
          const first = servers[0];
          onChange({
            ...draft,
            mcp: [...draft.mcp, { server: first.server, tools: "", account: "", session: "" }],
          });
        }}
      >
        Add server
      </Button>
    </div>
  );
}

type RuntimeDraft = {
  compact: string;
  hard: string;
  soft: string;
  keep: string;
  glow: string;
  classifier: string;
  throttle: string;
  speculative: string;
  tail: string;
  statusline: string;
  refresh: string;
  superKey: "ctrl" | "cmd";
  hideFloor: boolean;
  textOnly: boolean;
};

function runtimeDraft(root: unknown): RuntimeDraft {
  const record = root as
    | {
        compactStrategy?: string;
        compactTriggers?: { hard?: string; soft?: string };
        compactKeepTurns?: number;
        contextGlowRemaining?: string;
        autoModeClassifier?: string;
        approvalAskThrottleMs?: number;
        speculativePolicyProcessingTools?: number;
        shellTailBytes?: number;
        statusline?: string;
        statuslineRefresh?: string;
        superKey?: string;
        hideFloorTools?: boolean;
        reActLoopIntentDetectedTrigger?: { enabled?: boolean };
      }
    | undefined;
  return {
    compact: asText(record?.compactStrategy),
    hard: asText(record?.compactTriggers?.hard),
    soft: asText(record?.compactTriggers?.soft),
    keep: String(record?.compactKeepTurns ?? 1),
    glow: asText(record?.contextGlowRemaining),
    classifier: asText(record?.autoModeClassifier),
    throttle: String(record?.approvalAskThrottleMs ?? 0),
    speculative: String(record?.speculativePolicyProcessingTools ?? 0),
    tail: String(record?.shellTailBytes ?? 0),
    statusline: asText(record?.statusline),
    refresh: asText(record?.statuslineRefresh),
    superKey: record?.superKey === "cmd" ? "cmd" : "ctrl",
    hideFloor: record?.hideFloorTools === true,
    textOnly: record?.reActLoopIntentDetectedTrigger?.enabled !== false,
  };
}

function parkOf(result: unknown): Park | null {
  if (result == null || typeof result !== "object") return null;
  if (!("form" in result) || result.form !== "ui") return null;
  if (!("pending" in result) || typeof result.pending !== "string") return null;
  if (!("body" in result) || typeof result.body !== "string") return null;
  return { pending: result.pending, body: result.body };
}

function isSkillList(result: unknown): result is { skills: SkillRow[] } {
  return result != null && typeof result === "object" && "skills" in result && Array.isArray(result.skills);
}

function failureOf(result: unknown): string {
  if (result == null || typeof result !== "object") return "";
  if ("ok" in result && result.ok === false) {
    return "error" in result && typeof result.error === "string" ? result.error : "Not accepted.";
  }
  return "";
}

async function ask(request: Request | null, method: string, params: unknown): Promise<string> {
  if (request == null) return "The daemon is not connected.";
  try {
    return failureOf(await request(method, params));
  } catch (error) {
    return error instanceof Error ? error.message : "Not accepted.";
  }
}

function report(setNotice: (message: string) => void, error: unknown): undefined {
  setNotice(error instanceof Error ? error.message : "Not accepted.");
  return undefined;
}
