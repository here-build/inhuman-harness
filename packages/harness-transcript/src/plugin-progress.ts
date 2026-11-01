import type { ProgressItem } from "../../harness-web-app/src/shell/tape-read.js";

export type PluginSnapshot = Readonly<Record<string, string>>;
type Action = Readonly<Record<string, unknown>>;
type TaskStatus = "pending" | "active" | "limbo" | "completed" | "dropped";
type Page = {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  status: TaskStatus;
  readonly preds: string[];
  reason: string;
};
type Goal = {
  readonly text: string;
  readonly status: "none" | "active" | "exhausted" | "blocked";
  readonly loops: number;
};

// sessionStateKey = manifest plugin name + namespace (not the npm package name).
const TASKS = "tasks:state";
const GOAL = "inhuman-plugin-goal:state";

function actionLog(json: string | undefined): readonly Action[] | null {
  if (json === undefined) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return null;
    if (
      value.some(
        (action) =>
          action == null || typeof action !== "object" || Array.isArray(action) || typeof action.type !== "string",
      )
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** A replacement/truncated log is a rewind, not new work. Never invent events across that boundary. */
function logs(previous: PluginSnapshot, current: PluginSnapshot, owner: string) {
  const before = actionLog(previous[owner]);
  const after = actionLog(current[owner]);
  if (before == null || after == null || before.length > after.length) return null;
  if (before.some((action, index) => JSON.stringify(action) !== JSON.stringify(after[index]))) return null;
  return { after, offset: before.length };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Mirrors plugins/inhuman-plugin-tasks/behavior/session.scm, including reducer no-ops. */
function taskAction(pages: Page[], action: Action): ProgressItem[] {
  const id = text(action["task-id"]);
  const page = pages.find((candidate) => candidate.id === id);
  const items: ProgressItem[] = [];
  const item = (target: Page, detail: string): void => {
    items.push({ id: target.id, label: target.subject || target.id, detail });
  };
  const status = (target: Page, next: TaskStatus): void => {
    target.status = next;
    item(target, next);
  };
  if (action.type === "create") {
    if (id === "" || page != null) return items;
    const created: Page = {
      id,
      subject: text(action.subject),
      description: text(action.description),
      status: "pending",
      preds: [],
      reason: "",
    };
    pages.push(created);
    item(created, created.description === "" ? "pending" : `pending · ${created.description}`);
  } else if (page != null) {
    switch (action.type) {
      case "start":
        if (page.status !== "pending") break;
        for (const prior of pages) if (prior.status === "active") status(prior, "pending");
        status(page, "active");
        break;
      case "limbo":
        if (page.status === "active") status(page, "limbo");
        break;
      case "verdict":
        if ((page.status === "active" || page.status === "limbo") && typeof action.ok === "boolean") {
          status(page, action.ok ? "completed" : "pending");
        }
        break;
      case "drop":
        if (page.status === "completed" || page.status === "dropped") break;
        page.status = "dropped";
        page.reason = text(action.reason);
        item(page, page.reason === "" ? "dropped" : `dropped · ${page.reason}`);
        break;
      case "after": {
        const pred = pages.find((candidate) => candidate.id === action.after);
        if (
          pred == null ||
          pred === page ||
          page.status === "completed" ||
          page.status === "dropped" ||
          page.preds.includes(pred.id)
        )
          break;
        page.preds.push(pred.id);
        item(page, `after ${pred.subject || pred.id}`);
        break;
      }
    }
  }
  return items;
}

/** Mirrors plugins/inhuman-plugin-goal/behavior/session.scm; exhaustion is not completion. */
function goalAction(state: Goal, action: Action): Goal {
  switch (action.type) {
    case "set":
      return typeof action.text === "string" && typeof action.loops === "number"
        ? { text: action.text, status: "active", loops: action.loops }
        : state;
    case "tick":
      return { ...state, status: state.loops > 1 ? "active" : "exhausted", loops: Math.max(0, state.loops - 1) };
    case "block":
      return { ...state, status: "blocked" };
    case "clear":
      return { text: "", status: "none", loops: 0 };
    default:
      return state;
  }
}

/**
 * Replay the committed logs, emitting each state transition in the appended suffix.
 * Owners have independent logs: their relative ordering is fixed here, not a global chronology.
 * IDs use the owner and absolute action index; a start's demotion also names its page.
 */
export function pluginProgress(previous: PluginSnapshot, current: PluginSnapshot): ProgressItem[] {
  const items: ProgressItem[] = [];
  const tasks = logs(previous, current, TASKS);
  if (tasks != null) {
    const pages: Page[] = [];
    for (const [index, action] of tasks.after.entries()) {
      const changes = taskAction(pages, action);
      if (index >= tasks.offset) {
        items.push(...changes.map((item) => ({ ...item, id: `${TASKS}:${index}:${item.id}` })));
      }
    }
  }
  const goal = logs(previous, current, GOAL);
  if (goal != null) {
    let state: Goal = { text: "", status: "none", loops: 0 };
    for (const [index, action] of goal.after.entries()) {
      const next = goalAction(state, action);
      if (
        index >= goal.offset &&
        (next.text !== state.text || next.status !== state.status || next.loops !== state.loops)
      ) {
        items.push({
          id: `${GOAL}:${index}`,
          label: "Goal",
          detail:
            next.status === "none"
              ? "cleared"
              : `${next.status} · ${next.loops} loops left${next.text === "" ? "" : ` · ${next.text}`}`,
        });
      }
      state = next;
    }
  }
  return items;
}
