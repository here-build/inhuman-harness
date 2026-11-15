import { useEffect, useState } from "react";
import { DropdownSelect } from "@inhuman.tools/harness-ui/primitives/anchored";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { TextField } from "@inhuman.tools/harness-ui/primitives/text-field";
import { observer } from "mobx-react-lite";

import {
  ask,
  Empty,
  failureOf,
  isSkillList,
  kernelRequest,
  Notice,
  openProject,
  report,
  type SkillRow,
} from "./shared.js";
import { useDial } from "../../client/context.js";

/** Home and project skills editor and list view. */
export const Skills = observer(function SkillsView() {
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
