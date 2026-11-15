import { useState } from "react";
import { DropdownSelect } from "@inhuman.tools/harness-ui/primitives/anchored";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { TextField } from "@inhuman.tools/harness-ui/primitives/text-field";
import { observer } from "mobx-react-lite";

import { useDial } from "../../client/context.js";
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
} from "../bot-mcp.js";
import {
  asText,
  ask,
  botsOf,
  Check,
  connectionsOf,
  Empty,
  Group,
  kernelRequest,
  Notice,
  openProject,
  shownName,
  splitList,
  type BotFace,
} from "./shared.js";

/** Home and project custom bots editor and list view. */
export const Bots = observer(function BotsView() {
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
