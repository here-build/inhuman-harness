import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react-lite";

import {
  explain,
  loadPermissions,
  permissionsView,
  revokeRow,
  type ExplainLines,
  type PermissionsData,
  type PermissionsView,
  type StoredRow,
} from "./permissions-view.js";
import { useDial } from "../client/context.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

function Badge({ layer }: { readonly layer: string }) {
  return (
    <span className="layer-badge" data-layer={layer}>
      {layer}
    </span>
  );
}

function StoredList({
  title,
  rows,
  empty,
  busy,
  onRevoke,
}: {
  readonly title: string;
  readonly rows: readonly StoredRow[];
  readonly empty: string;
  readonly busy: boolean;
  readonly onRevoke: (row: StoredRow) => void;
}) {
  return (
    <section className="settings-list" aria-label={title}>
      <h3 className="text-sm font-strong">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-subtle">{empty}</p> : null}
      {rows.map((row) => (
        <article key={row.id} className="settings-row">
          <div className="settings-row-main">
            <div className="settings-grow">
              <p className="text-sm font-strong break-words">{row.label}</p>
              <p className="text-sm text-muted">
                {row.scope} · created {row.created} · {row.expires} · {row.source}
              </p>
            </div>
            {row.revocable ? (
              <Button
                variant="secondary"
                disabled={busy}
                aria-label={`Revoke ${row.label}`}
                onClick={() => onRevoke(row)}
              >
                Revoke
              </Button>
            ) : (
              <span className="text-sm text-subtle">in settings</span>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}

/** The sections, painted from a view. State and RPC live in `PermissionsPanel`. */
export function PermissionsBody({
  view,
  busy,
  onRevoke,
  children,
}: {
  readonly view: PermissionsView;
  readonly busy: boolean;
  readonly onRevoke: (row: StoredRow) => void;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      {view.warnings.map((warning) => (
        <p key={warning} className="text-sm text-warning" role="status">
          {warning}
        </p>
      ))}
      <section aria-label="Mode and classes">
        <h3 className="text-sm font-strong">
          Mode: <span className="permissions-mode">{view.mode}</span>
        </h3>
        <table className="permissions-table">
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">Ask</th>
              <th scope="col">Soft-deny</th>
            </tr>
          </thead>
          <tbody>
            {view.classes.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="mono">
                  {row.id}
                </th>
                <td title={row.ask.title}>
                  {row.ask.text} <Badge layer={row.ask.layer} />
                </td>
                <td title={row.softDeny.title}>
                  {row.softDeny.text} <Badge layer={row.softDeny.layer} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <StoredList title="Stored grants" rows={view.grants} empty="No stored grants." busy={busy} onRevoke={onRevoke} />
      <section className="settings-list" aria-label="Flags in force">
        <h3 className="text-sm font-strong">Needs acknowledgement</h3>
        {view.flags.length === 0 ? <p className="text-sm text-subtle">No flags in force.</p> : null}
        {view.flags.map((flag) => (
          <p key={`${flag.layer}\0${flag.label}`} className="text-sm break-words">
            {flag.label} <Badge layer={flag.layer} />
            {flag.why === "" ? null : <span className="text-muted"> — {flag.why}</span>}
          </p>
        ))}
      </section>
      <StoredList
        title="Stored acknowledgements"
        rows={view.acks}
        empty="No stored acknowledgements."
        busy={busy}
        onRevoke={onRevoke}
      />
      {children}
    </>
  );
}

export function ExplainResult({ lines }: { readonly lines: ExplainLines }) {
  return (
    <dl className="permissions-explain text-sm" aria-label="Explain result">
      <dt>Outcome</dt>
      <dd>{lines.outcome}</dd>
      <dt>Why</dt>
      <dd>{lines.reason}</dd>
      {lines.classes === "" ? null : (
        <>
          <dt>Classes</dt>
          <dd>{lines.classes}</dd>
        </>
      )}
      {lines.resolver === "" ? null : (
        <>
          <dt>Resolver</dt>
          <dd>{lines.resolver}</dd>
        </>
      )}
      {lines.grant === "" ? null : (
        <>
          <dt>Grant</dt>
          <dd>{lines.grant}</dd>
        </>
      )}
      {lines.ack === "" ? null : (
        <>
          <dt>Acknowledgement</dt>
          <dd>{lines.ack}</dd>
        </>
      )}
    </dl>
  );
}

export const PermissionsPanel = observer(function PermissionsPanelView() {
  const dial = useDial();
  const root = dial.session?.root;
  const session = dial.sessionRpc;
  const kernel = dial.kernelRpc;
  const sessionId = root?.sessionId ?? null;
  const [data, setData] = useState<PermissionsData | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState("");
  const [lines, setLines] = useState<ExplainLines | null>(null);
  const mode = root?.permissionMode ?? root?.standingPermissionMode ?? dial.kernel?.root.defaultPermissionMode;

  const load = useCallback(async () => {
    setData(
      await loadPermissions({
        session: session == null ? null : (method, params) => session.request(method, params),
        kernel: kernel == null ? null : (method, params) => kernel.request(method, params),
        sessionId,
        projectPath: root?.path ?? null,
        mode,
        nowMs: Date.now(),
      }),
    );
  }, [session, kernel, sessionId, root?.path, mode]);
  useEffect(() => {
    void load();
  }, [load]);

  if (kernel == null) return <p className="text-sm text-subtle">The daemon is not connected.</p>;
  if (data == null) return <p className="text-sm text-subtle">Loading.</p>;
  return (
    <>
      {notice === "" ? null : (
        <p className="text-sm text-warning" role="status">
          {notice}
        </p>
      )}
      <PermissionsBody
        view={permissionsView(data)}
        busy={busy}
        onRevoke={(row) => {
          setBusy(true);
          setNotice("");
          void revokeRow((method, params) => kernel.request(method, params), row, sessionId)
            .then((ok) => (ok ? load() : setNotice("Not revoked.")))
            .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Not revoked."))
            .finally(() => setBusy(false));
        }}
      >
        <section aria-label="Explain">
          <h3 className="text-sm font-strong">What would happen?</h3>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (session == null) return;
              setNotice("");
              void explain((method, params) => session.request(method, params), probe, permissionsView(data).mode)
                .then(setLines)
                .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not explain."));
            }}
          >
            <Input
              aria-label="Command, path or mcp:server/tool"
              placeholder="git push, ~/.ssh/config, mcp:gmail/send_email"
              value={probe}
              onChange={(event) => setProbe(event.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={session == null || probe.trim() === ""}>
              Explain
            </Button>
          </form>
          {session == null ? <p className="text-sm text-subtle">Open a session to explain a call.</p> : null}
          {lines == null ? null : <ExplainResult lines={lines} />}
        </section>
      </PermissionsBody>
    </>
  );
});
