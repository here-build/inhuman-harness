import { useEffect, useId, useState } from "react";
import {
  ReconnectDoorBlock,
  SettingsFactList,
  type SettingsFactItem,
  providerRows,
  type ConnectStart,
  accountWindowLines,
  wireAccount,
} from "@inhuman.tools/harness-ui";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { Checkbox } from "@inhuman.tools/harness-ui/primitives/checkbox";
import { TextField } from "@inhuman.tools/harness-ui/primitives/text-field";
import { observer } from "mobx-react-lite";

import { useDial } from "../../client/context.js";
import { ConnectStep, connectPort } from "../connect-step.js";
import {
  asText,
  ConnectionRow,
  Empty,
  failureOf,
  isMcp,
  isRecord,
  listedConnections,
  Notice,
  ParkFollow,
  parkOf,
  report,
  shownName,
  statusLabel,
  Success,
  useConnectionRun,
  useLiveToggle,
  type Conn,
  type Park,
} from "./shared.js";

/** Combined view of all configured model providers and MCP servers. */
export const AllConnections = observer(function AllConnectionsView() {
  const dial = useDial();
  const noticeId = useId();
  const { request, notice, setNotice, success, run, reconnect, flow } = useConnectionRun();
  const [adding, setAdding] = useState<"" | "pick" | "model" | "mcp">("");
  const [endpoint, setEndpoint] = useState("");
  const [adopting, setAdopting] = useState(false);
  const [park, setPark] = useState<Park | null>(null);
  const rows = listedConnections(dial);
  const closeAdd = () => {
    setAdding("");
    setEndpoint("");
  };
  if (flow != null) return flow;
  if (adding === "model") return <AddModel onDone={closeAdd} />;
  if (park != null && request != null) {
    return (
      <ParkFollow
        park={park}
        request={request}
        onPark={setPark}
        onDone={() => {
          setPark(null);
          closeAdd();
        }}
        onCancel={() => setPark(null)}
      />
    );
  }
  const adoptMcp = () => {
    if (request == null || adopting || endpoint.trim() === "") return;
    setNotice("");
    setAdopting(true);
    void request("mcp-server/adopt", { input: endpoint.trim() }).then(
      (result) => {
        setAdopting(false);
        const next = parkOf(result);
        if (next != null) {
          setPark(next);
          return undefined;
        }
        const failure = failureOf(result);
        setNotice(failure);
        if (failure === "") closeAdd();
        return undefined;
      },
      (error: unknown) => {
        setAdopting(false);
        return report(setNotice, error);
      },
    );
  };
  return (
    <>
      <Notice id={noticeId} message={notice} />
      <Success message={success} />
      <div className="settings-actions">
        <Button
          variant="secondary"
          disabled={request == null}
          aria-expanded={adding !== ""}
          onClick={() => setAdding((open) => (open === "" ? "pick" : ""))}
        >
          Add connection
        </Button>
        {adding !== "" ? (
          <>
            <Button variant="ghost" onClick={() => setAdding("model")}>
              Model provider
            </Button>
            <Button
              variant="ghost"
              aria-current={adding === "mcp" ? "true" : undefined}
              onClick={() => setAdding("mcp")}
            >
              MCP server
            </Button>
          </>
        ) : null}
      </div>
      {adding === "mcp" ? (
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
          <Button className="mt-2" variant="secondary" disabled={adopting || endpoint.trim() === ""} onClick={adoptMcp}>
            Connect
          </Button>
        </div>
      ) : null}
      <p className="text-sm text-muted">
        {rows.length === 0 ? "No connection yet." : `${rows.length} connection${rows.length === 1 ? "" : "s"}.`}
      </p>
      <div className="settings-list">
        {rows.map(([id, spec]) => (
          <ConnectionCard key={id} id={id} spec={spec} disabled={request == null} onRun={run} onReconnect={reconnect} />
        ))}
      </div>
    </>
  );
});

function ConnectionCard({
  id,
  spec,
  disabled,
  onRun,
  onReconnect,
}: {
  readonly id: string;
  readonly spec: Conn;
  readonly disabled: boolean;
  readonly onRun: (method: string, params: unknown) => Promise<string>;
  readonly onReconnect: (id: string, name: string) => Promise<void>;
}) {
  const driver = shownName(spec.driver?.name, "unknown");
  const account = wireAccount(spec, driver);
  const name = shownName(spec.name, id);
  const configuration = spec.configuration ?? {};
  const enabled = useLiveToggle(configuration.enabled !== false, (next) =>
    onRun("connect/set-enabled", { id, enabled: next }),
  );
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const act = (method: string, params: unknown) => {
    setBusy(true);
    void onRun(method, params).then(() => setBusy(false));
  };
  const status = !enabled.checked ? "Disabled" : account.needsAuth ? "Needs auth" : statusLabel(spec.readyState);
  const live = spec.live ?? {};
  const identity = isRecord(live.identity) ? live.identity : {};
  const tools = Array.isArray(live.tools) ? live.tools.length : null;
  const httpMcp = spec.driver?.name === "mcp-http" || spec.driver?.importPath === "mcp-http";
  const settings = Object.entries(configuration).filter(([key]) => key !== "secrets" && key !== "enabled");
  const facts: (readonly [string, string])[] = [
    ["Id", id],
    ["Driver", driver],
    ["Abilities", (spec.driver?.abilityClaim ?? []).join(", ")],
    ["Status", status],
    ["Signed in as", account.name],
    ["Email", asText(identity.email)],
    ["Plan", asText(identity.plan)],
    ["Key", asText(live.keyMask)],
    ["Balance", account.balance],
    [
      "Quota",
      accountWindowLines(account, Date.now())
        .map((line) => line.text)
        .join("; "),
    ],
    ["Tools", tools == null ? "" : String(tools)],
    ["Error", shownName(account.detail, asText(spec.error))],
  ];
  const factItems: SettingsFactItem[] = [
    ...facts.filter(([, value]) => value !== "").map(([label, value]) => ({ label, value })),
    ...settings.map(([key, value]) => ({
      key: `setting:${key}`,
      label: key,
      value: typeof value === "string" ? value : JSON.stringify(value),
      mono: true,
    })),
  ];
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-grow">
          <div className="text-sm font-strong">{name}</div>
          <div className={account.failed ? "text-sm text-danger" : "text-sm text-muted"}>
            {[driver, status, account.description].filter((part) => part !== "" && part !== "…").join(" · ")}
          </div>
        </div>
        <Checkbox isSelected={enabled.checked} isDisabled={disabled || busy} onChange={enabled.toggle}>
          Enabled
        </Checkbox>
      </div>
      {account.failed ? (
        <ReconnectDoorBlock
          name={name}
          account={account}
          disabled={disabled || busy}
          onReconnect={() => onReconnect(id, name)}
        />
      ) : null}
      <SettingsFactList facts={factItems} />
      <div className="settings-actions">
        {httpMcp && !account.failed ? (
          <Button variant="ghost" disabled={disabled || busy} onClick={() => act("connect/logout", { id })}>
            Log out
          </Button>
        ) : null}
        {removing ? (
          <>
            <Button
              variant="danger"
              disabled={disabled || busy}
              aria-label={`Confirm removing ${name}`}
              onClick={() => {
                setRemoving(false);
                act("connect/drop", { id, confirm: true });
              }}
            >
              Remove {name} and its secrets
            </Button>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            className="text-danger"
            disabled={disabled || busy}
            aria-label={`Remove ${name}`}
            onClick={() => setRemoving(true)}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

/** Completion model provider connections management view. */
export const Connections = observer(function ConnectionsView() {
  const dial = useDial();
  const { request, notice, success, run, reconnect, flow } = useConnectionRun();
  const [adding, setAdding] = useState(false);
  const models = listedConnections(dial).filter(([, spec]) => !isMcp(spec));
  if (flow != null) return flow;
  if (adding) return <AddModel onDone={() => setAdding(false)} />;
  return (
    <>
      <Notice message={notice} />
      <Success message={success} />
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
          <ConnectionRow key={id} id={id} spec={spec} disabled={request == null} onRun={run} onReconnect={reconnect} />
        ))}
      </div>
    </>
  );
});

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
