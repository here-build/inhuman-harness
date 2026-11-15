import { useState } from "react";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { Checkbox } from "@inhuman.tools/harness-ui/primitives/checkbox";
import { TextField } from "@inhuman.tools/harness-ui/primitives/text-field";
import { observer } from "mobx-react-lite";

import { ask, Empty, kernelRequest, Notice, pluginsOf } from "./shared.js";
import { useDial } from "../../client/context.js";

const DEFAULT_PLUGINS = [
  {
    name: "tasks",
    npmName: "@inhuman.tools/plugin-tasks",
    description: "Session notebook pages with a frozen exam, and project promotion of an accepted task.",
  },
  {
    name: "fusion",
    npmName: "@inhuman.tools/plugin-fusion",
    description: "Session planner. One round-end note fuses the plan with a granted memory read.",
  },
  {
    name: "inhuman-plugin-goal",
    npmName: "@inhuman.tools/plugin-goal",
    description: "Single-session goal. The foreground hook continues it. /goal is a command file.",
  },
  {
    name: "offload-tingle",
    npmName: "@inhuman.tools/plugin-offload-tingle",
    description: "Cited project memory. Writer commits; scout searches. SQLite is an optional adapter.",
  },
] as const;

/** Installed and bundled plugins management view. */
export const Plugins = observer(function PluginsView() {
  const dial = useDial();
  const request = kernelRequest(dial);
  const [notice, setNotice] = useState("");
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const plugins = Object.values(pluginsOf(dial));
  const installedNames = new Set(plugins.map((plugin) => plugin.pluginName ?? ""));
  const installedNpm = new Set(plugins.map((plugin) => plugin.sourceNpm ?? ""));
  const missingDefaults = DEFAULT_PLUGINS.filter(
    (seed) => !installedNames.has(seed.name) && !installedNpm.has(seed.npmName),
  );
  const run = (name: string, patch: { enabled?: boolean; foreground?: boolean }) => {
    setNotice("");
    void ask(request, "plugin/set", { name, ...patch }).then(setNotice);
  };
  const install = (targetSpec: string, clearDraft = false) => {
    const trimmed = targetSpec.trim();
    if (trimmed === "") return;
    setNotice("");
    setBusy(true);
    void ask(request, "plugin/install", { spec: trimmed })
      .then((error) => {
        setNotice(error);
        if (error === "" && clearDraft) setSpec("");
        return undefined;
      })
      .finally(() => setBusy(false));
  };
  const remove = (name: string) => {
    setNotice("");
    setBusy(true);
    void ask(request, "plugin/remove", { name })
      .then(setNotice)
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Notice message={notice} />
      {plugins.length === 0 ? <Empty>No plugin is installed.</Empty> : null}
      <div className="settings-list">
        {plugins.map((plugin) => {
          const name = plugin.pluginName ?? "";
          const provenance = [plugin.sourceNpm, plugin.sourceVersion]
            .filter((part) => part != null && part !== "")
            .join(" ");
          return (
            <article key={name} className="settings-row">
              <div className="settings-row-main">
                <div className="settings-grow">
                  <p className="truncate text-sm font-strong">{name}</p>
                  {plugin.description ? <p className="truncate text-sm text-muted">{plugin.description}</p> : null}
                  {provenance !== "" ? (
                    <p className={`truncate text-sm ${plugin.description ? "text-subtle" : "text-muted"}`}>
                      {provenance}
                    </p>
                  ) : null}
                  {plugin.problem ? <p className="text-sm text-warning">{plugin.problem}</p> : null}
                </div>
              </div>
              <Checkbox
                isSelected={plugin.enabled !== false}
                isDisabled={request == null || name === "" || busy}
                aria-label={`${name} enabled`}
                onChange={(enabled) => run(name, { enabled })}
              >
                Enabled
              </Checkbox>
              <Checkbox
                isSelected={plugin.foreground !== false}
                isDisabled={request == null || name === "" || busy}
                aria-label={`${name} foreground bot`}
                onChange={(foreground) => run(name, { foreground })}
              >
                Foreground bot
              </Checkbox>
              <Button
                variant="secondary"
                disabled={request == null || name === "" || busy}
                aria-label={`Remove ${name}`}
                onClick={() => remove(name)}
              >
                Remove
              </Button>
            </article>
          );
        })}
      </div>
      {missingDefaults.length > 0 ? (
        <div className="settings-list">
          {missingDefaults.map((seed) => (
            <article key={seed.npmName} className="settings-row">
              <div className="settings-row-main">
                <div className="settings-grow">
                  <p className="truncate text-sm font-strong">{seed.name}</p>
                  <p className="truncate text-sm text-muted">{seed.description}</p>
                  <p className="truncate text-sm text-subtle">{seed.npmName}</p>
                </div>
              </div>
              <Button
                variant="secondary"
                disabled={request == null || busy}
                aria-label={`Install ${seed.name}`}
                onClick={() => install(seed.npmName)}
              >
                Install
              </Button>
            </article>
          ))}
        </div>
      ) : null}
      <div className="settings-grid">
        <TextField
          label="Package or path"
          className="col-span-full"
          value={spec}
          spellCheck={false}
          placeholder="@scope/plugin or file:///…"
          onChange={setSpec}
        />
      </div>
      <Button
        variant="secondary"
        disabled={request == null || busy || spec.trim() === ""}
        onClick={() => install(spec, true)}
      >
        Install plugin
      </Button>
    </>
  );
});
