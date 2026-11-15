import { useId, useState } from "react";
import { RegistrySearchBlock as RegistrySearch } from "@inhuman.tools/harness-ui";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { TextField } from "@inhuman.tools/harness-ui/primitives/text-field";
import { observer } from "mobx-react-lite";

import {
  ConnectionRow,
  failureOf,
  isMcp,
  listedConnections,
  Notice,
  ParkFollow,
  parkOf,
  report,
  Success,
  useConnectionRun,
  type Park,
} from "./shared.js";
import { useDial } from "../../client/context.js";

/** MCP server connections and official-registry search view. */
export const McpServers = observer(function McpView() {
  const dial = useDial();
  const noticeId = useId();
  const { request, notice, setNotice, success, run, reconnect, flow } = useConnectionRun();
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
  if (flow != null) return flow;
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
      <Success message={success} />
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
          <ConnectionRow
            key={id}
            id={id}
            spec={spec}
            mcp
            disabled={request == null}
            onRun={run}
            onReconnect={reconnect}
          />
        ))}
      </div>
    </>
  );
});
