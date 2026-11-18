import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { ReconnectDoorBlock, mcpLoginLine, SwipeRow, type SwipeAction, wireAccount } from "@inhuman.tools/harness-ui";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { Checkbox } from "@inhuman.tools/harness-ui/primitives/checkbox";
import { Link } from "@inhuman.tools/harness-ui/primitives/navigation";
import { TextField } from "@inhuman.tools/harness-ui/primitives/text-field";

import { useDial } from "../../client/context.js";
import { parsePark, openUrlFieldType, type ParkForm } from "../connect-park.js";
import type { Request } from "../connect-step.js";

export const SECTIONS = [
  ["connections", "Connections"],
  ["models", "Models"],
  ["web", "Web"],
  ["mcp", "MCP"],
  ["plugins", "Plugins"],
  ["skills", "Skills"],
  ["bots", "Bots"],
  ["permissions", "Permissions"],
  ["runtime", "Runtime"],
] as const;

export type Section = (typeof SECTIONS)[number][0];

export type Conn = {
  readonly name?: string;
  readonly readyState?: string | null;
  readonly error?: string;
  readonly configuration?: { readonly [key: string]: unknown };
  readonly live?: {
    readonly auth?: unknown;
    readonly identity?: unknown;
    readonly keyMask?: unknown;
    readonly account?: unknown;
    readonly tools?: unknown;
  };
  readonly driver?: {
    readonly name?: string;
    readonly importPath?: string;
    readonly abilityClaim?: readonly string[];
  } | null;
};

export type PluginFace = {
  readonly pluginName?: string;
  readonly description?: string;
  readonly sourceNpm?: string;
  readonly sourceVersion?: string;
  readonly enabled?: boolean;
  readonly foreground?: boolean;
  readonly problem?: string | null;
};

export type BotFace = {
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

export type SkillRow = {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly invoke: string;
  readonly scope: "project" | "home";
};

export type Park = { readonly pending: string; readonly body: string };

type Reconnecting = { readonly id: string; readonly name: string; readonly park: Park };

export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function kernelRequest(dial: ReturnType<typeof useDial>): Request | null {
  const port = dial.kernelRpc;
  return port == null ? null : (method, params) => port.request(method, params);
}

export function connectionsOf(dial: ReturnType<typeof useDial>): Record<string, Conn> {
  return (dial.kernel?.root.connections ?? {}) as Record<string, Conn>;
}

export function listedConnections(dial: ReturnType<typeof useDial>): (readonly [string, Conn])[] {
  return Object.entries(connectionsOf(dial)).filter(([id]) => !id.startsWith("__"));
}

export function pluginsOf(dial: ReturnType<typeof useDial>): Record<string, PluginFace> {
  return (dial.kernel?.root.plugins ?? {}) as Record<string, PluginFace>;
}

export function botsOf(root: { readonly bots?: Record<string, BotFace> } | null | undefined): Record<string, BotFace> {
  return root?.bots ?? {};
}

export function openProject(dial: ReturnType<typeof useDial>): string | null {
  const target = dial.requestedTarget;
  if (target.kind === "project" || target.kind === "project-session") return target.path;
  return dial.project?.root.path ?? null;
}

export function isMcp(spec: Conn): boolean {
  return spec.driver?.abilityClaim?.includes("mcp") === true;
}

/** A connection that serves web search or page extract, possibly among other abilities. */
export function isWeb(spec: Conn): boolean {
  const can = spec.driver?.abilityClaim ?? [];
  return can.includes("web-search") || can.includes("web-extract");
}

/** Web-only connections live in the Web section, not the model or MCP lists. */
export function isWebOnly(spec: Conn): boolean {
  const can = spec.driver?.abilityClaim ?? [];
  return isWeb(spec) && !can.includes("completion") && !can.includes("mcp");
}

export function connectionDetail(
  account: { readonly description: string; readonly balance: string },
  state: string | null | undefined,
): string {
  const who = account.description === "…" ? "" : account.description;
  const line = [who, account.balance].filter((part) => part !== "").join(" · ");
  return line !== "" ? line : statusLabel(state);
}

export function statusLabel(state: string | null | undefined): string {
  const value = shownName(state, "idle");
  if (value === "ready") return "Ready";
  if (value === "bootstrapping" || value === "connecting") return "Connecting";
  if (value === "failed") return "Failed";
  if (value === "idle") return "Idle";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function shownName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

export function parkOf(result: unknown): Park | null {
  if (result == null || typeof result !== "object") return null;
  if (!("form" in result) || result.form !== "ui") return null;
  if (!("pending" in result) || typeof result.pending !== "string") return null;
  if (!("body" in result) || typeof result.body !== "string") return null;
  return { pending: result.pending, body: result.body };
}

export function isSkillList(result: unknown): result is { skills: SkillRow[] } {
  return result != null && typeof result === "object" && "skills" in result && Array.isArray(result.skills);
}

export function failureOf(result: unknown): string {
  if (result == null || typeof result !== "object") return "";
  if ("ok" in result && result.ok === false) {
    return "error" in result && typeof result.error === "string" ? result.error : "Not accepted.";
  }
  return "";
}

export async function ask(request: Request | null, method: string, params: unknown): Promise<string> {
  if (request == null) return "The daemon is not connected.";
  try {
    return failureOf(await request(method, params));
  } catch (error) {
    return error instanceof Error ? error.message : "Not accepted.";
  }
}

export function report(setNotice: (message: string) => void, error: unknown): undefined {
  setNotice(error instanceof Error ? error.message : "Not accepted.");
  return undefined;
}

export function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xl leading-[26px]">{title}</h3>
      {children}
    </section>
  );
}

export function Field({
  label,
  value,
  numeric = false,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly numeric?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <TextField
      className="col-span-full"
      label={label}
      value={value}
      spellCheck={false}
      inputMode={numeric ? "numeric" : undefined}
      onChange={onChange}
    />
  );
}

export function Check({
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

export function Notice({ id, message }: { readonly id?: string; readonly message: string }) {
  if (message === "") return null;
  return (
    <p id={id} className="text-sm text-danger" role="status">
      {message}
    </p>
  );
}

export function Success({ message }: { readonly message: string }) {
  if (message === "") return null;
  return (
    <p className="text-sm text-muted" role="status">
      {message}
    </p>
  );
}

export function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-subtle">{children}</p>;
}

/** The switch moves immediately. The kernel value replaces it when the write lands. */
export function useLiveToggle(live: boolean, apply: (next: boolean) => Promise<string>) {
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

export function ParkFollow({
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

export function useConnectionRun() {
  const request = kernelRequest(useDial());
  const [notice, setNotice] = useState("");
  const [success, setSuccess] = useState("");
  const [reconnecting, setReconnecting] = useState<Reconnecting | null>(null);
  /** Re-runs the driver's sign-in for one connection and follows each step it parks on. */
  const reconnect = useCallback(
    (id: string, name: string): Promise<void> => {
      setNotice("");
      setSuccess("");
      if (request == null) {
        setNotice("The daemon is not connected.");
        return Promise.resolve();
      }
      return request("connect/login", { id }).then(
        (result) => {
          const park = parkOf(result);
          if (park != null) setReconnecting({ id, name, park });
          else if (failureOf(result) !== "") setNotice(`Couldn’t reconnect ${name}: ${failureOf(result)}`);
          else setSuccess(`${name} is connected again.`);
          return undefined;
        },
        (error: unknown) => {
          setNotice(`Couldn’t reconnect ${name}: ${error instanceof Error ? error.message : "not accepted."}`);
          return undefined;
        },
      );
    },
    [request],
  );
  const flow =
    reconnecting != null && request != null ? (
      <div className="settings-list">
        <p className="text-sm font-strong">Reconnecting {reconnecting.name}</p>
        <p className="text-sm text-muted">Follow the steps below. The connection keeps its settings and id.</p>
        <ParkFollow
          park={reconnecting.park}
          request={request}
          onPark={(park) => setReconnecting({ ...reconnecting, park })}
          onDone={() => {
            setSuccess(`${reconnecting.name} is connected again.`);
            setReconnecting(null);
          }}
          onCancel={() => {
            setNotice(`Reconnect of ${reconnecting.name} was cancelled. It stays signed out.`);
            setReconnecting(null);
          }}
        />
      </div>
    ) : null;
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
  return { request, notice, setNotice, success, run, reconnect, flow };
}

export function ConnectionRow({
  id,
  spec,
  mcp = false,
  disabled,
  onRun,
  onReconnect,
}: {
  readonly id: string;
  readonly spec: Conn;
  readonly mcp?: boolean;
  readonly disabled: boolean;
  readonly onRun: (method: string, params: unknown) => Promise<string>;
  readonly onReconnect: (id: string, name: string) => Promise<void>;
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
      ? { label: "Log in", name: `Log in to ${name}`, tone: "action", onPress: () => onReconnect(id, name) }
      : { label: "Log out", name: `Log out of ${name}`, tone: "quiet", onPress: () => act("connect/logout", { id }) }
    : undefined;
  const row = (
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
  if (!account.failed) return row;
  return (
    <div className="flex flex-col gap-2">
      {row}
      <ReconnectDoorBlock
        name={name}
        account={account}
        disabled={disabled || busy}
        onReconnect={() => onReconnect(id, name)}
      />
    </div>
  );
}
